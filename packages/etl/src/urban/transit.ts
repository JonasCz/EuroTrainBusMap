/**
 * Transit transfer profiles (see packages/shared/src/transit.ts): per city and station pair, the worst-case
 * door-to-door minutes by metro / tram / suburban rail for every hour of the day, from a profile connection scan
 * over the reference week's local timetables (transit-extract.ts).
 *
 * Per city: the stations where journeys change (long-distance, regional rail or coach), at most MAX_STATIONS of
 * them (long-distance stations first, then regional rail, then coach stations, each by departures); the local stops within ACCESS_M of a station are reached on foot (walkMinutes: detour,
 * 4.5 km/h, 3 min buffer), stops within FOOT_M of each other are a change (the walk plus CHANGE_MIN), a change
 * at the same stop takes CHANGE_MIN. For each target station a backward profile scan (CSA) over the connections
 * of three days (a Wednesday, a Saturday and a Sunday, each with the trips of the day before running past midnight
 * and of the next day for the wait for the first train) gives at every stop the earliest arrival at the target
 * for every departure; for each source station and hour the worst case over the minutes of the hour (the moment
 * just after a departure is missed) is kept, and the largest over the three days. City buses are not used: their
 * timetables are much bigger, they are slower than the rail lines where those exist, and a change by bus is
 * harder to find for a visitor.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { Cat, TRANSIT_BANDS, TRANSIT_MAX_M, TRANSIT_MAX_MIN, transitUseful, walkMinutes, type TransitPair } from "@etbm/shared";
import { Db } from "../db.ts";
import { downloadWithFallback } from "../download.ts";
import { STALE_MAX_DAYS, zipState } from "../gtfs/validity.ts";
import { resolveFeeds, type FeedDef, type FeedsConfig, type ResolvedFeed } from "../feeds.ts";
import { loadPlaces } from "../geonames.ts";
import { fastDist } from "../util/geo.ts";
import { log as defaultLog, warn } from "../util/log.ts";
import { cityDiscs, DiscIndex } from "./classify.ts";
import { TRANSIT_EXTRACT_VERSION, WEEK_DAYS, extractTransitFeed, type TransitFeed } from "./transit-extract.ts";

/** Local stops this close to a station are reached on foot (metres). */
export const ACCESS_M = 600;
/** Stops this close to each other are a change on foot (metres). */
export const FOOT_M = 400;
/** A change between lines at the same stop, minutes (on top of the walk between stops). */
export const CHANGE_MIN = 3;
/** Most stations per city with transit times (by departures): the ones where long journeys change. */
export const MAX_STATIONS = 40;
/** Cities from this population on have local transport worth computing (the discs of classify.ts). */
export const TRANSIT_CITY_MIN_POP = 100_000;
/** Connections up to this long after the end of the day are scanned (the wait for the first train), minutes. */
const HORIZON = TRANSIT_MAX_MIN + 60;
/** Day types of the reference week (Monday = 0): Wednesday, Saturday, Sunday. */
const DAY_TYPES = [2, 5, 6];
/** Day types with fewer connections than this share of the busiest one are taken for missing data and skipped. */
const MIN_DAY_SHARE = 0.25;
/** Bbox margin around a city's stations for the local network, degrees of latitude (≈ 4 km). */
const MARGIN = 0.036;

const INF = 0x3fffffff;

export interface TransitStation {
  id: number;
  lon: number;
  lat: number;
}

/** One city's local network for the scan: stops, footpaths and the connections of each day type. */
interface CityNet {
  nStops: number;
  lon: Float64Array;
  lat: Float64Array;
  /** footpaths from each stop (itself included): CSR offsets, target stop, minutes */
  fStart: Int32Array;
  fTo: Int32Array;
  fMin: Int32Array;
  /** per day type: connections sorted by departure, descending */
  days: { dep: Int32Array; arr: Int32Array; from: Int32Array; to: Int32Array; trip: Int32Array; mode: Uint8Array; nTrips: number }[];
}

