import { fastDist } from "../util/geo.ts";
import { fold, isTerminalName, nameQuality, normSimilarity, normalizeStopName, prettifyName, sanitizeName, stripPlatform } from "./names.ts";

export interface StopIn {
  lon: number;
  lat: number;
  /** display-safe name (sanitizeName) */
  name: string;
  rail: boolean;
  /** Group key for same parent_station (e.g. "feed:parentKey"), or null. */
  parent: string | null;
  feed: number;
  /** Number of trips serving the stop (for representative choice). */
  weight: number;
}

class UF {
  p: Int32Array;
  // cluster centroid accumulators
  sx: Float64Array;
  sy: Float64Array;
  n: Int32Array;
  constructor(len: number, lons: Float64Array, lats: Float64Array) {
    this.p = new Int32Array(len);
    for (let i = 0; i < len; i++) this.p[i] = i;
    this.sx = Float64Array.from(lons);
    this.sy = Float64Array.from(lats);
    this.n = new Int32Array(len).fill(1);
  }
  find(x: number): number {
    while (this.p[x] !== x) {
      this.p[x] = this.p[this.p[x]!]!;
      x = this.p[x]!;
    }
    return x;
  }
  centroid(r: number): [number, number] {
    return [this.sx[r]! / this.n[r]!, this.sy[r]! / this.n[r]!];
  }
  union(a: number, b: number, maxSpan: number): boolean {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return true;
    if (maxSpan > 0) {
      const [ax, ay] = this.centroid(ra), [bx, by] = this.centroid(rb);
      if (fastDist(ax, ay, bx, by) > maxSpan) return false;
    }
    this.p[rb] = ra;
    this.sx[ra]! += this.sx[rb]!;
    this.sy[ra]! += this.sy[rb]!;
    this.n[ra]! += this.n[rb]!;
    return true;
  }
}

/**
 * Why two stops were merged into one station. Several weak signals decide, none is trusted alone:
 *  - parent: the feed's own parent_station (explicit, but operators rarely maintain it),
 *  - near: very close (platforms, the same stop in two feeds, a bus bay in front of the entrance),
 *  - name: close and the names agree ("Foo Hbf" / "Foo Bahnhof (Bus)"), a larger radius at rail stations,
 *  - terminal: a bus / coach terminal ("ZOB", "gare routière", "Coach Station") next to a rail station,
 *  - isolated: a little further apart but with no other stop around (small towns: station + bus stop).
 */
export type MergeSignal = "parent" | "near" | "name" | "terminal" | "isolated";
export const MERGE_SIGNALS: MergeSignal[] = ["parent", "near", "name", "terminal", "isolated"];

export interface MergeOptions {
  /** Always the same place (m), unless two rail stops with clearly different names. */
  sureM: number;
  /** Merge radius (m) whatever the names say (unless both are rail stops with different names). */
  nearM: number;
  /** Merge radius (m) when the names agree and a rail stop is involved / for bus stops only. */
  nameM: number;
  busNameM: number;
  /** Bus terminal ↔ rail station radius (m). */
  terminalM: number;
  /** `nearM` shrinks to nearDenseM / nearCrowdedM where many stops with other names lie within nearM (cities). */
  nearDenseM: number;
  nearCrowdedM: number;
  /** Radius (m) for a pair with no other stop of a different name nearby. */
  isolatedM: number;
  /** "Nearby" radius (m) of the isolation test. */
  isolationM: number;
  /** Max distance between cluster centroids (m) after a near / isolated merge, a name / terminal merge, and a parent merge. */
  maxSpan: number;
  maxSpanName: number;
  maxSpanParent: number;
}

export const DEFAULT_MERGE: MergeOptions = {
  sureM: 60, nearM: 150, nearDenseM: 100, nearCrowdedM: 70, nameM: 400, busNameM: 250, terminalM: 450, isolatedM: 300, isolationM: 400,
  maxSpan: 250, maxSpanName: 450, maxSpanParent: 1500,
};

export interface PairInfo {
  /** distance (m) */
  d: number;
  /** name similarity 0..1 (0.5 = neutral: a generic name) */
  sim: number;
  railA: boolean;
  railB: boolean;
  /** a non-rail stop named like a bus / coach terminal */
  termA: boolean;
  termB: boolean;
  /** number of stops with a different name within `nearM` of each stop (the partner counts): crowded places shrink the near radius */
  crowdA: number;
  crowdB: number;
  /** no other station with a different name within `isolationM` of the two (evaluated lazily, see mergeStations) */
  isolated: boolean;
}

