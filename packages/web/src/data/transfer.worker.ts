/**
 * Web worker: loads transfer timetable chunks and runs the searches for connections with changes
 * (logic/transfer.ts), so the page stays responsive. One request at a time; a newer request supersedes
 * the running one at its next round.
 */
import { TT_COORD, cityChunks, decodeTtChunk, decodeTtLines, type CalendarsFile, type Corridor, type TtIndex } from "@etbm/shared";
import type { GeoStore } from "./load.ts";
import { xferData } from "../map/features.ts";
import { buildCalIndex } from "../logic/calendar.ts";
import { TransferSearch, TtStore, type SearchParams, type TtNet } from "../logic/transfer.ts";
import { fetchGzBytes } from "./gz.ts";

export interface InitMsg {
  type: "init";
  /** absolute URL of the build directory, with a trailing slash */
  base: string;
  index: TtIndex;
  stationCity: Int32Array;
  /** city → its stations: cityStations[cityStart[c] … cityStart[c+1]-1] */
  cityStart: Int32Array;
  cityStations: Int32Array;
  cityTz: Uint16Array;
  timezones: string[];
  calendars: CalendarsFile;
}
export interface SearchMsg {
  type: "reach" | "journeys";
  id: number;
  params: SearchParams;
  /** reach: corridors already drawn as direct lines (not drawn again as lines with changes) */
  exclude?: Int32Array;
}
export type ToWorker = InitMsg | SearchMsg;

export interface RoundMsg {
  type: "round";
  id: number;
  round: number;
  done: boolean;
  level: Uint8Array;
  minutes: Int32Array;
  via: Int32Array;
  cats: Uint8Array;

  /** chunks loaded so far */
  chunks: number[];
  /** ms: chunk download + decode, search */
  loadMs: number;
  searchMs: number;
  events: number;
}
/** After a round ≥ 2: GeoJSON (text) of the lines reached with changes so far, see xferData. */
export interface LinesMsg {
  type: "lines";
  id: number;
  round: number;
  done: boolean;
  lines: string;
  /** ms: line files + GeoJSON */
  ms: number;
}
export interface JourneysMsg {
  type: "journeys";
  id: number;
  journeys: import("../logic/transfer.ts").Journey[];
  chunks: number[];
  loadMs: number;
  searchMs: number;
}
export interface ErrorMsg {
  type: "error";
  id: number;
  message: string;
}
export type FromWorker = RoundMsg | LinesMsg | JourneysMsg | ErrorMsg;

const scope = self as unknown as { postMessage(m: FromWorker, t?: Transferable[]): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null };

let init: InitMsg | null = null;
let net: TtNet | null = null;
let store: TtStore | null = null;
let chunkOfCity: Uint8Array | null = null;
const loading = new Map<number, Promise<void>>();
const loaded = new Set<number>();
let latest = 0;
// line files: simplified corridor geometry of the loaded chunks
const geo: GeoStore = { stations: [], corridors: new Map(), segments: new Map() };
const pairs = new Map<number, number>();
const linesLoading = new Map<number, Promise<void>>();
const pairKey = (a: number, b: number) => Math.min(a, b) * 131072 + Math.max(a, b);

function loadLines(k: number): Promise<void> {
  let p = linesLoading.get(k);
  if (!p) {
    p = fetchGzBytes(init!.base + init!.index.chunks[k]!.lines).then((bytes) => {
      const l = decodeTtLines(bytes);
      for (let i = 0; i < l.cId.length; i++) {
        const id = l.cId[i]!;
        pairs.set(pairKey(l.cA[i]!, l.cB[i]!), id);
        if (geo.corridors.has(id)) continue;
        const c: Corridor = { id, a: l.cA[i]!, b: l.cB[i]!, coords: [], cats: 0, tpd: {}, snapped: true, segs: Array.from(l.cSegCodes.subarray(l.cSeg[i]!, l.cSeg[i + 1]!)) };
        geo.corridors.set(id, c);
      }
      for (let i = 0; i < l.sId.length; i++) {
        const id = l.sId[i]!;
        if (geo.segments.has(id)) continue;
        const coords: [number, number][] = [];
        for (let q = l.sPt[i]!; q < l.sPt[i + 1]!; q++) coords.push([Math.round(l.sCoords[2 * q]! * TT_COORD * 1e4) / 1e4, Math.round(l.sCoords[2 * q + 1]! * TT_COORD * 1e4) / 1e4]);
        geo.segments.set(id, { coords, snapped: true, hop: false });
      }
    });
    p.catch(() => linesLoading.delete(k));
    linesLoading.set(k, p);
  }
  return p;
}

