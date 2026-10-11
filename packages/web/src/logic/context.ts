import type { CityFile, NetworkFile, Pattern } from "@etbm/shared";
import type { CalIndex } from "./calendar.ts";

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
  /** segments per pattern; corridor k of a pattern joins segment k and k+1 */
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

/** Pick the stop in a segment whose station ranks best (main station first). */
export function bestStop(p: Pattern, seg: Segment, ctx: NetCtx): number {
  let best = seg.first;
  for (let i = seg.first + 1; i <= seg.last; i++) {
    if (ctx.stationRank[p.stations[i]!]! < ctx.stationRank[p.stations[best]!]!) best = i;
  }
  return best;
}
