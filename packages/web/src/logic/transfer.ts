/**
 * Connections with changes: a round-based search (RAPTOR-like) over the transfer timetable chunks
 * (packages/shared/src/tt.ts) for one travel day.
 *
 * Round 1 boards every trip leaving the origin (city, or one of its stations) on the day and records an
 * arrival event at every later stop of it – intermediate stops included, not only the last one. Round r + 1
 * boards, at every city reached in round r, every trip leaving one of the city's stations after an arrival
 * there: no earlier than the transfer time (the minimum transfer time at the same station; between two stations
 * of the city the walk between them, see packages/shared/src/walk.ts, and at least the minimum transfer time;
 * stations too far apart to walk, i.e. without a walking transfer in the chunks, have no transfer) and no later
 * than the maximum wait (or, with "same day", before local midnight of the arrival). Mode filters apply to every leg.
 *
 * The search is resumable round by round, so the caller can load the chunks of the cities where the next
 * round changes (`boardCities`) before running it.
 */
import { Grow, type TtChunk } from "@etbm/shared";
import { addDays, dayNumber, runsOnDay, type CalIndex } from "./calendar.ts";
import { serviceTimeToUtc, wallToUtc } from "./tz.ts";

/** Most transfers (changes) the UI offers; see README "Connections with changes" for the measurements. */
export const MAX_TRANSFERS = 2;

export interface TransferSettings {
  /** Number of changes (0 = direct only). */
  transfers: number;
  /** Minimum transfer time at the same station, minutes (a walk between stations takes at least this too). */
  minTransfer: number;
  /** Maximum wait between arrival and the connecting departure, minutes; null = until local midnight ("same day"). */
  maxWait: number | null;
}

export const DEFAULT_SETTINGS: TransferSettings = { transfers: 0, minTransfer: 10, maxWait: null };

/** Network lookups the search needs (stations of the core file, calendars). */
export interface TtNet {
  stationCity: ArrayLike<number>;
  /** stations of a city */
  cityStations(city: number): ArrayLike<number>;
  /** IANA tz per city */
  cityTz: ArrayLike<string>;
  /** IANA tz names indexed by TtChunk.pTz */
  timezones: ArrayLike<string>;
  cal: CalIndex;
}

/** Merged chunks: patterns (deduplicated by global id), walking transfers and a boarding index per station. */
export class TtStore {
  readonly chunks: TtChunk[] = [];
  private seen = new Set<number>();
  /** pattern references: chunk and local index */
  readonly refChunk = new Grow();
  readonly refP = new Grow();
  readonly refTripBase = new Grow();
  private nTrips = 0;
  private walk = new Map<number, number>();
  private board: { start: Int32Array; ref: Int32Array; stop: Int32Array } | null = null;

  constructor(readonly nStations: number) {}

  get patterns(): number {
    return this.refP.n;
  }

  addChunk(c: TtChunk): void {
    const ci = this.chunks.length;
    this.chunks.push(c);
    for (let p = 0; p < c.pId.length; p++) {
      if (this.seen.has(c.pId[p]!)) continue;
      this.seen.add(c.pId[p]!);
      this.refChunk.push(ci);
      this.refP.push(p);
      this.refTripBase.push(this.nTrips);
      this.nTrips += c.pTrip[p + 1]! - c.pTrip[p]!;
    }
    for (let i = 0; i < c.walk.length; i += 3) {
      this.walk.set(c.walk[i]! * 1048576 + c.walk[i + 1]!, c.walk[i + 2]!);
    }
    this.board = null;
  }

  /** Walking minutes between two stations of a city, undefined beyond walking range (no transfer). */
  walkMinutes(a: number, b: number): number | undefined {
    return a < b ? this.walk.get(a * 1048576 + b) : this.walk.get(b * 1048576 + a);
  }

  ref(r: number): { c: TtChunk; p: number; tripBase: number } {
    return { c: this.chunks[this.refChunk.a[r]!]!, p: this.refP.a[r]!, tripBase: this.refTripBase.a[r]! };
  }

