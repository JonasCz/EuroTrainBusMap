import { fastDist } from "../util/geo.ts";
import { fold, nameSimilarity, nameQuality, prettifyName } from "./names.ts";

export interface StopIn {
  lon: number;
  lat: number;
  name: string;
  rail: boolean;
  /** Group key for same parent_station (e.g. "feed:parentKey"), or null. */
  parent: string | null;
  feed: number;
  city: number;
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

export interface MergeOptions {
  /** Same-name merge radius (m). */
  nameRadius: number;
  /** Rail-rail merge radius regardless of name (m). */
  railRadius: number;
  /** Rail-rail merge radius when names are similar (m). */
  railNameRadius: number;
  /** Max distance between cluster centroids when merging (m). */
  maxSpan: number;
}

export const DEFAULT_MERGE: MergeOptions = { nameRadius: 250, railRadius: 150, railNameRadius: 400, maxSpan: 600 };

/**
 * Merge stops into stations within each city. Returns station index per stop
 * (dense 0..n-1) and the number of stations.
 */
export function mergeStations(stops: StopIn[], opts: MergeOptions = DEFAULT_MERGE): { stationOf: Int32Array; count: number } {
  const n = stops.length;
  const lons = Float64Array.from(stops, (s) => s.lon), lats = Float64Array.from(stops, (s) => s.lat);
  const uf = new UF(n, lons, lats);
  // 1. same parent station
  const byParent = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const p = stops[i]!.parent;
    if (!p) continue;
    const j = byParent.get(p);
    if (j === undefined) byParent.set(p, i);
    else uf.union(j, i, 0);
  }
  // 2. proximity within the same city (grid of ~0.005° cells)
  const cell = 0.005;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number) => `${x},${y}`;
  for (let i = 0; i < n; i++) {
    const k = key(Math.floor(lons[i]! / cell), Math.floor(lats[i]! / cell));
    let a = grid.get(k);
    if (!a) grid.set(k, (a = []));
    a.push(i);
  }
  const maxR = Math.max(opts.nameRadius, opts.railNameRadius, opts.railRadius);
  // Process rail first so bus stops attach to rail clusters.
  const order = [...Array(n).keys()].sort((a, b) => Number(stops[b]!.rail) - Number(stops[a]!.rail) || stops[b]!.weight - stops[a]!.weight);
  const span = Math.ceil(maxR / 1000 / 111 / cell / Math.cos((50 * Math.PI) / 180)) + 1;
  for (const i of order) {
    const s = stops[i]!;
    const cx = Math.floor(lons[i]! / cell), cy = Math.floor(lats[i]! / cell);
    for (let dx = -span; dx <= span; dx++)
      for (let dy = -span; dy <= span; dy++) {
        const arr = grid.get(key(cx + dx, cy + dy));
        if (!arr) continue;
        for (const j of arr) {
          if (j === i) continue;
          const t = stops[j]!;
          if (t.city !== s.city) continue;
          const d = fastDist(s.lon, s.lat, t.lon, t.lat);
          if (d > maxR) continue;
          if (uf.find(i) === uf.find(j)) continue;
          let ok = false;
          if (s.rail && t.rail) {
            if (d <= opts.railRadius && s.feed !== t.feed) ok = true;
            else if (d <= opts.railNameRadius && nameSimilarity(s.name, t.name) >= 0.5) ok = true;
          }
          if (!ok && d <= opts.nameRadius && nameSimilarity(s.name, t.name) >= 0.6) ok = true;
          if (ok) uf.union(i, j, opts.maxSpan);
        }
      }
  }
  const stationOf = new Int32Array(n);
  const ids = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    let id = ids.get(r);
    if (id === undefined) ids.set(r, (id = ids.size));
    stationOf[i] = id;
  }
  return { stationOf, count: ids.size };
}

/** Pick display name + coordinate for a station from its member stops. */
export function describeStation(members: StopIn[], cityName = ""): { name: string; lon: number; lat: number } {
  const anyRail = members.some((m) => m.rail);
  const pool = anyRail ? members.filter((m) => m.rail) : members;
  let best = pool[0]!;
  let bestQ = Infinity;
  const cityFold = cityName ? fold(cityName).split(/[^a-z0-9]+/)[0]! : "";
  for (const m of pool) {
    let q = nameQuality(m.name, m.rail) - Math.min(10, Math.log2(1 + m.weight));
    if (/^(S\+U|S|U)\s/.test(m.name) || /\sBhf\.?$/.test(m.name)) q += 25;
    if (cityFold && fold(m.name).startsWith(cityFold)) q -= 10;
    if (q < bestQ) {
      bestQ = q;
      best = m;
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
  return { name: cleanStationName(best.name, cityName, best.rail), lon: sx / sw, lat: sy / sw };
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

/** Walking minutes between two stations: ceil(dist·1.3 / 75 m/min) + 3 min buffer. */
export function walkMinutes(distM: number): number {
  return Math.ceil((distM * 1.3) / 75) + 3;
}
