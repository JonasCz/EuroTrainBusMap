/**
 * Main-thread side of the connections-with-changes search: owns the worker, loads the line files of the
 * chunks the worker used (simplified corridor geometry for the map) and maps ridden hops to corridors.
 */
import { TT_COORD, decodeTtLines, type CityFile, type Corridor, type TtIndex } from "@etbm/shared";
import type { Leg } from "../logic/journey.ts";
import type { Journey, JourneyLeg, SearchParams } from "../logic/transfer.ts";
import type { FromWorker, JourneysMsg, LinesMsg, RoundMsg, ToWorker } from "./transfer.worker.ts";
import { fetchGzBytes } from "./gz.ts";
import { geoStore, loadDetail } from "./load.ts";
import type { Net } from "./net.ts";

export type ReachRound = RoundMsg;
export type ReachLines = LinesMsg;

export interface TransferPerf {
  label: string;
  loadMs: number;
  searchMs: number;
  linesMs?: number;
  totalMs: number;
  chunks: number;
  events?: number;
}

const pairKey = (a: number, b: number) => Math.min(a, b) * 131072 + Math.max(a, b);

export class TransferClient {
  private worker: Worker | null = null;
  private index: Promise<TtIndex> | null = null;
  private nextId = 1;
  private handlers = new Map<number, (m: FromWorker) => void>();
  private linesLoaded = new Map<number, Promise<void>>();
  /** station pair → corridor id (from the line files) */
  private pairs = new Map<number, number>();
  /** last measurements (also exposed for tests: window.__etbm.app.transfers.perf) */
  perf: TransferPerf[] = [];

  constructor(private net: Net) {}

  /** Whether the data build has a transfer timetable. */
  get available(): boolean {
    return !!this.net.ds.manifest.transfers;
  }