  /** Boarding entries (pattern ref, stop index; never a pattern's last stop) per station. */
  boardings(): { start: Int32Array; ref: Int32Array; stop: Int32Array } {
    if (this.board) return this.board;
    const n = this.nStations;
    const count = new Int32Array(n + 1);
    const R = this.refP.n;
    for (let r = 0; r < R; r++) {
      const c = this.chunks[this.refChunk.a[r]!]!, p = this.refP.a[r]!;
      for (let k = c.pStop[p]!; k < c.pStop[p + 1]! - 1; k++) {
        const s = c.stStation[k]!;
        if (s >= 0 && s < n) count[s + 1]!++;
      }
    }
    for (let s = 0; s < n; s++) count[s + 1]! += count[s]!;
    const start = count.slice();
    const ref = new Int32Array(count[n]!), stop = new Int32Array(count[n]!);
    for (let r = 0; r < R; r++) {
      const c = this.chunks[this.refChunk.a[r]!]!, p = this.refP.a[r]!;
      const k0 = c.pStop[p]!;
      for (let k = k0; k < c.pStop[p + 1]! - 1; k++) {
        const s = c.stStation[k]!;
        if (s < 0 || s >= n) continue;
        const at = count[s]!++;
        ref[at] = r;
        stop[at] = k - k0;
      }
    }
    this.board = { start, ref, stop };
    return this.board;
  }
}

export interface SearchParams extends TransferSettings {
  origin: number;
  /** board only at this station of the origin */
  originStation?: number;
  /** travel date, origin-local YYYY-MM-DD */
  date: string;
  /** enabled Cat bits */
  cats: number;
  /** journeys mode: record complete journeys to this city (the last round keeps only events there) */
  target?: number;
}

/** Per reached city: first round (1 = direct on the day) and the fastest journey of that round. */
export interface ReachLevels {
  /** city → round (1 + changes) of the first arrival; 0 = not reached */
  level: Uint8Array;
  /** fastest total minutes (origin departure → arrival) in that round */
  minutes: Int32Array;
  /** change city of the fastest journey of that round (−1 for round 1) */
  via: Int32Array;
  /** Cat bits of the last legs reaching the city in that round */
  cats: Uint8Array;
  /** per round (index 0 = round 1): ridden hops as [stationA, stationB, cat] triples, each hop once per round */
  hops: Int32Array[];
}

export interface JourneyLeg {
  /** global pattern id and the pattern's stops (station ids) */
  patternId: number;
  stations: number[];
  arr: number[];
  dep: number[];
  cat: number;
  /** trip start (minutes, pattern tz) and calendar */
  start: number;
  cal: number;
  serviceDate: string;
  board: number;
  alight: number;
  depUtc: number;
  arrUtc: number;
}

export interface Journey {
  legs: JourneyLeg[];
  depUtc: number;
  arrUtc: number;
}

/**
 * One search (one origin, day, settings). `run(loadChunks)` executes every round, loading the chunks of the
 * cities where a round boards first; or drive it with boardCities() / round().
 */
export class TransferSearch {
  /** completed rounds */
  rounds = 0;
  readonly maxRounds: number;
  /** minutes since 1970 of origin-local midnight of the day (all times are minutes relative to it) */
  private t0: number;
  private dayLen: number;
  private dayIdx: number;
  /** service-day midnight per pattern tz and day offset (tz * 16 + dd + 8), NaN until computed */
  private base = new Float64Array(0);
  /** per calendar: bit (dd + 4) set when it runs on the day + dd, for dd in −4 … 4; −1 until computed */
  private calDays: Int16Array;
  private midnights = new Map<string, number[]>();
  // events of every stored round
  private ev = { station: new Grow(), time: new Grow(), dep0: new Grow(), prev: new Grow(), ref: new Grow(), trip: new Grow(), dd: new Grow(), board: new Grow(), alight: new Grow() };
  private roundStart: number[] = [0];
  /** events of the last round grouped: city → station groups (station, sorted event indices) */
  private groups = new Map<number, { station: number; evs: Int32Array }[]>();
  readonly out: ReachLevels;
  private journeysOut: { ev: number; round: number }[] = [];
  private nCities: number;