/** Grid lookup of points by ~1 km cells. */
class PointGrid {
  private cells = new Map<number, number[]>();
  constructor(
    private lon: ArrayLike<number>,
    private lat: ArrayLike<number>,
    n: number,
  ) {
    for (let i = 0; i < n; i++) {
      const k = this.key(Math.floor(lon[i]! * 100), Math.floor(lat[i]! * 100));
      let a = this.cells.get(k);
      if (!a) this.cells.set(k, (a = []));
      a.push(i);
    }
  }
  private key(x: number, y: number): number {
    return (x + 20000) * 40000 + (y + 20000);
  }
  /** Points within `r` metres (r ≤ ~1 km). */
  near(lon: number, lat: number, r: number): { i: number; d: number }[] {
    const out: { i: number; d: number }[] = [];
    const x = Math.floor(lon * 100), y = Math.floor(lat * 100);
    const dx = Math.ceil(r / (1110 * Math.cos((lat * Math.PI) / 180))), dy = Math.ceil(r / 1110);
    for (let i = x - dx; i <= x + dx; i++)
      for (let j = y - dy; j <= y + dy; j++) {
        const a = this.cells.get(this.key(i, j));
        if (!a) continue;
        for (const p of a) {
          const d = fastDist(lon, lat, this.lon[p]!, this.lat[p]!);
          if (d <= r) out.push({ i: p, d });
        }
      }
    return out;
  }
}

/** Global index of the extracted patterns by bounding box (0.25° cells), to pick a city's local network quickly. */
export class TransitIndex {
  private items: { f: TransitFeed; p: number; x0: number; x1: number; y0: number; y1: number }[] = [];
  private cells = new Map<number, number[]>();
  constructor(readonly feeds: TransitFeed[]) {
    for (const f of feeds)
      f.patterns.forEach((pt, p) => {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const s of pt.stops) {
          const [x, y] = f.stops[s]!;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        const id = this.items.length;
        this.items.push({ f, p, x0, x1, y0, y1 });
        for (let i = Math.floor(x0 * 4); i <= Math.floor(x1 * 4); i++)
          for (let j = Math.floor(y0 * 4); j <= Math.floor(y1 * 4); j++) {
            const k = i * 4096 + j;
            let a = this.cells.get(k);
            if (!a) this.cells.set(k, (a = []));
            a.push(id);
          }
      });
  }
  /** Patterns intersecting a bbox. */
  within(x0: number, y0: number, x1: number, y1: number): { f: TransitFeed; p: number }[] {
    const seen = new Set<number>();
    const out: { f: TransitFeed; p: number }[] = [];
    for (let i = Math.floor(x0 * 4); i <= Math.floor(x1 * 4); i++)
      for (let j = Math.floor(y0 * 4); j <= Math.floor(y1 * 4); j++)
        for (const id of this.cells.get(i * 4096 + j) ?? []) {
          if (seen.has(id)) continue;
          seen.add(id);
          const it = this.items[id]!;
          if (it.x1 >= x0 && it.x0 <= x1 && it.y1 >= y0 && it.y0 <= y1) out.push({ f: it.f, p: it.p });
        }
    return out;
  }
}

