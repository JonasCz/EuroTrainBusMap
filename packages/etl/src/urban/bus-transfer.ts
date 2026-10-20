/**
 * Station changes by local bus (see packages/shared/src/transit.ts): per city and station pair, the worst-case
 * door-to-door minutes of a direct ride by local bus for every hour of the day, merged into the transit pairs.
 *
 * No bus timetable reaches the router. The local layer's extraction (extract.ts, PatternTimes) keeps per bus pattern
 * the ride minutes from its first stop to each stop (from a representative trip) and the departures at its first
 * stop on a Wednesday, a Saturday and a Sunday. The buses the intercity network carries itself (a span from the
 * feed's `minBusKm` on) are not local lines there, so no bus counts twice.
 *
 * For the candidate stations of every city (transit.ts: long-distance, regional rail, coach and bus stations, at most
 * MAX_STATIONS, the pairs within TRANSIT_MAX_M), a pattern calling at a stop within ACCESS_M of station A and later at
 * one within ACCESS_M of station B gives an option A → B: the walk to the stop (walkMinutes, as walk.ts), the wait for
 * the bus (its departures shifted by the ride to that stop), the ride, the walk to B. The stops are chosen per
 * pattern for the shortest walk + ride. The options of every pattern serving a pair form one step function "ready
 * at A at t → at B at EA(t)", so two lines (or two variants of a line) serving a pair combine their frequencies; a
 * line found in two feeds counts once (same departures and ride). Changes of bus are not considered: a direct ride
 * is what a visitor finds, and the rail-bound transit (transit.ts) covers the longer cross-city trips.
 *
 * Per day type (TRANSIT_DAYS: Monday–Friday from the Wednesday, Saturday, Sunday) and hour the worst case over its
 * minutes (EA(t) − t, the moment just after a bus is missed) is kept. A day type without buses on the pair (many
 * town lines do not run on Sundays) has no service; an hour whose worst case passes TRANSIT_MAX_MIN (the last bus
 * of the evening is gone) stores 0 as well: the router then waits for a later hour or walks.
 */
import { TRANSIT_BANDS, TRANSIT_DAYS, TRANSIT_HEAD, TRANSIT_MAX_M, TRANSIT_MAX_MIN, TRANSIT_VALUES, TransitMode, transitUseful, walkMinutes, type TransitPair } from "@etbm/shared";
import { fastDist } from "../util/geo.ts";
import { log as defaultLog } from "../util/log.ts";
import { gatherFeeds, type GatherOptions } from "./feeds.ts";
import { ACCESS_M, PointGrid, rankStations, transitCandidates } from "./transit.ts";
import { TIME_DAYS, UMode, type PatternTimes, type UrbanFeed } from "./types.ts";

/** Day types before / after each day type of PatternTimes.deps (Wed → Tue / Thu ≈ Wed, Sat → Fri ≈ Wed / Sun, Sun → Sat / Mon ≈ Wed). */
const PREV_DAY = [0, 0, 1];
const NEXT_DAY = [0, 2, 0];
const INF = 0x3fffffff;

/** One way of riding a bus line from station A to station B. */
export interface BusOption {
  /** departures at the line's first stop per day type */
  deps: number[][];
  /** minutes from the first stop to the boarding stop */
  board: number;
  /** walk from A to the boarding stop, minutes */
  access: number;
  /** ride plus the walk from the alighting stop to B, minutes */
  rest: number;
}

export interface BusStation {
  id: number;
  lon: number;
  lat: number;
  city: number;
}

/** Bus options per ordered pair of candidate stations, collected from the feeds one by one. */
export class BusCollector {
  private grid: PointGrid;
  private lon: Float64Array;
  private lat: Float64Array;
  /** key a * 2^20 + b (station ids) → options */
  readonly options = new Map<number, BusOption[]>();
  private seen = new Map<number, Set<string>>();
  patterns = 0;

  constructor(readonly stations: BusStation[]) {
    this.lon = Float64Array.from(stations, (s) => s.lon);
    this.lat = Float64Array.from(stations, (s) => s.lat);
    this.grid = new PointGrid(this.lon, this.lat, stations.length);
  }

  /** Add the bus patterns of a feed (only those with times). */
  addFeed(feed: Pick<UrbanFeed, "lines" | "stops">): void {
    for (const line of feed.lines) {
      if (line.mode !== UMode.Bus) continue;
      for (const p of line.patterns) if (p.times) this.addPattern(p.stops.map((s) => feed.stops[s]!), p.times);
    }
  }