  constructor(
    private store: TtStore,
    private net: TtNet,
    readonly params: SearchParams,
  ) {
    this.maxRounds = 1 + Math.max(0, params.transfers);
    const tz = net.cityTz[params.origin] ?? "UTC";
    this.t0 = Math.round(wallToUtc(params.date, 0, tz) / 60000);
    this.dayLen = Math.round(wallToUtc(addDays(params.date, 1), 0, tz) / 60000) - this.t0;
    this.dayIdx = dayNumber(params.date) - net.cal.start;
    this.nCities = net.cityTz.length;
    this.base = new Float64Array(net.timezones.length * 16).fill(NaN);
    this.calDays = new Int16Array(net.cal.masks.length).fill(-1);
    this.out = { level: new Uint8Array(this.nCities), minutes: new Int32Array(this.nCities).fill(-1), via: new Int32Array(this.nCities).fill(-1), cats: new Uint8Array(this.nCities), hops: [] };
  }

  get done(): boolean {
    return this.rounds >= this.maxRounds;
  }

  /** Cities where the next round boards (the origin for round 1). */
  boardCities(): number[] {
    return this.rounds === 0 ? [this.params.origin] : [...this.groups.keys()];
  }

  /** Total events stored so far (memory / progress indicator). */
  get events(): number {
    return this.ev.station.n;
  }

  async run(load: (cities: number[]) => Promise<void>, onRound?: (r: number) => void): Promise<void> {
    while (!this.done) {
      await load(this.boardCities());
      this.round();
      onRound?.(this.rounds);
    }
  }

  /** Minutes (relative to t0) of service-day midnight of `date + dd` in pattern tz `tz`. */
  private baseOf(tz: number, dd: number): number {
    const key = tz * 16 + dd + 8;
    let b = this.base[key]!;
    if (Number.isNaN(b)) {
      b = Math.round(serviceTimeToUtc(addDays(this.params.date, dd), 0, this.net.timezones[tz] ?? "UTC") / 60000) - this.t0;
      this.base[key] = b;
    }
    return b;
  }

  private tripDayCache = new Map<TtChunk, Int16Array>();
  /** Per trip of a chunk: bit (dd + 4) set when it runs on the travel day + dd. */
  private tripDays(c: TtChunk): Int16Array {
    let m = this.tripDayCache.get(c);
    if (!m) {
      m = new Int16Array(c.trCal.length);
      for (let t = 0; t < m.length; t++) {
        const cal = c.trCal[t]!;
        let v = this.calDays[cal]!;
        if (v < 0) {
          this.runs(cal, 0);
          v = this.calDays[cal]!;
        }
        m[t] = v;
      }
      this.tripDayCache.set(c, m);
    }
    return m;
  }

  /** Whether calendar `cal` runs on the travel day + dd (−4 ≤ dd ≤ 4). */
  private runs(cal: number, dd: number): boolean {
    let m = this.calDays[cal]!;
    if (m < 0) {
      m = 0;
      for (let k = -4; k <= 4; k++) if (runsOnDay(this.net.cal, cal, this.dayIdx + k)) m |= 1 << (k + 4);
      this.calDays[cal] = m;
    }
    return (m & (1 << (dd + 4))) !== 0;
  }

  /** Transfer minutes from station a to b of a city; Infinity when they are too far apart to walk. */
  private transferMin(a: number, b: number): number {
    const min = this.params.minTransfer;
    if (a === b) return min;
    const w = this.store.walkMinutes(a, b);
    return w === undefined ? Infinity : Math.max(min, w);
  }

  /** Local midnights (relative minutes) around the day in a city's tz. */
  private midnightsOf(city: number): number[] {
    const tz = this.net.cityTz[city] ?? "UTC";
    let m = this.midnights.get(tz);
    if (!m) {
      m = [];
      for (let k = -3; k <= 5; k++) m.push(Math.round(wallToUtc(addDays(this.params.date, k), 0, tz) / 60000) - this.t0);
      this.midnights.set(tz, m);
    }
    return m;
  }

