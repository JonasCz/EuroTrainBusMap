import type { CityFile, NetworkFile, Pattern } from "@etbm/shared";
import { serviceDayCount, type CalIndex } from "./calendar.ts";

/** Network-wide lookups needed by the pure timetable logic. */
export interface NetCtx {
  /** station id → city id */
  stationCity: ArrayLike<number>;
  /** station id → rank inside its city (0 = main station) */
  stationRank: ArrayLike<number>;
  /** city id → IANA tz name */
  cityTz: string[];
  timezones: string[];
  cal: CalIndex;
}

export function buildNetCtx(net: Pick<NetworkFile, "cities" | "timezones">, cal: CalIndex): NetCtx {
  let n = 0;
  for (const c of net.cities) for (const s of c.stations) n = Math.max(n, s + 1);
  const stationCity = new Int32Array(n);
  const stationRank = new Int32Array(n);
  for (const c of net.cities)
    c.stations.forEach((s, i) => {
      stationCity[s] = c.id;
      stationRank[s] = i;
    });
  return {
    stationCity,
    stationRank,
    cityTz: net.cities.map((c) => net.timezones[c.tz] ?? "UTC"),
    timezones: net.timezones,
    cal,
  };
}

/** A maximal run of consecutive stops in the same city. */
export interface Segment {
  city: number;
  /** first / last stop index (inclusive) */
  first: number;
  last: number;
}

export interface PreparedCity {
  cf: CityFile;
  /** city runs per pattern (consecutive stops in one city); pattern.corridors[i] joins stop i and i+1 */
  segments: Segment[][];
  /** trip indices per pattern */
  tripsByPattern: number[][];
  /** tz name per pattern */
  tz: string[];
}

const cache = new WeakMap<CityFile, PreparedCity>();

export function segmentsOf(p: Pattern, stationCity: ArrayLike<number>): Segment[] {
  const out: Segment[] = [];
  p.stations.forEach((s, i) => {
    const c = stationCity[s]!;
    const last = out[out.length - 1];
    if (last && last.city === c) last.last = i;
    else out.push({ city: c, first: i, last: i });
  });
  return out;
}

export function prepare(cf: CityFile, ctx: NetCtx): PreparedCity {
  let p = cache.get(cf);
  if (p) return p;
  const tripsByPattern: number[][] = cf.patterns.map(() => []);
  cf.trips.forEach((t, i) => tripsByPattern[t[0]]?.push(i));
  p = {
    cf,
    segments: cf.patterns.map((pat) => segmentsOf(pat, ctx.stationCity)),
    tripsByPattern,
    tz: cf.patternTz.map((t) => ctx.timezones[t] ?? "UTC"),
  };
  cache.set(cf, p);
  return p;
}

/**
 * Trips per day of a pattern over the calendar horizon (all its trips' service days / horizon days),
 * the same measure as the ETL's corridor `tpd`, but for this one pattern.
 */
export function patternTpd(cf: CityFile, ctx: NetCtx, pattern: number): number {
  const prep = prepare(cf, ctx);
  let days = 0;
  for (const ti of prep.tripsByPattern[pattern] ?? []) days += serviceDayCount(ctx.cal, cf.trips[ti]![2]);
  return ctx.cal.days > 0 ? days / ctx.cal.days : 0;
}

/** corridor id → Cat bit → trips per day of the selected services on it. */
export type CorridorTraffic = Map<number, Partial<Record<number, number>>>;

/** Add `tpd` trips/day of category `cat` to every corridor in `corridors` (each once; −1 = no corridor). */
export function addTraffic(t: CorridorTraffic, corridors: Iterable<number>, cat: number, tpd: number): void {
  for (const c of new Set(corridors)) {
    if (c < 0) continue;
    const r = t.get(c) ?? {};
    r[cat] = (r[cat] ?? 0) + tpd;
    t.set(c, r);
  }
}

/** corridor id → union of the Cat bits on it. */
export function trafficCats(t: CorridorTraffic): Map<number, number> {
  const out = new Map<number, number>();
  for (const [c, r] of t) {
    let cats = 0;
    for (const k of Object.keys(r)) cats |= +k;
    out.set(c, cats);
  }
  return out;
}

/** Index of the stop of pattern `p` at `station` inside a city segment, or −1. */
export function stopAt(p: Pattern, seg: Segment, station: number): number {
  for (let i = seg.first; i <= seg.last; i++) if (p.stations[i] === station) return i;
  return -1;
}

/** Pick the stop in a segment whose station ranks best (main station first). */
export function bestStop(p: Pattern, seg: Segment, ctx: NetCtx): number {
  let best = seg.first;
  for (let i = seg.first + 1; i <= seg.last; i++) {
    if (ctx.stationRank[p.stations[i]!]! < ctx.stationRank[p.stations[best]!]!) best = i;
  }
  return best;
}