  /** Add one bus pattern: its stops in travel order and its times. */
  addPattern(stops: { lon: number; lat: number }[], times: PatternTimes): void {
    if (times.t.length !== stops.length) return;
    // stations near each stop: [station index, walk minutes]
    const near: { st: number; min: number }[][] = stops.map((s) => this.grid.near(s.lon, s.lat, ACCESS_M).map(({ i, d }) => ({ st: i, min: walkMinutes(d) })));
    const touched = new Set<number>();
    for (const n of near) for (const x of n) touched.add(x.st);
    if (touched.size < 2) return;
    this.patterns++;
    // best boarding / alighting stops per ordered pair of this pattern (shortest walk + ride + walk)
    const best = new Map<number, { board: number; access: number; rest: number }>();
    const S = this.stations;
    for (let i = 0; i < stops.length; i++)
      for (const a of near[i]!)
        for (let j = i + 1; j < stops.length; j++) {
          const ride = times.t[j]! - times.t[i]!;
          if (ride < 0) break;
          for (const b of near[j]!) {
            if (a.st === b.st || S[a.st]!.city !== S[b.st]!.city) continue;
            const key = a.st * 1048576 + b.st;
            const total = a.min + ride + b.min;
            const o = best.get(key);
            if (!o || total < o.access + o.rest) best.set(key, { board: times.t[i]!, access: a.min, rest: ride + b.min });
          }
        }
    for (const [key, o] of best) {
      const a = Math.floor(key / 1048576), b = key % 1048576;
      if (fastDist(this.lon[a]!, this.lat[a]!, this.lon[b]!, this.lat[b]!) > TRANSIT_MAX_M) continue;
      // the same line from two feeds: same departures at the boarding stop and same ride
      const sig = `${o.access}|${o.rest}|${times.deps.map((d) => (d.length ? `${d.length}:${d[0]! + o.board}:${d[d.length - 1]! + o.board}:${d.reduce((s, x) => s + x, 0)}` : "")).join("|")}`;
      let seen = this.seen.get(key);
      if (!seen) this.seen.set(key, (seen = new Set()));
      if (seen.has(sig)) continue;
      seen.add(sig);
      let list = this.options.get(key);
      if (!list) this.options.set(key, (list = []));
      list.push({ deps: times.deps, ...o });
    }
  }
}

/**
 * Hourly worst-case minutes from A to B by the given bus options for one day type (`day`, PatternTimes.deps index):
 * TRANSIT_BANDS values, INF where no bus reaches B within the day and the next one.
 */
export function busDayBands(opts: BusOption[], day: number): Int32Array {
  // ready-at-A time and arrival-at-B time of every departure: the day's, the day before's running past midnight,
  // the next day's (the wait for the first bus)
  const ready: number[] = [], arr: number[] = [];
  for (const o of opts)
    for (const [d, shift] of [[PREV_DAY[day]!, -1440], [day, 0], [NEXT_DAY[day]!, 1440]] as const)
      for (const t of o.deps[d] ?? []) {
        const dep = t + shift + o.board;
        if (shift < 0 && dep < 0) continue;
        ready.push(dep - o.access);
        arr.push(dep + o.rest);
      }
  const n = ready.length;
  const ord = Array.from({ length: n }, (_, k) => k).sort((x, y) => ready[x]! - ready[y]!);
  const R = Int32Array.from(ord, (k) => ready[k]!);
  // suffix minimum: earliest arrival when ready no later than R[k]
  const E = Int32Array.from(ord, (k) => arr[k]!);
  for (let k = n - 2; k >= 0; k--) if (E[k + 1]! < E[k]!) E[k] = E[k + 1]!;
  const bands = new Int32Array(TRANSIT_BANDS);
  let p = 0;
  for (let h = 0; h < TRANSIT_BANDS; h++) {
    let worst = 0;
    for (let t = h * 60; t < h * 60 + 60; t++) {
      while (p < n && R[p]! < t) p++;
      if (p >= n) {
        worst = INF;
        break;
      }
      worst = Math.max(worst, E[p]! - t);
    }
    bands[h] = worst;
  }
  return bands;
}

/**
 * Hourly worst-case minutes from A to B per day type (see the file comment): TRANSIT_VALUES values, 0 = no service
 * within TRANSIT_MAX_MIN; null without any departure.
 */
export function busBands(opts: BusOption[]): Int32Array | null {
  if (!opts.some((o) => o.deps.some((d) => d.length))) return null;
  const out = new Int32Array(TRANSIT_VALUES);
  for (let d = 0; d < TIME_DAYS; d++) out.set(busDayBands(opts, d), d * TRANSIT_BANDS);
  for (let h = 0; h < TRANSIT_VALUES; h++) if (out[h]! > TRANSIT_MAX_MIN) out[h] = 0;
  return out;
}