  /** Run the next round. */
  round(): void {
    if (this.done) return;
    const r = ++this.rounds;
    const P = this.params;
    const store = this.store;
    const B = store.boardings();
    const last = r === this.maxRounds;
    // the last round of a reach search only needs, per pattern and boarding stop, the best origin departure
    // relative to the trip's start ("slack"): one entry per pattern instead of one per trip
    const byRef = last && P.target === undefined;
    const inst = new Map<number, number>();
    const iRef = new Grow(), iTrip = new Grow(), iDd = new Grow(), iHead = new Grow();
    const bStop = new Grow(), bVal = new Grow(), bPrev = new Grow(), bNext = new Grow();
    const add = (key: number, ref: number, t: number, dd: number, stop: number, val: number, prev: number) => {
      let k = inst.get(key);
      if (k === undefined) {
        k = iRef.n;
        inst.set(key, k);
        iRef.push(ref); iTrip.push(t); iDd.push(dd); iHead.push(-1);
      }
      bStop.push(stop); bVal.push(val); bPrev.push(prev); bNext.push(iHead.a[k]!);
      iHead.a[k] = bStop.n - 1;
    };
    const rc = store.refChunk.a, rp = store.refP.a, rtb = store.refTripBase.a, chunks = store.chunks;
    const W = P.maxWait;

    if (r === 1) {
      const stations = P.originStation !== undefined ? [P.originStation] : Array.from(this.net.cityStations(P.origin));
      for (const s of stations) {
        if (s >= store.nStations) continue;
        for (let e = B.start[s]!; e < B.start[s + 1]!; e++) {
          const ref = B.ref[e]!, i = B.stop[e]!;
          const c = chunks[rc[ref]!]!, p = rp[ref]!;
          if (!(c.pCat[p]! & P.cats)) continue;
          const dep = c.stDep[c.pStop[p]! + i]!;
          const t0 = c.pTrip[p]!, t1 = c.pTrip[p + 1]!;
          let bestVal = -Infinity;
          for (let dd = -3; dd <= 0; dd++) {
            const base = this.baseOf(c.pTz[p]!, dd) + dep;
            // departures in [0, dayLen)
            for (let t = lowerBound(c.trStart, t0, t1, -base); t < t1 && c.trStart[t]! + base < this.dayLen; t++) {
              if (!this.runs(c.trCal[t]!, dd)) continue;
              const d = c.trStart[t]! + base;
              if (byRef) bestVal = Math.max(bestVal, dep);
              else add((rtb[ref]! + t - t0) * 8 + dd + 3, ref, t, dd, i, d, -1);
            }
          }
          if (byRef && bestVal > -Infinity) add(ref, ref, -1, 0, i, bestVal, -1);
        }
      }
    } else {
      const ev = this.ev;
      const et = ev.time.a, ed = ev.dep0.a;
      for (const [city, groups] of this.groups) {
        const mids = this.midnightsOf(city);
        const nextMid = (t: number) => {
          for (const x of mids) if (x > t) return x;
          return t + 1440;
        };
        // all arrivals in the city, by time: origin departure, station and the latest departure each one allows
        // (non-decreasing, so the arrivals that make a departure form one index range), with a range maximum
        // over the origin departures
        let n = 0;
        for (const g of groups) n += g.evs.length;
        let IB = 1;
        while (IB <= n) IB *= 2;
        const keys = new Float64Array(n);
        let q = 0;
        for (const g of groups) for (const x of g.evs) keys[q] = (et[x]! + 65536) * IB + q++;
        const flat = new Int32Array(n), flatG = new Int32Array(n);
        q = 0;
        for (let gi = 0; gi < groups.length; gi++) for (const x of groups[gi]!.evs) (flatG[q] = gi), (flat[q++] = x);
        keys.sort();
        const time = new Int32Array(n), dep0 = new Int32Array(n), lim = new Int32Array(n), evs = new Int32Array(n), eg = new Int32Array(n);
        for (let k = 0; k < n; k++) {
          const f = keys[k]! % IB, x = flat[f]!;
          evs[k] = x;
          time[k] = et[x]!;
          dep0[k] = ed[x]!;
          eg[k] = flatG[f]!;
          lim[k] = W === null ? nextMid(et[x]!) - 1 : et[x]! + W;
        }
        const all: Arrivals = { time, dep0, lim, evs, eg, rmq: new RangeMax(dep0, W === null ? lim : null) };
        // arrivals without the stations too far from a departure station to walk (cached by the excluded set)
        const views = new Map<string, Arrivals>();
        const stations = this.net.cityStations(city);
        // transfer minutes from each group's station to the departure station (Infinity: too far to walk)
        const xg = new Float64Array(groups.length);
        for (let si = 0; si < stations.length; si++) {
          const s2 = stations[si]!;
          if (s2 >= store.nStations || B.start[s2] === B.start[s2 + 1]) continue;
          let maxX = P.minTransfer, far = "", near = 0;
          for (let gi = 0; gi < groups.length; gi++) {
            const x = (xg[gi] = this.transferMin(groups[gi]!.station, s2));
            if (x === Infinity) far += `${gi},`;
            else {
              near++;
              // arrivals at least this long before a departure make it whatever their station
              if (x > maxX) maxX = x;
            }
          }
          if (!near) continue;
          let A = all;
          if (far) {
            let v = views.get(far);
            if (!v) views.set(far, (v = filterArrivals(all, xg, W === null)));
            A = v;
          }
          const { time, dep0, lim, evs, eg, rmq } = A;
          const lo = time[0]! + P.minTransfer, hi = lim[lim.length - 1]!;
          for (let e = B.start[s2]!; e < B.start[s2 + 1]!; e++) {
            const ref = B.ref[e]!, i = B.stop[e]!;
            const c = chunks[rc[ref]!]!, p = rp[ref]!;
            if (!(c.pCat[p]! & P.cats)) continue;
            const dep = c.stDep[c.pStop[p]! + i]!;
            const t0 = c.pTrip[p]!, t1 = c.pTrip[p + 1]!;
            const trStart = c.trStart, days = this.tripDays(c);
            const sMin = trStart[t0]!, sMax = trStart[t1 - 1]!;
            const tz = c.pTz[p]!;
            let bestVal = -Infinity, bestPrev = -1;
            for (let dd = -2; dd <= 3; dd++) {
              const base = this.baseOf(tz, dd) + dep;
              if (sMax + base < lo || sMin + base > hi) continue;
              const bit = 1 << (dd + 4);
              for (let t = lowerBound(trStart, t0, t1, lo - base); t < t1; t++) {
                const d = trStart[t]! + base;
                if (d > hi) break;
                if (!(days[t]! & bit)) continue;
                // the arrival with the latest origin departure that makes this departure
                const hiK = upperBound(time, d - P.minTransfer) - 1;
                if (hiK < 0 || lim[hiK]! < d) continue;
                const kLo = lowerBound(lim, 0, hiK + 1, d);
                const hiAll = Math.min(hiK, upperBound(time, d - maxX) - 1);
                let best = hiAll >= kLo ? rmq.argmax(kLo, hiAll) : -1;
                for (let k = Math.max(kLo, hiAll + 1); k <= hiK; k++) {
                  if ((best < 0 || dep0[k]! > dep0[best]!) && time[k]! + xg[eg[k]!]! <= d) best = k;
                }
                if (best < 0) continue;
                const bd = dep0[best]!, bx = evs[best]!;
                if (byRef) {
                  const val = bd - (d - dep);
                  if (val > bestVal) {
                    bestVal = val;
                    bestPrev = bx;
                  }
                } else add((rtb[ref]! + t - t0) * 8 + dd + 3, ref, t, dd, i, bd, bx);
              }
            }
            if (byRef && bestPrev >= 0) add(ref, ref, -1, 0, i, bestVal, bestPrev);
          }
        }
      }
    }

    // ---- ride every boarded trip (pattern): an event at each later stop, from the boarding with the latest origin departure
    const ev = this.ev;
    const o = this.out;
    const sc = this.net.stationCity;
    const store_ = !last || P.target !== undefined;
    const roundFirst = ev.station.n;
    const hopFrom = new Map<number, number>();
    const order: number[] = [];
    for (let k = 0; k < iRef.n; k++) {
      order.length = 0;
      for (let b = iHead.a[k]!; b >= 0; b = bNext.a[b]!) order.push(b);
      if (order.length > 1) order.sort((x, y) => bStop.a[x]! - bStop.a[y]!);
      const ref = iRef.a[k]!, t = iTrip.a[k]!, dd = iDd.a[k]!;
      const c = chunks[rc[ref]!]!, p = rp[ref]!;
      const k0 = c.pStop[p]!, n = c.pStop[p + 1]! - k0;
      const base = byRef ? 0 : this.baseOf(c.pTz[p]!, dd) + c.trStart[t]!;
      const cat = c.pCat[p]!;
      const first = bStop.a[order[0]!]!;
      const hf = hopFrom.get(ref);
      if (hf === undefined || first < hf) hopFrom.set(ref, first);
      let oi = 0, cur = -1, curVal = -Infinity;
      for (let j = first + 1; j < n; j++) {
        while (oi < order.length && bStop.a[order[oi]!]! < j) {
          const b = order[oi++]!;
          if (bVal.a[b]! > curVal) {
            curVal = bVal.a[b]!;
            cur = b;
          }
        }
        const sb = c.stStation[k0 + j]!;
        const city = sc[sb]!;
        if (city === P.origin || city < 0) continue;
        const time = base + c.stArr[k0 + j]!;
        const dur = time - curVal;
        const prev = bPrev.a[cur]!;
        const lv = o.level[city]!;
        if (!lv || lv === r) {
          if (!lv || dur < o.minutes[city]!) {
            o.level[city] = r;
            o.minutes[city] = dur;
            o.via[city] = prev >= 0 ? sc[ev.station.a[prev]!]! : -1;
          }
          o.cats[city]! |= cat;
        }
        if (!store_ || (last && city !== P.target)) continue;
        ev.station.push(sb); ev.time.push(time); ev.dep0.push(curVal); ev.prev.push(prev);
        ev.ref.push(ref); ev.trip.push(t); ev.dd.push(dd); ev.board.push(bStop.a[cur]!); ev.alight.push(j);
      }
    }
    // ridden hops (map lines), each once per round and mode
    const hops = new Map<number, number>();
    const hopsOut = new Grow();
    for (const [ref, from] of hopFrom) {
      const c = chunks[rc[ref]!]!, p = rp[ref]!;
      const k0 = c.pStop[p]!, n = c.pStop[p + 1]! - k0, cat = c.pCat[p]!;
      for (let j = from; j < n - 1; j++) {
        const sa = c.stStation[k0 + j]!, sb = c.stStation[k0 + j + 1]!;
        const hk = Math.min(sa, sb) * 131072 + Math.max(sa, sb);
        const hc = hops.get(hk) ?? 0;
        if (hc & cat) continue;
        hops.set(hk, hc | cat);
        hopsOut.push(sa); hopsOut.push(sb); hopsOut.push(cat);
      }
    }
    o.hops.push(hopsOut.done());
    this.roundStart.push(ev.station.n);
    if (P.target !== undefined) for (let x = roundFirst; x < ev.station.n; x++) if (sc[ev.station.a[x]!] === P.target) this.journeysOut.push({ ev: x, round: r });
    this.groupRound(roundFirst, ev.station.n);
  }