/** Build the local network of the area around a city's stations. */
function cityNet(idx: TransitIndex, stations: TransitStation[]): CityNet | null {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const s of stations) {
    x0 = Math.min(x0, s.lon); x1 = Math.max(x1, s.lon); y0 = Math.min(y0, s.lat); y1 = Math.max(y1, s.lat);
  }
  const mx = MARGIN / Math.cos((((y0 + y1) / 2) * Math.PI) / 180);
  x0 -= mx; x1 += mx; y0 -= MARGIN; y1 += MARGIN;
  const pats = idx.within(x0, y0, x1, y1);
  if (!pats.length) return null;
  const inBox = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  // stops (merged across feeds by position)
  const stopKey = new Map<string, number>();
  const lon: number[] = [], lat: number[] = [];
  const local = new Map<TransitFeed, Int32Array>();
  const stopOf = (f: TransitFeed, s: number) => {
    let m = local.get(f);
    if (!m) local.set(f, (m = new Int32Array(f.stops.length).fill(-1)));
    if (m[s]! >= 0) return m[s]!;
    const [x, y] = f.stops[s]!;
    const k = `${x},${y}`;
    let i = stopKey.get(k);
    if (i === undefined) {
      stopKey.set(k, (i = lon.length));
      lon.push(x);
      lat.push(y);
    }
    m[s] = i;
    return i;
  };
  const days: CityNet["days"] = [];
  for (const day of DAY_TYPES) {
    const dep: number[] = [], arr: number[] = [], from: number[] = [], to: number[] = [], trip: number[] = [], mode: number[] = [];
    let nTrips = 0;
    for (const { f, p } of pats) {
      const pt = f.patterns[p]!;
      const n = pt.stops.length;
      const ins = pt.stops.map((s) => inBox(f.stops[s]![0], f.stops[s]![1]));
      const ls = pt.stops.map((s, i) => (ins[i] ? stopOf(f, s) : -1));
      for (let t = 0; t < pt.trips.length; t += 2) {
        const start = pt.trips[t]!, mask = pt.trips[t + 1]!;
        // service day before (its trips running past midnight), the day itself, the day after (first trains)
        for (const sd of [-1, 0, 1]) {
          const b = day + sd;
          if (b < 0 || b >= WEEK_DAYS || !(mask & (1 << b))) continue;
          const base = start + sd * 1440;
          if (base + pt.arr[n - 1]! < 0 || base > 1440 + HORIZON) continue;
          const id = nTrips++;
          for (let i = 0; i + 1 < n; i++) {
            if (ls[i]! < 0 || ls[i + 1]! < 0) continue;
            const d = base + pt.dep[i]!;
            if (d < 0 || d > 1440 + HORIZON) continue;
            dep.push(d); arr.push(base + pt.arr[i + 1]!); from.push(ls[i]!); to.push(ls[i + 1]!); trip.push(id); mode.push(pt.mode);
          }
        }
      }
    }
    const order = Array.from(dep.keys()).sort((a, b) => dep[b]! - dep[a]! || arr[b]! - arr[a]!);
    days.push({
      dep: Int32Array.from(order, (i) => dep[i]!),
      arr: Int32Array.from(order, (i) => arr[i]!),
      from: Int32Array.from(order, (i) => from[i]!),
      to: Int32Array.from(order, (i) => to[i]!),
      trip: Int32Array.from(order, (i) => trip[i]!),
      mode: Uint8Array.from(order, (i) => mode[i]!),
      nTrips,
    });
  }
  const nStops = lon.length;
  if (!nStops) return null;
  const LON = Float64Array.from(lon), LAT = Float64Array.from(lat);
  const grid = new PointGrid(LON, LAT, nStops);
  const fStart = new Int32Array(nStops + 1);
  const fTo: number[] = [], fMin: number[] = [];
  for (let s = 0; s < nStops; s++) {
    for (const { i, d } of grid.near(LON[s]!, LAT[s]!, FOOT_M)) {
      fTo.push(i);
      fMin.push(i === s ? CHANGE_MIN : Math.ceil((d * 1.3) / 75) + CHANGE_MIN);
    }
    fStart[s + 1] = fTo.length;
  }
  return { nStops, lon: LON, lat: LAT, fStart, fTo: Int32Array.from(fTo), fMin: Int32Array.from(fMin), days };
}