/** Which signal (if any) merges two stops that are not already in one station. Pure. */
export function classifyPair(p: PairInfo, o: MergeOptions = DEFAULT_MERGE): Exclude<MergeSignal, "parent"> | null {
  const { d, sim } = p;
  const bothRail = p.railA && p.railB;
  const anyRail = p.railA || p.railB;
  if (d <= o.sureM) return "near";
  const crowd = Math.max(p.crowdA, p.crowdB);
  // bus stops with different names are different places on the street: only the same spot (sureM) merges them
  let nearM = crowd <= 2 ? o.nearM : crowd <= 5 ? o.nearDenseM : o.nearCrowdedM;
  if (!anyRail && sim < 0.35) nearM = o.sureM;
  if (d <= nearM && !(bothRail && sim < 0.35)) return "near";
  if (sim >= 0.6 && d <= (anyRail ? o.nameM : o.busNameM)) return "name";
  if (bothRail && sim >= 0.5 && d <= o.nameM) return "name";
  if (d <= o.terminalM && sim >= 0.35 && ((p.termA && !p.railA && p.railB) || (p.termB && !p.railB && p.railA))) return "terminal";
  // each of the two is only close to the other one: a small town's station and its bus stop
  if (d <= o.isolatedM && p.isolated && !(bothRail && sim < 0.5)) return "isolated";
  return null;
}

class IntVec {
  a = new Int32Array(1 << 16);
  n = 0;
  push(v: number): void {
    if (this.n === this.a.length) {
      const b = new Int32Array(this.n * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
}

export interface MergeResult {
  stationOf: Int32Array;
  count: number;
  /** unions that joined two stations, per signal */
  bySignal: Record<MergeSignal, number>;
}

/**
 * Merge stops into stations (purely spatial: cities are assigned afterwards). Returns the station
 * index per stop (dense 0..n-1) and how many merges each signal caused. Strong signals are applied first.
 */
export function mergeStations(stops: StopIn[], opts: MergeOptions = DEFAULT_MERGE): MergeResult {
  const n = stops.length;
  const lons = Float64Array.from(stops, (s) => s.lon), lats = Float64Array.from(stops, (s) => s.lat);
  const uf = new UF(n, lons, lats);
  const bySignal: Record<MergeSignal, number> = { parent: 0, near: 0, name: 0, terminal: 0, isolated: 0 };
  // 1. same parent station (sanity-capped: a parent that spans more than maxSpanParent is not one station)
  const byParent = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const p = stops[i]!.parent;
    if (!p) continue;
    const j = byParent.get(p);
    if (j === undefined) byParent.set(p, i);
    else if (uf.find(i) !== uf.find(j) && uf.union(j, i, opts.maxSpanParent)) bySignal.parent++;
  }
  // 2. candidate pairs from a grid (cells of ~0.004°)
  const norm = stops.map((s) => normalizeStopName(s.name));
  const term = stops.map((s) => !s.rail && isTerminalName(s.name));
  const cell = 0.004;
  const key = (x: number, y: number) => (x + 40000) * 100000 + (y + 40000);
  const grid = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const k = key(Math.floor(lons[i]! / cell), Math.floor(lats[i]! / cell));
    const a = grid.get(k);
    if (a) a.push(i);
    else grid.set(k, [i]);
  }
  const maxR = Math.max(opts.nameM, opts.busNameM, opts.terminalM, opts.isolatedM, opts.isolationM);
  const crowd = new Int32Array(n);
  const ei = new IntVec(), ej = new IntVec(), ed = new IntVec(), es = new IntVec();
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(lons[i]! / cell), cy = Math.floor(lats[i]! / cell);
    const spanY = Math.ceil(maxR / 111_000 / cell);
    const spanX = Math.ceil(maxR / (111_000 * Math.max(0.2, Math.cos((lats[i]! * Math.PI) / 180))) / cell);
    for (let dx = -spanX; dx <= spanX; dx++)
      for (let dy = -spanY; dy <= spanY; dy++) {
        const arr = grid.get(key(cx + dx, cy + dy));
        if (!arr) continue;
        for (const j of arr) {
          if (j <= i) continue;
          const d = fastDist(lons[i]!, lats[i]!, lons[j]!, lats[j]!);
          if (d > maxR) continue;
          const sim = normSimilarity(norm[i]!, norm[j]!);
          if (d <= opts.nearM && d > opts.sureM && sim < 0.6) {
            crowd[i]!++;
            crowd[j]!++;
          }
          ei.push(i);
          ej.push(j);
          ed.push(Math.round(d));
          es.push(Math.round(sim * 100));
        }
      }
  }
  // adjacency (edge indices per stop) for the isolation test
  const deg = new Int32Array(n + 1);
  for (let e = 0; e < ei.n; e++) {
    deg[ei.a[e]! + 1]!++;
    deg[ej.a[e]! + 1]!++;
  }
  for (let i = 0; i < n; i++) deg[i + 1]! += deg[i]!;
  const adj = new Int32Array(deg[n]!);
  const fill = deg.slice(0, n);
  for (let e = 0; e < ei.n; e++) {
    adj[fill[ei.a[e]!]!++] = e;
    adj[fill[ej.a[e]!]!++] = e;
  }
  /** Is the pair alone: no stop of another station with a different name within isolationM of either? */
  const isolated = (i: number, j: number): boolean => {
    const ri = uf.find(i), rj = uf.find(j);
    for (const x of [i, j])
      for (let q = deg[x]!; q < deg[x + 1]!; q++) {
        const e = adj[q]!;
        if (ed.a[e]! <= opts.sureM || ed.a[e]! > opts.isolationM || es.a[e]! >= 60) continue;
        const k = ei.a[e] === x ? ej.a[e]! : ei.a[e]!;
        const rk = uf.find(k);
        if (rk !== ri && rk !== rj) return false;
      }
    return true;
  };
  // 3. classify and apply, strongest signal first, then nearest first
  const ORDER: Record<string, number> = { near: 0, name: 1, terminal: 2, isolated: 3 };
  const info = (e: number, iso: boolean): PairInfo => {
    const i = ei.a[e]!, j = ej.a[e]!;
    return { d: ed.a[e]!, sim: es.a[e]! / 100, railA: stops[i]!.rail, railB: stops[j]!.rail, termA: term[i]!, termB: term[j]!, crowdA: crowd[i]!, crowdB: crowd[j]!, isolated: iso };
  };
  const edges: { e: number; d: number; sig: Exclude<MergeSignal, "parent"> }[] = [];
  const lateEdges: { e: number; d: number }[] = [];
  for (let e = 0; e < ei.n; e++) {
    if (uf.find(ei.a[e]!) === uf.find(ej.a[e]!)) continue;
    const sig = classifyPair(info(e, false), opts);
    if (sig) edges.push({ e, d: ed.a[e]!, sig });
    else if (classifyPair(info(e, true), opts) === "isolated") lateEdges.push({ e, d: ed.a[e]! });
  }
  edges.sort((a, b) => ORDER[a.sig]! - ORDER[b.sig]! || a.d - b.d || a.e - b.e);
  for (const x of edges) {
    const i = ei.a[x.e]!, j = ej.a[x.e]!;
    if (uf.find(i) === uf.find(j)) continue;
    if (uf.union(i, j, x.sig === "near" ? opts.maxSpan : opts.maxSpanName)) bySignal[x.sig]++;
  }
  // isolated pairs last: whether a pair is alone depends on what the stronger signals have merged already
  lateEdges.sort((a, b) => a.d - b.d || a.e - b.e);
  for (const x of lateEdges) {
    const i = ei.a[x.e]!, j = ej.a[x.e]!;
    if (uf.find(i) === uf.find(j) || !isolated(i, j)) continue;
    if (uf.union(i, j, opts.maxSpanName)) bySignal.isolated++;
  }
  const stationOf = new Int32Array(n);
  const ids = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    let id = ids.get(r);
    if (id === undefined) ids.set(r, (id = ids.size));
    stationOf[i] = id;
  }
  return { stationOf, count: ids.size, bySignal };
}