  /** Group the events of the last round by city and station, sorted by time (same station and time: the latest origin departure). */
  private groupRound(from: number, to: number): void {
    this.groups = new Map();
    if (this.done) return;
    const ev = this.ev;
    const n = to - from;
    if (!n) return;
    // sort by (station, time) packed into one float64 key with the event index in the low bits
    const OFF = 2048, TB = 8192; // times within -2048 … 6143 minutes of t0
    let IB = 1;
    while (IB <= n) IB *= 2;
    const keys = new Float64Array(n);
    let packed = this.store.nStations * TB * IB < 2 ** 53;
    for (let i = 0; i < n && packed; i++) {
      const x = from + i;
      const t = ev.time.a[x]! + OFF;
      if (t < 0 || t >= TB) packed = false;
      else keys[i] = (ev.station.a[x]! * TB + t) * IB + i;
    }
    if (packed) keys.sort();
    else {
      const idx = Array.from({ length: n }, (_, i) => i);
      idx.sort((a, b) => ev.station.a[from + a]! - ev.station.a[from + b]! || ev.time.a[from + a]! - ev.time.a[from + b]!);
      idx.forEach((v, i) => (keys[i] = v));
    }
    const stationOf = (k: number) => (packed ? Math.floor(k / IB / TB) : ev.station.a[from + k]!);
    const indexOf = (k: number) => (packed ? k % IB : k);
    let i = 0;
    const tmp = new Grow();
    while (i < n) {
      const st = stationOf(keys[i]!);
      tmp.n = 0;
      let lastT = NaN;
      for (; i < n; i++) {
        const k = keys[i]!;
        if (stationOf(k) !== st) break;
        const x = from + indexOf(k);
        const t = ev.time.a[x]!;
        if (t === lastT) {
          // keep the latest origin departure for one arrival time
          const y = tmp.a[tmp.n - 1]!;
          if (ev.dep0.a[x]! > ev.dep0.a[y]!) tmp.a[tmp.n - 1] = x;
          continue;
        }
        lastT = t;
        tmp.push(x);
      }
      const city = this.net.stationCity[st]!;
      let g = this.groups.get(city);
      if (!g) this.groups.set(city, (g = []));
      g.push({ station: st, evs: tmp.done() });
    }
  }