/** Per-stop Pareto profiles (departure descending, arrival descending), reused across scans. */
class Profiles {
  dep: number[][];
  arr: number[][];
  mode: number[][];
  constructor(n: number) {
    this.dep = Array.from({ length: n }, () => []);
    this.arr = Array.from({ length: n }, () => []);
    this.mode = Array.from({ length: n }, () => []);
  }
  reset(): void {
    for (let i = 0; i < this.dep.length; i++) {
      this.dep[i]!.length = 0;
      this.arr[i]!.length = 0;
      this.mode[i]!.length = 0;
    }
  }
  /** Index of the entry with the latest arrival among departures ≥ t that arrives earliest, or −1. */
  find(s: number, t: number): number {
    const d = this.dep[s]!;
    if (!d.length || d[0]! < t) return -1;
    // last index with dep ≥ t (deps descending)
    let lo = 0, hi = d.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (d[mid]! >= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  add(s: number, dep: number, arr: number, mode: number): void {
    const d = this.dep[s]!, a = this.arr[s]!, m = this.mode[s]!;
    const n = d.length;
    if (n && arr >= a[n - 1]!) return;
    if (n && d[n - 1] === dep) {
      a[n - 1] = arr;
      m[n - 1] = mode;
    } else {
      d.push(dep);
      a.push(arr);
      m.push(mode);
    }
  }
}

/**
 * Hourly worst-case transit minutes from each of `sources` to `target` for one day type: per source an array of
 * TRANSIT_BANDS values (INF = none) and the modes of the midday journeys.
 */
function scanTarget(
  net: CityNet,
  day: CityNet["days"][number],
  prof: Profiles,
  tripArr: Int32Array,
  tripMode: Uint8Array,
  egress: { stop: number; min: number }[],
  sources: { access: { stop: number; min: number }[] }[],
): { bands: Int32Array; modes: number }[] {
  prof.reset();
  tripArr.fill(INF, 0, day.nTrips);
  const eg = new Map<number, number>();
  for (const e of egress) eg.set(e.stop, Math.min(eg.get(e.stop) ?? INF, e.min));
  const { dep, arr, from, to, trip, mode } = day;
  const { fStart, fTo, fMin } = net;
  for (let c = 0; c < dep.length; c++) {
    const v = to[c]!, a = arr[c]!, tr = trip[c]!;
    let tau = INF, tm = 0;
    const e = eg.get(v);
    if (e !== undefined) {
      tau = a + e;
      tm = mode[c]!;
    }
    if (tripArr[tr]! < tau) {
      tau = tripArr[tr]!;
      tm = tripMode[tr]!;
    }
    for (let k = fStart[v]!; k < fStart[v + 1]!; k++) {
      const w = fTo[k]!;
      const i = prof.find(w, a + fMin[k]!);
      if (i >= 0 && prof.arr[w]![i]! < tau) {
        tau = prof.arr[w]![i]!;
        tm = prof.mode[w]![i]! | mode[c]!;
      }
    }
    if (tau >= INF) continue;
    if (tau < tripArr[tr]!) {
      tripArr[tr] = tau;
      tripMode[tr] = tm;
    }
    prof.add(from[c]!, dep[c]!, tau, tm);
  }
  // per source: ready-at-station step function, worst case per hour
  return sources.map(({ access }) => {
    const ent: number[] = [];
    for (const { stop, min } of access) {
      const d = prof.dep[stop]!, a = prof.arr[stop]!;
      for (let i = 0; i < d.length; i++) ent.push(i, stop, d[i]! - min);
    }
    // entries by ready time ascending
    const n = ent.length / 3;
    const ord = Array.from({ length: n }, (_, k) => k).sort((x, y) => ent[3 * x + 2]! - ent[3 * y + 2]!);
    const ready = new Int32Array(n), best = new Int32Array(n), bm = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const x = ord[k]!;
      ready[k] = ent[3 * x + 2]!;
      best[k] = prof.arr[ent[3 * x + 1]!]![ent[3 * x]!]!;
      bm[k] = prof.mode[ent[3 * x + 1]!]![ent[3 * x]!]!;
    }
    // suffix minimum: earliest arrival when ready at ready[k] or before
    for (let k = n - 2; k >= 0; k--)
      if (best[k + 1]! <= best[k]!) {
        best[k] = best[k + 1]!;
        bm[k] = bm[k + 1]!;
      }
    const bands = new Int32Array(TRANSIT_BANDS).fill(INF);
    let modes = 0;
    let p = 0;
    // EA(t) = best[first k with ready[k] ≥ t]; worst over the hour at its start and just after each departure
    const ea = (t: number) => {
      while (p < n && ready[p]! < t) p++;
      return p < n ? best[p]! : INF;
    };
    for (let h = 0; h < TRANSIT_BANDS; h++) {
      const t0 = h * 60, t1 = t0 + 60;
      let worst = 0;
      const startEa = ea(t0);
      if (startEa >= INF) continue;
      worst = startEa - t0;
      if (h === 12 || !modes) modes = bm[p]!;
      // candidates: one minute after every ready time in the hour
      let q = p;
      let none = false;
      while (q < n && ready[q]! < t1 - 1) {
        const t = ready[q]! + 1;
        let r = q;
        while (r < n && ready[r]! < t) r++;
        if (r >= n) {
          none = true;
          break;
        }
        worst = Math.max(worst, best[r]! - t);
        q = r;
      }
      bands[h] = none ? INF : worst;
    }
    return { bands, modes };
  });
}

export interface CityTransitIn {
  city: number;
  /** candidate stations (long-distance / regional rail / coach), with their Cat bits and departures per day */
  stations: (TransitStation & { cats: number; tpd: number })[];
}

/**
 * Transit pairs of one city: [a, b, modes, 24 × minutes] for station pairs within TRANSIT_MAX_M where transit beats
 * walking in some hour (station ids as given; a < b; the slower direction).
 */
export function cityTransit(idx: TransitIndex, c: CityTransitIn): { pairs: TransitPair[]; stops: number; conns: number } {
  // long-distance stations first, then regional rail, then coach stations, each by departures
  const rank = (s: { cats: number }) => (s.cats & Cat.LongDistance ? 0 : s.cats & Cat.Regional ? 1 : 2);
  const st = [...c.stations].sort((a, b) => rank(a) - rank(b) || b.tpd - a.tpd || a.id - b.id).slice(0, MAX_STATIONS);
  if (st.length < 2) return { pairs: [], stops: 0, conns: 0 };
  const net = cityNet(idx, st);
  if (!net) return { pairs: [], stops: 0, conns: 0 };
  const grid = new PointGrid(net.lon, net.lat, net.nStops);
  const near = st.map((s) => grid.near(s.lon, s.lat, ACCESS_M).map(({ i, d }) => ({ stop: i, min: walkMinutes(d) })));
  // pairs in range (both directions)
  const partners = st.map(() => [] as number[]);
  for (let i = 0; i < st.length; i++)
    for (let j = 0; j < st.length; j++) {
      if (i === j || !near[i]!.length || !near[j]!.length) continue;
      if (fastDist(st[i]!.lon, st[i]!.lat, st[j]!.lon, st[j]!.lat) <= TRANSIT_MAX_M) partners[j]!.push(i);
    }
  const busiest = Math.max(...net.days.map((d) => d.dep.length));
  const prof = new Profiles(net.nStops);
  const maxTrips = Math.max(...net.days.map((d) => d.nTrips));
  const tripArr = new Int32Array(maxTrips), tripMode = new Uint8Array(maxTrips);
  // worst[i][j]: hourly worst case from i to j over the day types
  const worst = new Map<number, { bands: Int32Array; modes: number }>();
  for (let j = 0; j < st.length; j++) {
    const srcs = partners[j]!;
    if (!srcs.length) continue;
    for (const day of net.days) {
      // a day with hardly any service in the data (a feed ending early) says nothing about that day
      if (day.dep.length < MIN_DAY_SHARE * busiest) continue;
      const res = scanTarget(net, day, prof, tripArr, tripMode, near[j]!, srcs.map((i) => ({ access: near[i]! })));
      srcs.forEach((i, k) => {
        const key = i * 1024 + j;
        const r = res[k]!;
        const w = worst.get(key);
        if (!w) worst.set(key, { bands: r.bands.slice(), modes: r.modes });
        else {
          for (let h = 0; h < TRANSIT_BANDS; h++) w.bands[h] = Math.max(w.bands[h]!, r.bands[h]!);
          w.modes |= r.modes;
        }
      });
    }
  }
  const pairs: TransitPair[] = [];
  for (let i = 0; i < st.length; i++)
    for (let j = i + 1; j < st.length; j++) {
      const ab = worst.get(i * 1024 + j), ba = worst.get(j * 1024 + i);
      if (!ab || !ba) continue;
      const bands = Array.from({ length: TRANSIT_BANDS }, (_, h) => {
        const v = Math.max(ab.bands[h]!, ba.bands[h]!);
        return v >= INF || v > TRANSIT_MAX_MIN ? 0 : v;
      });
      const d = fastDist(st[i]!.lon, st[i]!.lat, st[j]!.lon, st[j]!.lat);
      if (!transitUseful(bands, 0, walkMinutes(d))) continue;
      const [a, b] = st[i]!.id < st[j]!.id ? [st[i]!.id, st[j]!.id] : [st[j]!.id, st[i]!.id];
      pairs.push([a, b, ab.modes | ba.modes, ...bands]);
    }
  return { pairs, stops: net.nStops, conns: net.days.reduce((s, d) => s + d.dep.length, 0) };
}

/** Stations of a city that get transit times: long-distance, regional rail and coach stations. */
export const TRANSIT_STATION_CATS = Cat.LongDistance | Cat.Regional | Cat.Coach;

/**
 * Monday of the reference week: the first Monday after the start of the timetable window (yesterday when the
 * build runs), the week local feeds published for the next couple of weeks only still cover completely.
 */
export function transitMonday(startDate: string): string {
  const d = new Date(startDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export interface GatherTransitOptions {
  cfg: FeedsConfig;
  urbanFeeds: FeedDef[];
  workDir: string;
  assetsDir: string;
  startDate: string;
  download: boolean;
  /** Cap on stale feeds (gtfs/validity.ts; default STALE_MAX_DAYS). */
  staleMaxDays?: number;
  log?: (m: string) => void;
}

/**
 * Extract the transit timetables of every feed (intercity feeds of feeds.json from the cache, the local feeds of
 * urban-feeds.json downloaded if missing), cached per feed in work/urban/transit/ by zip size, version and week.
 */
export async function gatherTransitFeeds(o: GatherTransitOptions): Promise<TransitFeed[]> {
  const log = o.log ?? defaultLog;
  const cacheDir = join(o.workDir, "cache");
  const outDir = join(o.workDir, "urban", "transit");
  await mkdir(outDir, { recursive: true });
  const tmpDir = join(o.workDir, "tmp");
  await mkdir(tmpDir, { recursive: true });
  const base = (await resolveFeeds(o.cfg, { tiers: ["core", "bus"], cacheDir })).filter((f) => f.def.keep.some((k) => k !== "coach"));
  const extra = await resolveFeeds({ ...o.cfg, feeds: o.urbanFeeds }, { tiers: ["core"], cacheDir });
  const places = await loadPlaces(cacheDir, o.cfg.userAgent, o.assetsDir);
  const cityIdx = new DiscIndex(cityDiscs(places, TRANSIT_CITY_MIN_POP));
  const monday = transitMonday(o.startDate);
  let db: Db | null = null;
  const out: TransitFeed[] = [];
  const todo: { rf: ResolvedFeed; local: boolean }[] = [...base.map((rf) => ({ rf, local: false })), ...extra.map((rf) => ({ rf, local: true }))];
  let extracted = 0;
  for (const { rf, local } of todo) {
    const zip = join(cacheDir, "feeds", rf.key + ".zip");
    if (!existsSync(zip)) {
      if (!local || !o.download) continue;
      try {
        await downloadWithFallback(rf.urls, zip, o.cfg.userAgent);
      } catch (e) {
        warn(`transit feed ${rf.key}: download failed: ${(e as Error).message}`);
        continue;
      }
    }
    // a feed whose service ended more than staleMaxDays ago is left out (gtfs/validity.ts; warned by the main stage and
    // the local layer); a stale one within the cap is read for its last whole week (extractTransitFeed)
    if ((await zipState(zip, o.startDate, o.staleMaxDays ?? STALE_MAX_DAYS)).kind === "too-old") continue;
    const st = await stat(zip);
    const cacheFile = join(outDir, `${rf.key}.json.gz`);
    const stamp = `${st.size}:${TRANSIT_EXTRACT_VERSION}:${monday}:${TRANSIT_CITY_MIN_POP}`;
    let feed: TransitFeed | null = null;
    let cached = false;
    if (existsSync(cacheFile)) {
      try {
        const j = JSON.parse(gunzipSync(await readFile(cacheFile)).toString("utf8")) as { stamp?: string; feed: TransitFeed | null };
        if (j.stamp === stamp) {
          feed = j.feed;
          cached = true;
        }
      } catch {
        /* re-extract */
      }
    }
    if (!cached) {
      db ??= await Db.open(":memory:", { threads: 4, memoryLimit: process.env.ETL_DUCKDB_MEMORY ?? "4GB", tempDir: join(tmpDir, "duckdb-transit") });
      const t0 = Date.now();
      feed = await extractTransitFeed(db, rf.key, zip, { monday, local, cityIdx, tmpDir });
      await writeFile(cacheFile, gzipSync(JSON.stringify({ stamp, feed })));
      extracted++;
      if (feed)
        log(`transit ${rf.key}: ${feed.patterns.length} patterns, ${feed.stats.trips} trips (${feed.stats.freqTrips} from frequencies), ${feed.stops.length} stops in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    if (feed?.patterns.length) out.push(feed);
  }
  db?.close();
  log(`transit: ${out.length} feeds with rail-bound local transport (${extracted} extracted, week of ${monday})`);
  return out;
}

/**
 * Transit pairs for every city with at least two candidate stations. `stations` are the network's stations
 * (id = index), `cities` their cities; returns city id → pairs (station ids as given).
 */
export function computeTransit(
  feeds: TransitFeed[],
  cities: { id: number; name: string; stations: number[] }[],
  stations: { lon: number; lat: number; cats: number; tpd?: number }[],
  log: (m: string) => void = defaultLog,
): { byCity: Map<number, TransitPair[]>; stats: Record<string, number> } {
  const t0 = Date.now();
  const idx = new TransitIndex(feeds);
  const byCity = new Map<number, TransitPair[]>();
  let nPairs = 0, nCities = 0;
  const slow: string[] = [];
  for (const c of cities) {
    const cand = c.stations
      .filter((s) => stations[s]!.cats & TRANSIT_STATION_CATS)
      .map((s) => ({ id: s, lon: stations[s]!.lon, lat: stations[s]!.lat, cats: stations[s]!.cats, tpd: stations[s]!.tpd ?? 0 }));
    if (cand.length < 2) continue;
    const t1 = Date.now();
    const r = cityTransit(idx, { city: c.id, stations: cand });
    if (!r.pairs.length) continue;
    byCity.set(c.id, r.pairs);
    nPairs += r.pairs.length;
    nCities++;
    const ms = Date.now() - t1;
    if (ms > 3000) slow.push(`${c.name} ${(ms / 1000).toFixed(0)}s`);
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  log(`transit: ${nPairs} station pairs in ${nCities} cities in ${secs}s${slow.length ? ` (slowest: ${slow.slice(0, 12).join(", ")})` : ""}`);
  return { byCity, stats: { transitCities: nCities, transitPairs: nPairs, transitSeconds: secs } };
}