/** GeoJSON of the hops ridden in rounds ≥ 2 (level = round), without the excluded (direct) corridors. */
function linesOf(hopRounds: Int32Array[], exclude: Set<number>): string {
  const xfer = new Map<number, { level: number; cats: number }>();
  hopRounds.forEach((hops, ri) => {
    const level = ri + 1;
    if (level < 2) return;
    for (let i = 0; i < hops.length; i += 3) {
      const cid = pairs.get(pairKey(hops[i]!, hops[i + 1]!));
      if (cid === undefined || exclude.has(cid)) continue;
      const o = xfer.get(cid);
      if (!o) xfer.set(cid, { level, cats: hops[i + 2]! });
      else if (o.level === level) o.cats |= hops[i + 2]!;
    }
  });
  return JSON.stringify(xferData(geo, xfer));
}
let queue: Promise<void> = Promise.resolve();

function loadChunk(k: number): Promise<void> {
  let p = loading.get(k);
  if (!p) {
    const file = init!.index.chunks[k]!.file;
    p = fetchGzBytes(init!.base + file).then((bytes) => {
      store!.addChunk(decodeTtChunk(bytes));
      loaded.add(k);
    });
    p.catch(() => loading.delete(k));
    loading.set(k, p);
  }
  return p;
}

/** The trunk plus the region chunks of the given cities. */
async function ensure(cities: number[]): Promise<void> {
  const need = new Set<number>([0]);
  for (const c of cities) {
    const k = chunkOfCity![c];
    if (k !== undefined && k < init!.index.chunks.length) need.add(k);
  }
  await Promise.all([...need].map(loadChunk));
}

async function search(msg: SearchMsg): Promise<void> {
  if (msg.id !== latest || !store || !net) return;
  const s = new TransferSearch(store, net, msg.params);
  let loadMs = 0, searchMs = 0;
  while (!s.done) {
    const t0 = performance.now();
    await ensure(s.boardCities());
    loadMs += performance.now() - t0;
    if (msg.id !== latest) return; // superseded
    const t1 = performance.now();
    s.round();
    searchMs += performance.now() - t1;
    if (msg.type === "reach" && (s.rounds >= 2 || s.done)) {
      const o = s.out;
      scope.postMessage({
        type: "round", id: msg.id, round: s.rounds, done: s.done,
        level: o.level.slice(), minutes: o.minutes.slice(), via: o.via.slice(), cats: o.cats.slice(),
        chunks: [...loaded], loadMs: Math.round(loadMs), searchMs: Math.round(searchMs), events: s.events,
      });
      // then the map lines of the rounds so far (slower: line files, GeoJSON)
      if (s.rounds >= 2) {
        const t2 = performance.now();
        await Promise.all([...loaded].map(loadLines));
        if (msg.id !== latest) return;
        const lines = linesOf(o.hops, new Set(msg.exclude ?? []));
        scope.postMessage({ type: "lines", id: msg.id, round: s.rounds, done: s.done, lines, ms: Math.round(performance.now() - t2) });
      }
    }
  }
  if (msg.type === "journeys") {
    const t1 = performance.now();
    const journeys = s.journeys();
    searchMs += performance.now() - t1;
    scope.postMessage({ type: "journeys", id: msg.id, journeys, chunks: [...loaded], loadMs: Math.round(loadMs), searchMs: Math.round(searchMs) });
  }
}

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    init = msg;
    const cal = buildCalIndex(msg.calendars);
    const tzNames = Array.from(msg.cityTz, (i) => msg.timezones[i] ?? "UTC");
    net = {
      stationCity: msg.stationCity,
      cityStations: (c) => msg.cityStations.subarray(msg.cityStart[c]!, msg.cityStart[c + 1]!),
      cityTz: tzNames,
      timezones: msg.timezones,
      cal,
    };
    store = new TtStore(msg.stationCity.length);
    chunkOfCity = cityChunks(msg.index);
    return;
  }
  latest = msg.id;
  // one search at a time; a superseded one stops at its next round
  queue = queue.then(() =>
    search(msg).catch((err: unknown) => scope.postMessage({ type: "error", id: msg.id, message: (err as Error).message ?? String(err) })),
  );
};