  /** Complete journeys to the target (journeys mode), Pareto-optimal over departure, arrival and changes, by departure. */
  journeys(): Journey[] {
    const ev = this.ev;
    const all = this.journeysOut.map(({ ev: x, round }) => ({ x, round, dep0: ev.dep0.a[x]!, arr: ev.time.a[x]! }));
    // Pareto sweep: later departures first; a journey is kept unless one departing no earlier arrives no later with no more changes
    all.sort((a, b) => b.dep0 - a.dep0 || a.arr - b.arr || a.round - b.round);
    const bestArr: number[] = [];
    const keep = all.filter((a) => {
      for (let r = 1; r <= a.round; r++) if (bestArr[r] !== undefined && bestArr[r]! <= a.arr) return false;
      bestArr[a.round] = Math.min(bestArr[a.round] ?? Infinity, a.arr);
      return true;
    });
    keep.sort((a, b) => a.dep0 - b.dep0 || a.arr - b.arr);
    return keep.map((k) => {
      const legs: JourneyLeg[] = [];
      for (let x = k.x; x >= 0; x = ev.prev.a[x]!) legs.unshift(this.leg(x));
      return { legs, depUtc: legs[0]!.depUtc, arrUtc: legs[legs.length - 1]!.arrUtc };
    });
  }

