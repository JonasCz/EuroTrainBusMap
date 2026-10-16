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
  /** Position [lon, lat] of a station: enables the repair of impossible stop times (see repairTimes). */
  stationPos?: (station: number) => [number, number];
}

/** Zero-duration hops shorter than this (km) are plausible (same-platform, walking-distance stops). */
export const ZERO_HOP_KM = 3;
/** Fastest plausible average speed per category (km/h): a hop faster than this has invalid times. */
const MAX_KMH = { rail: 450, road: 160 };
/** Average speed (km/h) used where a run of invalid times has no valid time on one side. */
const FILL_KMH = { [Cat.LongDistance]: 100, [Cat.Regional]: 50, [Cat.Coach]: 65, [Cat.Bus]: 45 } as Record<number, number>;

const distKm = (a: [number, number], b: [number, number]): number => {
  const kx = 111.32 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110.54);
};

/**
 * Feeds sometimes list several stops of a trip with identical (or placeholder) times, e.g. a Milan–Paris–Lyon
 * train whose Paris and Lyon calls both read 12:00. Hops between stations that are more than ZERO_HOP_KM apart
 * but take no time (or would need a speed above any vehicle's) have invalid timing: the stops of such a run get
 * times interpolated by distance between the surrounding valid times, or – where one side has none (the run
 * touches the start or the end of the trip) – extrapolated at a typical speed of the category.
 * Mutates `arr` / `dep` (minutes, any common origin); returns the number of stops whose time was replaced.
 */
export function repairTimes(arr: number[], dep: number[], pos: [number, number][], cat: number): number {
  const n = arr.length;
  if (n < 2) return 0;
  const vmax = cat === Cat.Coach || cat === Cat.Bus ? MAX_KMH.road : MAX_KMH.rail;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1]! + distKm(pos[i - 1]!, pos[i]!));
  const bad = (i: number): boolean => {
    const d = cum[i]! - cum[i - 1]!;
    if (d <= ZERO_HOP_KM) return false;
    const dt = arr[i]! - dep[i - 1]!;
    return dt <= 0 || (d / dt) * 60 > vmax;
  };
  let fixed = 0;
  for (let i = 1; i < n; ) {
    if (!bad(i)) {
      i++;
      continue;
    }
    // the run of unreliable times: stops lo..hi; stop lo (reached by a plausible hop) keeps its time and so does
    // the first stop after the run. A zero-duration hop right behind the run belongs to it whatever its length.
    let j = i;
    while (j + 1 < n && (bad(j + 1) || arr[j + 1]! - dep[j]! <= 0)) j++;
    const lo = i - 1, hi = j, R = hi + 1;
    const v = FILL_KMH[cat] ?? 50;
    for (let k = lo + 1; k <= hi; k++) {
      const span = R < n ? cum[R]! - cum[lo]! : 0;
      const t = R < n && span > 0 ? dep[lo]! + ((arr[R]! - dep[lo]!) * (cum[k]! - cum[lo]!)) / span : dep[lo]! + ((cum[k]! - cum[lo]!) / v) * 60;
      arr[k] = dep[k] = Math.round(t);
      fixed++;
    }
    i = j + 1;
  }
  return fixed;
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
  if (o.stationPos && st.length >= 2) {
    const a = st.map((s) => s.arr), d = st.map((s) => s.dep);
    if (repairTimes(a, d, st.map((s) => o.stationPos!(s.station)), o.cat)) st.forEach((s, i) => ((s.arr = a[i]!), (s.dep = d[i]!)));
  }
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