/** Bus pair of a city: [stationA, stationB (a < b), TRANSIT_VALUES hourly minutes], the slower direction per hour. */
export type BusPair = number[];

/** Bus pairs per city from the collected options, for station pairs where the bus beats walking in some hour. */
export function busPairs(col: BusCollector): Map<number, BusPair[]> {
  const S = col.stations;
  const byCity = new Map<number, BusPair[]>();
  const done = new Set<number>();
  for (const [key, opts] of col.options) {
    const a = Math.floor(key / 1048576), b = key % 1048576;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (done.has(lo * 1048576 + hi)) continue;
    done.add(lo * 1048576 + hi);
    const back = col.options.get(b * 1048576 + a);
    if (!back) continue;
    const ab = busBands(opts), ba = busBands(back);
    if (!ab || !ba) continue;
    const bands = Array.from({ length: TRANSIT_VALUES }, (_, h) => (ab[h]! && ba[h]! ? Math.max(ab[h]!, ba[h]!) : 0));
    const walk = walkMinutes(fastDist(S[a]!.lon, S[a]!.lat, S[b]!.lon, S[b]!.lat));
    if (!transitUseful(bands, 0, walk)) continue;
    const [x, y] = S[lo]!.id < S[hi]!.id ? [S[lo]!.id, S[hi]!.id] : [S[hi]!.id, S[lo]!.id];
    let list = byCity.get(S[a]!.city);
    if (!list) byCity.set(S[a]!.city, (list = []));
    list.push([x, y, ...bands]);
  }
  return byCity;
}

/**
 * Merge a city's bus pairs into its rail-bound transit pairs: per day type and hour the faster of the two, bit h of the
 * day type's bus hours where that is the bus (TransitPair).
 */
export function mergeBusPairs(rail: TransitPair[] | undefined, bus: BusPair[] | undefined): TransitPair[] {
  const out = new Map<string, TransitPair>();
  for (const r of rail ?? []) out.set(`${r[0]},${r[1]}`, [...r]);
  for (const u of bus ?? []) {
    const k = `${u[0]},${u[1]}`;
    let t = out.get(k);
    if (!t) out.set(k, (t = [u[0]!, u[1]!, 0, ...new Array<number>(TRANSIT_DAYS + TRANSIT_VALUES).fill(0)]));
    for (let h = 0; h < TRANSIT_VALUES; h++) {
      const v = u[2 + h]!, cur = t[TRANSIT_HEAD + h]!;
      if (v > 0 && (cur === 0 || v < cur)) {
        t[TRANSIT_HEAD + h] = v;
        const d = Math.floor(h / TRANSIT_BANDS);
        t[3 + d] = t[3 + d]! | (1 << h % TRANSIT_BANDS);
      }
    }
    if (t.slice(3, TRANSIT_HEAD).some(Boolean)) t[2] = t[2]! | TransitMode.Bus;
  }
  return [...out.values()].sort((x, y) => x[0]! - y[0]! || x[1]! - y[1]!);
}

/**
 * Bus pairs of every city with at least two candidate stations (transit.ts), from the local layer's extraction of
 * every feed (gatherFeeds: cached per feed, extracted when missing). Returns city id → pairs (station ids as given).
 */
export async function computeBusTransfers(
  gather: GatherOptions,
  cities: { id: number; name: string; stations: number[] }[],
  stations: { lon: number; lat: number; cats: number; tpd?: number }[],
  log: (m: string) => void = defaultLog,
): Promise<{ byCity: Map<number, BusPair[]>; stats: Record<string, number> }> {
  const t0 = Date.now();
  const cand: BusStation[] = [];
  for (const c of transitCandidates(cities, stations)) for (const s of rankStations(c.stations)) cand.push({ id: s.id, lon: s.lon, lat: s.lat, city: c.city });
  const col = new BusCollector(cand);
  const g = await gatherFeeds(gather, (feed) => col.addFeed(feed));
  const t1 = Date.now();
  const byCity = busPairs(col);
  let nPairs = 0;
  for (const p of byCity.values()) nPairs += p.length;
  const secs = Math.round((Date.now() - t0) / 1000);
  log(
    `bus transfers: ${nPairs} station pairs in ${byCity.size} cities from ${col.patterns} bus patterns near ${cand.length} stations ` +
      `(${g.feeds.length} feeds read in ${Math.round((t1 - t0) / 1000)} s, pairs in ${((Date.now() - t1) / 1000).toFixed(1)} s)`,
  );
  return { byCity, stats: { busTransferCities: byCity.size, busTransferPairs: nPairs, busTransferPatterns: col.patterns, busTransferSeconds: secs } };
}
