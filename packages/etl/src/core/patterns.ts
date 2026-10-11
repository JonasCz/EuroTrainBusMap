import { Cat } from "@etbm/shared";

export interface RawStop {
  station: number;
  city: number;
  arr: number;
  dep: number;
}

export interface TripShape {
  stations: number[];
  cities: number[];
  arr: number[]; // offsets from start
  dep: number[];
  start: number;
}

export interface ProcessOptions {
  cat: number;
  /** Population of a city (synthetic cities: 0). */
  cityPop: (city: number) => number;
  /** Service weight of a station (to pick the main stop in a town). */
  stationWeight: (station: number) => number;
  /** Bus: drop stops in places below this population (except first/last). */
  minBusCityPop?: number;
  /** Bus: collapse consecutive stops in towns below this population to one stop. */
  collapseBusBelowPop?: number;
  /** Bus: whether a city has rail stations (bus runs there keep entry/exit stops only). */
  cityHasRail?: (city: number) => boolean;
}

/**
 * Turn a trip's raw stop sequence into the station sequence used in patterns:
 *  - (Bus) drop stops in places below ~1000 inhabitants,
 *  - (Bus) collapse runs of stops in the same small town to its main stop; in big
 *    cities and towns with rail keep only the entry/exit stops of the run,
 *  - collapse consecutive stops at the same station (arr of first, dep of last),
 *  - require ≥ 2 distinct cities.
 * Returns null if the trip should be dropped.
 */
export function processTripStops(raw: RawStop[], o: ProcessOptions): TripShape | null {
  if (raw.length < 2) return null;
  let stops = raw;
  if (o.cat === Cat.Bus) {
    // Buses only serve real towns on the map: stops in places below minPop (incl. synthetic
    // places without population) are dropped, termini included.
    const minPop = o.minBusCityPop ?? 1000;
    stops = stops.filter((s) => o.cityPop(s.city) >= minPop);
    const collapseBelow = o.collapseBusBelowPop ?? 100_000;
    const out: RawStop[] = [];
    for (let i = 0; i < stops.length; ) {
      let j = i;
      while (j + 1 < stops.length && stops[j + 1]!.city === stops[i]!.city) j++;
      const c = stops[i]!.city;
      if (j > i && o.cityPop(c) < collapseBelow && !o.cityHasRail?.(c)) {
        // keep the most important station of the run, spanning first arr → last dep
        let best = i;
        for (let k = i; k <= j; k++) if (o.stationWeight(stops[k]!.station) > o.stationWeight(stops[best]!.station)) best = k;
        out.push({ station: stops[best]!.station, city: stops[i]!.city, arr: stops[i]!.arr, dep: stops[j]!.dep });
      } else {
        // big city / city with rail: keep where the bus enters and leaves the city
        out.push(stops[i]!);
        if (j > i) out.push(stops[j]!);
      }
      i = j + 1;
    }
    stops = out;
  }
  // collapse same station
  const st: RawStop[] = [];
  for (const s of stops) {
    const prev = st[st.length - 1];
    if (prev && prev.station === s.station) prev.dep = Math.max(prev.dep, s.dep);
    else st.push({ ...s });
  }
  if (st.length < 2) return null;
  const distinct = new Set(st.map((s) => s.city));
  if (distinct.size < 2) return null;
  // monotonic times (repair small inversions)
  const start = st[0]!.dep;
  const arr: number[] = [], dep: number[] = [];
  let t = start;
  for (let i = 0; i < st.length; i++) {
    const a = Math.max(t, i === 0 ? st[i]!.dep : st[i]!.arr);
    const d = Math.max(a, st[i]!.dep);
    arr.push(a - start);
    dep.push(d - start);
    t = d;
  }
  arr[0] = 0;
  return { stations: st.map((s) => s.station), cities: st.map((s) => s.city), arr, dep, start };
}

/** 53-bit-ish string hash (FNV-1a variant on two 32-bit lanes). */
export function hashKey(s: string): number {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return (h1 >>> 0) * 2097152 + ((h2 >>> 0) & 0x1fffff);
}

export interface PatternRec {
  route: number;
  stations: number[];
  cities: number[];
  arr: number[];
  dep: number[];
  headsign: string;
  tz: number;
  shapeTrip: number; // trip_key with a shape (or -1)
}

/** Dedups patterns by (route, stations, offsets, headsign, tz). */
export class PatternStore {
  readonly patterns: PatternRec[] = [];
  private index = new Map<number, number[]>();
  add(p: PatternRec): number {
    const k = `${p.route}|${p.tz}|${p.headsign}|${p.stations.join(",")}|${p.arr.join(",")}|${p.dep.join(",")}`;
    const h = hashKey(k);
    const cands = this.index.get(h);
    if (cands) {
      for (const i of cands) {
        const q = this.patterns[i]!;
        if (
          q.route === p.route && q.tz === p.tz && q.headsign === p.headsign && eq(q.stations, p.stations) && eq(q.arr, p.arr) && eq(q.dep, p.dep)
        ) {
          if (q.shapeTrip < 0 && p.shapeTrip >= 0) q.shapeTrip = p.shapeTrip;
          return i;
        }
      }
    }
    const id = this.patterns.length;
    this.patterns.push(p);
    if (cands) cands.push(id);
    else this.index.set(h, [id]);
    return id;
  }
}

function eq(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Convert a UTC-based start time to local time for each running day.
 * Returns groups of { start, dayShift, days[] } (days = indices with the same offset).
 */
export function localizeStart(startUtc: number, dayIdx: number[], offsetOf: (day: number) => number): { start: number; shift: number; days: number[] }[] {
  const groups = new Map<number, number[]>();
  for (const d of dayIdx) {
    const off = offsetOf(d);
    let g = groups.get(off);
    if (!g) groups.set(off, (g = []));
    g.push(d);
  }
  const out: { start: number; shift: number; days: number[] }[] = [];
  for (const [off, days] of groups) {
    let s = startUtc + off, shift = 0;
    while (s >= 1440) {
      s -= 1440;
      shift++;
    }
    while (s < 0) {
      s += 1440;
      shift--;
    }
    out.push({ start: s, shift, days });
  }
  return out;
}