  private leg(x: number): JourneyLeg {
    const ev = this.ev;
    const { c, p } = this.store.ref(ev.ref.a[x]!);
    const k0 = c.pStop[p]!, k1 = c.pStop[p + 1]!;
    const t = ev.trip.a[x]!, dd = ev.dd.a[x]!;
    const board = ev.board.a[x]!, alight = ev.alight.a[x]!;
    const base = this.baseOf(c.pTz[p]!, dd) + c.trStart[t]!;
    return {
      patternId: c.pId[p]!,
      stations: Array.from(c.stStation.subarray(k0, k1)),
      arr: Array.from(c.stArr.subarray(k0, k1)),
      dep: Array.from(c.stDep.subarray(k0, k1)),
      cat: c.pCat[p]!,
      start: c.trStart[t]!,
      cal: c.trCal[t]!,
      serviceDate: addDays(this.params.date, dd),
      board,
      alight,
      depUtc: (this.t0 + base + c.stDep[k0 + board]!) * 60000,
      arrUtc: (this.t0 + base + c.stArr[k0 + alight]!) * 60000,
    };
  }
}

/**
 * Arrivals in a city sorted by time: time, origin departure, latest departure each allows, event, station group
 * (index into the city's groups); range max over the origin departures.
 */
interface Arrivals {
  time: Int32Array;
  dep0: Int32Array;
  lim: Int32Array;
  evs: Int32Array;
  eg: Int32Array;
  rmq: RangeMax;
}