  private loadIndex(): Promise<TtIndex> {
    const t = this.net.ds.manifest.transfers;
    if (!t) return Promise.reject(new Error("This data build has no transfer timetable."));
    this.index ??= fetch(this.net.ds.url(t.index)).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} – ${t.index}`);
      return r.json() as Promise<TtIndex>;
    });
    return this.index;
  }

  private async start(): Promise<Worker> {
    if (this.worker) return this.worker;
    const [index, detail] = await Promise.all([this.loadIndex(), loadDetail(this.net.ds)]);
    if (this.worker) return this.worker;
    const cities = this.net.cities;
    const cityStart = new Int32Array(cities.length + 1);
    cities.forEach((c, i) => (cityStart[i + 1] = cityStart[i]! + c.stations.length));
    const cityStations = new Int32Array(cityStart[cities.length]!);
    cities.forEach((c, i) => cityStations.set(c.stations, cityStart[i]!));
    const w = new Worker(new URL("./transfer.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<FromWorker>) => this.handlers.get(e.data.id)?.(e.data);
    const msg: ToWorker = {
      type: "init",
      base: this.net.ds.url(""),
      index,
      stationCity: this.net.ds.stationCity,
      cityStart,
      cityStations,
      cityTz: Uint16Array.from(cities, (c) => c.tz),
      timezones: this.net.ds.core.timezones,
      calendars: detail.calendars,
    };
    w.postMessage(msg);
    this.worker = w;
    return w;
  }

  /** Requests waiting for an answer: settling one as superseded (a newer request replaces it in the worker). */
  private waiting = new Map<number, () => void>();

  private send(w: Worker, msg: ToWorker & { id: number }, onMsg: (m: FromWorker) => void, onSuperseded: () => void): void {
    for (const [old, cancel] of this.waiting) {
      this.waiting.delete(old);
      this.handlers.delete(old);
      cancel();
    }
    this.handlers.set(msg.id, onMsg);
    this.waiting.set(msg.id, onSuperseded);
    w.postMessage(msg);
  }

  private settle(id: number): void {
    this.handlers.delete(id);
    this.waiting.delete(id);
  }

  /**
   * Reach with changes: `onRound` gets the cumulative result after every round (round 1 = direct trips on the
   * day). Resolves after the last round, or when a newer search supersedes this one.
   */
  async reach(params: SearchParams, exclude: Iterable<number>, onRound: (r: ReachRound) => void, onLines: (l: ReachLines) => void, label = ""): Promise<void> {
    const w = await this.start();
    const id = this.nextId++;
    const t0 = performance.now();
    let last: RoundMsg | null = null;
    await new Promise<void>((resolve, reject) => {
      const finish = (linesMs?: number) => {
        this.settle(id);
        const m = last!;
        this.record({ label: `reach ${label} k=${params.transfers}`, loadMs: m.loadMs, searchMs: m.searchMs, ...(linesMs !== undefined ? { linesMs } : {}), totalMs: Math.round(performance.now() - t0), chunks: m.chunks.length, events: m.events });
        resolve();
      };
      this.send(
        w,
        { type: "reach", id, params, exclude: Int32Array.from(exclude) },
        (m) => {
          if (m.type === "error") {
            this.settle(id);
            reject(new Error(m.message));
          } else if (m.type === "round") {
            last = m;
            onRound(m);
            if (m.done && m.round < 2) finish();
          } else if (m.type === "lines") {
            onLines(m);
            if (m.done) finish(m.ms);
          }
        },
        resolve,
      );
    });
  }

  /** Journeys with changes from the origin to `params.target` on the day (Pareto-optimal, by departure); null when superseded. */
  async journeys(params: SearchParams, label = ""): Promise<{ journeys: Journey[]; chunks: number[] } | null> {
    const w = await this.start();
    const id = this.nextId++;
    const t0 = performance.now();
    const m = await new Promise<JourneysMsg | null>((resolve, reject) => {
      this.send(
        w,
        { type: "journeys", id, params },
        (msg) => {
          this.settle(id);
          if (msg.type === "error") reject(new Error(msg.message));
          else if (msg.type === "journeys") resolve(msg);
        },
        () => resolve(null),
      );
    });
    if (!m) return null;
    this.record({ label: `journeys ${label} k=${params.transfers}`, loadMs: m.loadMs, searchMs: m.searchMs, totalMs: Math.round(performance.now() - t0), chunks: m.chunks.length });
    return { journeys: m.journeys, chunks: m.chunks };
  }

  private record(p: TransferPerf): void {
    this.perf.push(p);
    if (this.perf.length > 50) this.perf.shift();
    if (import.meta.env.DEV) console.debug(`[perf] transfers ${p.label}: ${p.totalMs} ms (load ${p.loadMs}, search ${p.searchMs}${p.linesMs !== undefined ? `, lines ${p.linesMs}` : ""}, ${p.chunks} chunks${p.events ? `, ${p.events} events` : ""})`);
  }

  /**
   * Line files of the given chunks: corridors (station pairs) with simplified geometry, merged into the geo
   * store where the precise geometry of a loaded shard is not there yet.
   */
  async loadLines(chunks: number[]): Promise<void> {
    const index = await this.loadIndex();
    await Promise.all(
      chunks.map((k) => {
        let p = this.linesLoaded.get(k);
        if (!p) {
          const f = index.chunks[k];
          if (!f) return Promise.resolve();
          p = fetchGzBytes(this.net.ds.url(f.lines)).then((bytes) => {
            const l = decodeTtLines(bytes);
            for (let i = 0; i < l.cId.length; i++) {
              const id = l.cId[i]!;
              this.pairs.set(pairKey(l.cA[i]!, l.cB[i]!), id);
              if (geoStore.corridors.has(id)) continue;
              const c: Corridor = { id, a: l.cA[i]!, b: l.cB[i]!, coords: [], cats: 0, tpd: {}, snapped: true, segs: Array.from(l.cSegCodes.subarray(l.cSeg[i]!, l.cSeg[i + 1]!)) };
              geoStore.corridors.set(id, c);
            }
            for (let i = 0; i < l.sId.length; i++) {
              const id = l.sId[i]!;
              if (geoStore.segments.has(id)) continue;
              const coords: [number, number][] = [];
              for (let k2 = l.sPt[i]!; k2 < l.sPt[i + 1]!; k2++) coords.push([l.sCoords[2 * k2]! * TT_COORD, l.sCoords[2 * k2 + 1]! * TT_COORD]);
              geoStore.segments.set(id, { coords, snapped: true, hop: false });
            }
          });
          p.catch(() => this.linesLoaded.delete(k));
          this.linesLoaded.set(k, p);
        }
        return p;
      }),
    );
  }

  /** Corridor between two stations (consecutive stops), from the loaded line files. */
  corridor(a: number, b: number): number | undefined {
    return this.pairs.get(pairKey(a, b));
  }

  /** Corridors of a journey leg (board → alight). */
  legCorridors(l: JourneyLeg): number[] {
    const out: number[] = [];
    for (let j = l.board; j < l.alight; j++) {
      const c = this.corridor(l.stations[j]!, l.stations[j + 1]!);
      if (c !== undefined) out.push(c);
    }
    return out;
  }
}

/**
 * The leg of a CityFile (its own trip index) that rides the journey leg: same stops and times, same trip start
 * and calendar. `cf` is the CityFile of the boarding city.
 */
export function matchLeg(cf: CityFile, jl: JourneyLeg, from: number): Leg | null {
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const pats = new Set<number>();
  cf.patterns.forEach((p, i) => {
    if (same(p.stations, jl.stations) && same(p.arr, jl.arr) && same(p.dep, jl.dep) && cf.routes[p.route]?.cat === jl.cat) pats.add(i);
  });
  if (!pats.size) return null;
  const ti = cf.trips.findIndex((t) => pats.has(t[0]) && t[1] === jl.start && t[2] === jl.cal);
  if (ti < 0) return null;
  return { from, trip: ti, date: jl.serviceDate, board: jl.board, alight: jl.alight };
}