/**
 * Pick display name + coordinate for a station from its member stops. Platform / track / stand
 * qualifiers are removed first ("Paddington (Platform 6)" → "Paddington"), so that stops of one
 * station that only differ by platform count as the same name (and back each other up slightly).
 */
export function describeStation(members: StopIn[], cityName = ""): { name: string; lon: number; lat: number } {
  const anyRail = members.some((m) => m.rail);
  const pool = anyRail ? members.filter((m) => m.rail) : members;
  const cityFold = cityName ? fold(cityName).split(/[^a-z0-9]+/)[0]! : "";
  // score every stop by its platform-free name (as before: shorter, rail, city prefix and busy stops win);
  // stops that share a name back each other up a little ("most common name")
  const byName = new Map<string, { q: number; n: number }>();
  for (const m of pool) {
    const nm = stripPlatform(sanitizeName(m.name));
    let q = nameQuality(nm, m.rail) - Math.min(10, Math.log2(1 + m.weight));
    if (/^(S\+U|S|U)\s/.test(nm) || /\sBhf\.?$/.test(nm)) q += 25;
    if (cityFold && fold(nm).startsWith(cityFold)) q -= 10;
    const e = byName.get(nm);
    if (e) {
      e.n++;
      e.q = Math.min(e.q, q);
    } else byName.set(nm, { q, n: 1 });
  }
  let best = stripPlatform(sanitizeName(pool[0]!.name));
  let bestQ = Infinity;
  for (const [nm, e] of byName) {
    const score = e.q - Math.min(2, e.n - 1);
    if (score < bestQ) {
      bestQ = score;
      best = nm;
    }
  }
  // coordinate: weighted mean of the preferred pool
  let sx = 0, sy = 0, sw = 0;
  for (const m of pool) {
    const w = 1 + m.weight;
    sx += m.lon * w;
    sy += m.lat * w;
    sw += w;
  }
  return { name: cleanStationName(best, cityName, anyRail), lon: sx / sw, lat: sy / sw };
}

/** Clean VBB-style names ("S+U Gesundbrunnen Bhf" → "Berlin Gesundbrunnen") and ALL-CAPS names. */
export function cleanStationName(name: string, cityName: string, rail: boolean): string {
  let n = prettifyName(name);
  const m = /^(?:S\+U|S|U)\s+(.+?)(?:\s+Bhf\.?)?$/.exec(n);
  if (m) {
    n = m[1]!;
    if (rail && cityName && !fold(n).includes(fold(cityName))) n = `${cityName} ${n}`;
  }
  return n;
}

/** Walking minutes between two stations (see packages/shared/src/walk.ts). */
export { walkMinutes } from "@etbm/shared";