/** The arrivals of the groups with a finite transfer time `xg` (a subsequence, so still sorted by time and by limit). */
function filterArrivals(a: Arrivals, xg: Float64Array, segByLim: boolean): Arrivals {
  const n = a.eg.length;
  let m = 0;
  for (let k = 0; k < n; k++) if (xg[a.eg[k]!] !== Infinity) m++;
  const time = new Int32Array(m), dep0 = new Int32Array(m), lim = new Int32Array(m), evs = new Int32Array(m), eg = new Int32Array(m);
  m = 0;
  for (let k = 0; k < n; k++) {
    if (xg[a.eg[k]!] === Infinity) continue;
    time[m] = a.time[k]!;
    dep0[m] = a.dep0[k]!;
    lim[m] = a.lim[k]!;
    evs[m] = a.evs[k]!;
    eg[m++] = a.eg[k]!;
  }
  return { time, dep0, lim, evs, eg, rmq: new RangeMax(dep0, segByLim ? lim : null) };
}

/**
 * Index of the largest value of `v` in an index range [lo, hi]. With `seg` (non-decreasing segment keys, e.g. the
 * day of each arrival) every query range ends in the segment it starts in, so a prefix maximum per segment
 * answers it in O(1); otherwise a sparse table (built for longer arrays only, short ones are scanned).
 */
export class RangeMax {
  private pre: Int32Array | null = null;
  private table: Int32Array[] | null = null;
  constructor(
    private v: Int32Array,
    seg: Int32Array | null,
  ) {
    const n = v.length;
    if (seg) {
      const pre = new Int32Array(n);
      for (let k = 0; k < n; k++) pre[k] = k > 0 && seg[k] === seg[k - 1] && v[pre[k - 1]!]! >= v[k]! ? pre[k - 1]! : k;
      this.pre = pre;
    } else if (n > 16) {
      const t: Int32Array[] = [Int32Array.from({ length: n }, (_, k) => k)];
      for (let w = 1; 2 * w <= n; w *= 2) {
        const prev = t[t.length - 1]!;
        const next = new Int32Array(n - 2 * w + 1);
        for (let k = 0; k < next.length; k++) next[k] = v[prev[k]!]! >= v[prev[k + w]!]! ? prev[k]! : prev[k + w]!;
        t.push(next);
      }
      this.table = t;
    }
  }

  argmax(lo: number, hi: number): number {
    if (this.pre) return this.pre[hi]!; // the range starts in hi's segment
    if (this.table) {
      const len = hi - lo + 1;
      const lv = 31 - Math.clz32(len);
      const row = this.table[lv]!;
      const a = row[lo]!, b = row[hi - (1 << lv) + 1]!;
      return this.v[a]! >= this.v[b]! ? a : b;
    }
    let best = hi;
    for (let k = hi - 1; k >= lo; k--) if (this.v[k]! > this.v[best]!) best = k;
    return best;
  }
}

/** First index in [lo, hi) with a[i] >= x. */
function lowerBound(a: Int32Array, lo: number, hi: number, x: number): number {
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m]! < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** First index whose value is > x (a sorted). */
function upperBound(a: Int32Array, x: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m]! <= x) lo = m + 1;
    else hi = m;
  }
  return lo;
}
