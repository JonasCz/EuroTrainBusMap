/**
 * GeoJSON builders for the network layers. The base network is drawn from
 * line-graph *segments* (NetworkFile.segments): each piece of track/road once,
 * with the aggregated traffic of all corridors using it. A segment is a bundle
 * of per-category lines placed side by side with line-offset; because
 * categories appear at different zooms, offsets are precomputed per LOD level
 * so a bundle stays centred whatever subset is visible. Segments are oriented
 * consistently by the ETL, so offsets line up at joins.
 */
import { Cat } from "@etbm/shared";
import type * as GeoJSON from "geojson";
import type { City, Segment, Station } from "@etbm/shared";
import type { CorridorExt } from "../data/net.ts";
import { CAT_ORDER, effectiveCats, type Filters } from "../logic/filters.ts";
import { LEVELS, STATION_ZOOM, catWidth, cityTierZoom, corridorMinZoom, haversineKm, isLongHop, levelIndex, stationLevel } from "./lod.ts";

type FC = GeoJSON.FeatureCollection;

/** The subset of the network the map builders need (also built inside the worker). */
export interface MapNet {
  cities: City[];
  corridors: CorridorExt[];
  /** Line-graph segments (synthesised 1:1 from corridors for data without segments). */
  segments: Segment[];
  hasDtCats: boolean;
  file: { stations: Station[] };
}
type Net = MapNet;
type Feature = GeoJSON.Feature;
type Pos = [number, number];

/** Gap between bundled lines, in width units. */
export const GAP = 0.3;

const segId = (code: number) => (code >= 0 ? code : -code - 1);

/**
 * Segments of a network file; for data without a line graph every corridor
 * becomes its own segment (and gets `segs = [id]`).
 */
export function netSegments(file: { corridors: CorridorExt[]; segments?: Segment[] }): Segment[] {
  if (file.segments?.length) return file.segments;
  return file.corridors.map((c) => {
    c.segs = [c.id];
    const s: Segment = { id: c.id, coords: c.coords, cats: c.cats, tpd: c.tpd, snapped: c.snapped };
    if (c.dtCats !== undefined) s.dtCats = c.dtCats;
    return s;
  });
}

/** Static per-network lookups (computed once). */
export interface NetIndex {
  /** per corridor: straight-line length a→b (km) */
  lenKm: Float32Array;
  /** per corridor: minLon, minLat, maxLon, maxLat */
  bbox: Float32Array;
  /** per segment: longest corridor (km) using it (drives the LOD rules) */
  segLen: Float32Array;
  /** per segment: Cat bits whose corridors are all inside Germany (D-Ticket heuristic without dtCats) */
  segDe: Uint8Array;
  /**
   * per segment: lies between a city point and the station of every corridor using it
   * (a "lead-in"); not drawn at station zoom, where corridors are drawn to their stations.
   */
  segTerm: Uint8Array;
  /** per corridor: index (in `segs`) of the segment closest to the station at the a / b end */
  cutA: Int32Array;
  cutB: Int32Array;
  /**
   * per segment × category (CAT_ORDER index): earliest LOD level of the corridors using it
   * (corridor rules on corridor trips/day), so a corridor appears as a whole and lines do not
   * break into fragments when the aggregated traffic of a short shared piece is higher.
   */
  segLevel: Int8Array;
  /** station → rank within its city */
  stationRank: Int32Array;
}

export function buildNetIndex(net: Net): NetIndex {
  const n = net.corridors.length;
  const lenKm = new Float32Array(n);
  const bbox = new Float32Array(n * 4);
  const nS = net.segments.length;
  const segLen = new Float32Array(nS);
  const segDe = new Uint8Array(nS).fill(15);
  const segTerm = new Uint8Array(nS).fill(255);
  const cutA = new Int32Array(n), cutB = new Int32Array(n);
  const NC = CAT_ORDER.length;
  const segLevel = new Int8Array(nS * NC).fill(127);
  for (const c of net.corridors) {
    const co = c.coords;
    const p0 = co[0]!;
    const p1 = co[co.length - 1]!;
    const len = haversineKm(p0, p1);
    lenKm[c.id] = len;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of co) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    bbox.set([x0, y0, x1, y1], c.id * 4);
    const de = net.cities[c.a]!.country === "DE" && net.cities[c.b]!.country === "DE";
    const segs = c.segs ?? [];
    const [ka, kb] = cutIndices(net, c);
    cutA[c.id] = ka;
    cutB[c.id] = kb;
    const lv = CAT_ORDER.map((k) => (c.cats & k ? levelIndex(corridorMinZoom(k, c.tpd[k] ?? 0, len, c.snapped)) : 127));
    segs.forEach((code, i) => {
      const s = segId(code);
      for (let k = 0; k < NC; k++) if (lv[k]! < segLevel[s * NC + k]!) segLevel[s * NC + k] = lv[k]!;
      if (len > segLen[s]!) segLen[s] = len;
      if (!de) segDe[s]! &= ~c.cats;
      if (i > ka && i < kb) segTerm[s] = 0; // interior for some corridor
      else if (segTerm[s] === 255) segTerm[s] = 1;
    });
  }
  for (let i = 0; i < nS; i++) if (segTerm[i] === 255) segTerm[i] = 0;
  const stationRank = new Int32Array(net.file.stations.length);
  for (const c of net.cities) c.stations.forEach((s, i) => (stationRank[s] = i));
  return { lenKm, bbox, segLen, segDe, segTerm, cutA, cutB, segLevel, stationRank };
}

/** Squared planar distance helper around latitude `lat`. */
function d2(p: Pos, q: Pos): number {
  const k = Math.cos((q[1] * Math.PI) / 180);
  return ((p[0] - q[0]) * k) ** 2 + (p[1] - q[1]) ** 2;
}

/**
 * Segment indices (in c.segs) where the corridor passes closest to its station at the a end
 * (searched in the first half) and at the b end (second half).
 */
function cutIndices(net: Net, c: CorridorExt): [number, number] {
  const segs = c.segs ?? [];
  const n = segs.length;
  if (n <= 1) return [0, Math.max(0, n - 1)];
  const best = (stId: number | undefined, from: number, to: number, dflt: number) => {
    const st = stId !== undefined ? net.file.stations[stId] : undefined;
    if (!st) return dflt;
    const p: Pos = [st.lon, st.lat];
    let bi = dflt, bd = Infinity;
    for (let i = from; i <= to; i++) {
      for (const q of net.segments[segId(segs[i]!)]?.coords ?? []) {
        const d = d2(q, p);
        if (d < bd) [bi, bd] = [i, d];
      }
    }
    return bi;
  };
  const half = Math.floor((n - 1) / 2);
  const ka = best(c.sa, 0, half, 0);
  const kb = best(c.sb, Math.max(ka, n - 1 - half), n - 1, n - 1);
  return [ka, Math.max(ka, kb)];
}

/** Cat bits of a corridor visible under the filter. */
export function visibleCats(net: Net, c: CorridorExt, f: Filters): number {
  let cats = c.cats & effectiveCats(f);
  if (f.dticket) {
    if (net.hasDtCats) cats &= c.dtCats ?? 0;
    else if (net.cities[c.a]!.country !== "DE" || net.cities[c.b]!.country !== "DE") cats = 0;
  }
  return cats;
}

/** Cat bits of a segment visible under the filter. */
export function visibleSegCats(net: Net, idx: NetIndex, s: Segment, f: Filters): number {
  let cats = s.cats & effectiveCats(f);
  if (f.dticket) cats &= net.hasDtCats ? (s.dtCats ?? 0) : idx.segDe[s.id]!;
  return cats;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Offsets (centre of each line) for a bundle of widths. */
function pack(widths: number[]): { offsets: number[]; total: number } {
  const total = widths.reduce((s, w) => s + w, 0) + GAP * Math.max(0, widths.length - 1);
  let acc = -total / 2;
  const offsets = widths.map((w) => {
    const o = acc + w / 2;
    acc += w + GAP;
    return round2(o);
  });
  return { offsets, total: round2(total) };
}

export interface BaseData {
  lines: FC;
  casing: FC;
  hops: FC;
  /** per city: zoom at which its first visible line appears (Infinity = none) */
  cityMinZoom: Float32Array;
  /** per city: max bundle width (units) of incident lines visible by z 7.5 */
  cityWidth: Float32Array;
}

/** Bundle features of one segment (shared by the base network and the highlight). */
function segmentBundle(
  idx: NetIndex,
  s: Segment,
  cats: number,
  tpd: (k: number) => number,
  len: number,
  coords: Pos[],
  extra: Record<string, number>,
  lines: Feature[],
  casing: Feature[] | null,
  minWidth = 0,
): { lzMin: number; midTotal: number } {
  const present = CAT_ORDER.filter((k) => cats & k);
  const NC = CAT_ORDER.length;
  const minz = present.map((k) => {
    const users = idx.segLevel[s.id * NC + CAT_ORDER.indexOf(k as (typeof CAT_ORDER)[number])]!;
    // long-distance trunks may appear earlier on their aggregated traffic
    const agg = k === Cat.LongDistance ? levelIndex(corridorMinZoom(k, tpd(k), len, s.snapped)) : 127;
    return Math.min(users, agg, LEVELS.length - 1);
  });
  const widths = present.map((k) => Math.max(minWidth, catWidth(k, tpd(k), s.snapped)));
  const lzMin = Math.min(...minz);
  const midLevel = levelIndex(7.5);
  const final = pack(widths);
  const perCat: Record<string, number>[] = present.map(() => ({}));
  const casingProps: Record<string, number> = { ...extra, lz: lzMin, t: final.total };
  let midTotal = minz.every((m) => m <= midLevel) ? final.total : 0;
  for (let L = lzMin; L < LEVELS.length; L++) {
    const vis = present.map((_, i) => minz[i]! <= L);
    if (vis.every(Boolean)) break;
    const p = pack(widths.filter((_, i) => vis[i]));
    let j = 0;
    present.forEach((_, i) => {
      if (vis[i]) perCat[i]![`o${L}`] = p.offsets[j++]!;
    });
    casingProps[`t${L}`] = p.total;
    if (L === midLevel) midTotal = p.total;
  }
  present.forEach((k, i) => {
    lines.push({
      type: "Feature",
      properties: { ...extra, cat: k, w: round2(widths[i]!), lz: minz[i], o: final.offsets[i], k: tpd(k), u: s.snapped ? 0 : 1, ...perCat[i] },
      geometry: { type: "LineString", coordinates: coords },
    });
  });
  casing?.push({ type: "Feature", properties: casingProps, geometry: { type: "LineString", coordinates: coords } });
  return { lzMin, midTotal };
}

/** The whole network under the current filters (rebuilt only when filters change). */
export function baseCorridorData(net: Net, idx: NetIndex, f: Filters): BaseData {
  const lines: Feature[] = [];
  const casing: Feature[] = [];
  const hops: Feature[] = [];
  const cityMinZoom = new Float32Array(net.cities.length).fill(Infinity);
  const cityWidth = new Float32Array(net.cities.length);
  const segLz = new Int8Array(net.segments.length).fill(-1);
  const segMid = new Float32Array(net.segments.length);
  for (const s of net.segments) {
    if (s.coords.length < 2) continue;
    const cats = visibleSegCats(net, idx, s, f);
    if (!cats) continue;
    const len = idx.segLen[s.id]!;
    if (isLongHop(len, s.snapped)) {
      for (const k of CAT_ORDER) {
        if (cats & k) hops.push({ type: "Feature", properties: { sid: s.id, cat: k, w: catWidth(k, s.tpd[k as keyof typeof s.tpd] ?? 0) }, geometry: { type: "LineString", coordinates: s.coords } });
      }
      continue;
    }
    const r = segmentBundle(idx, s, cats, (k) => s.tpd[k as keyof typeof s.tpd] ?? 0, len, s.coords, { sid: s.id, term: idx.segTerm[s.id]! }, lines, casing);
    segLz[s.id] = r.lzMin;
    segMid[s.id] = r.midTotal;
  }
  // cities: zoom/width from the segments touching them
  for (const c of net.corridors) {
    const segs = c.segs;
    if (!segs?.length || !visibleCats(net, c, f)) continue;
    for (const [city, code] of [[c.a, segs[0]!], [c.b, segs[segs.length - 1]!]] as const) {
      const s = segId(code);
      if (segLz[s]! < 0) continue;
      const z = LEVELS[segLz[s]!]!;
      if (z < cityMinZoom[city]!) cityMinZoom[city] = z;
      if (segMid[s]! > cityWidth[city]!) cityWidth[city] = segMid[s]!;
    }
  }
  return {
    lines: { type: "FeatureCollection", features: lines },
    casing: { type: "FeatureCollection", features: casing },
    hops: { type: "FeatureCollection", features: hops },
    cityMinZoom,
    cityWidth,
  };
}

/**
 * End piece of a corridor at station zoom: its first (end = "a") or last
 * ("b") segment, cut at the closest approach to the corridor's station and
 * joined to it. Returned in the segment's own orientation, so bundle offsets
 * match the neighbouring segments.
 */
export function terminalGeometry(net: Net, idx: NetIndex, c: CorridorExt, end: "a" | "b"): { sid: number; coords: Pos[] } | null {
  const segs = c.segs;
  if (!segs?.length) return null;
  const ka = idx.cutA[c.id]!, kb = idx.cutB[c.id]!;
  if (end === "b" && ka === kb) return null; // one piece cut at both ends (returned for "a")
  const k = end === "a" ? ka : kb;
  const code = segs[k]!;
  const sid = segId(code);
  const co = net.segments[sid]?.coords;
  if (!co || co.length < 2) return null;
  // work in travel direction a→b, then return in the segment's own orientation
  let p: Pos[] = code >= 0 ? [...co] : [...co].reverse();
  const station = (id: number | undefined): Pos | null => {
    const st = id !== undefined ? net.file.stations[id] : undefined;
    return st ? [st.lon, st.lat] : null;
  };
  const nearest = (q: Pos) => {
    let best = 0;
    for (let i = 1; i < p.length; i++) if (d2(p[i]!, q) < d2(p[best]!, q)) best = i;
    return best;
  };
  const sa = end === "a" ? station(c.sa) : null;
  const sb = end === "b" || ka === kb ? station(c.sb) : null;
  if (sa) p = [sa, ...p.slice(Math.min(nearest(sa), p.length - 1))];
  if (sb) p = [...p.slice(0, Math.max(nearest(sb), 1) + 1), sb];
  if (code < 0) p.reverse();
  return { sid, coords: p };
}

/**
 * Station-level end pieces (z ≥ STATION_ZOOM) inside a bounding box: for each
 * corridor end, the segment passing closest to its station, cut there and
 * joined to the station (interior segments come from the base network; lead-in
 * segments between city point and stations are not drawn at this zoom).
 */
export function stationCorridorData(net: Net, idx: NetIndex, f: Filters, bounds: [number, number, number, number]): { lines: FC; casing: FC } {
  const lines: Feature[] = [];
  const casing: Feature[] = [];
  const [x0, y0, x1, y1] = bounds;
  const done = new Set<string>();
  for (const c of net.corridors) {
    const b = c.id * 4;
    if (idx.bbox[b]! > x1 || idx.bbox[b + 2]! < x0 || idx.bbox[b + 1]! > y1 || idx.bbox[b + 3]! < y0) continue;
    if (!visibleCats(net, c, f)) continue;
    for (const end of ["a", "b"] as const) {
      const t = terminalGeometry(net, idx, c, end);
      if (!t) continue;
      const s = net.segments[t.sid]!;
      if (isLongHop(idx.segLen[s.id]!, s.snapped)) continue;
      const cats = visibleSegCats(net, idx, s, f);
      if (!cats) continue;
      const key = `${t.sid}:${end === "a" ? c.sa : c.sb}`;
      if (done.has(key)) continue;
      done.add(key);
      segmentBundle(idx, s, cats, (k) => s.tpd[k as keyof typeof s.tpd] ?? 0, idx.segLen[s.id]!, t.coords, { sid: s.id, hop: 0 }, lines, casing);
    }
  }
  return { lines: { type: "FeatureCollection", features: lines }, casing: { type: "FeatureCollection", features: casing } };
}

/**
 * Highlighted corridors (selection), drawn on their segments with the traffic
 * of the highlighted corridors only. g = 0: city-level geometry; g = 1:
 * station zoom (terminal segments re-drawn to the stations).
 */
export function highlightData(net: Net, idx: NetIndex, hl: Map<number, number>): { lines: FC; casing: FC } {
  const lines: Feature[] = [];
  const casing: Feature[] = [];
  // per segment: highlighted cats and summed trips/day
  const segCats = new Map<number, number>();
  const segTpd = new Map<number, Record<number, number>>();
  const terminals: { c: CorridorExt; end: "a" | "b"; cats: number }[] = [];
  const hlInterior = new Set<number>();
  for (const [cid, cats] of hl) {
    const c = net.corridors[cid];
    if (!c?.segs?.length || !cats) continue;
    const seen = new Set<number>();
    for (const code of c.segs) {
      const s = segId(code);
      if (seen.has(s)) continue;
      seen.add(s);
      segCats.set(s, (segCats.get(s) ?? 0) | cats);
      const t = segTpd.get(s) ?? {};
      for (const k of CAT_ORDER) if (cats & k && c.tpd[k]) t[k] = (t[k] ?? 0) + c.tpd[k]!;
      segTpd.set(s, t);
    }
    terminals.push({ c, end: "a", cats }, { c, end: "b", cats });
    const ka = idx.cutA[c.id]!, kb = idx.cutB[c.id]!;
    c.segs.forEach((code, i) => {
      if (i > ka && i < kb) hlInterior.add(segId(code));
    });
  }
  const hop = (s: Segment) => isLongHop(idx.segLen[s.id]!, s.snapped);
  for (const [sid, cats] of segCats) {
    const s = net.segments[sid]!;
    const tpd = segTpd.get(sid)!;
    if (hop(s)) {
      for (const k of CAT_ORDER) if (cats & k) lines.push({ type: "Feature", properties: { sid, cat: k, w: 1.6, o: 0, g: 0, hop: 1, k: tpd[k] ?? 0 }, geometry: { type: "LineString", coordinates: s.coords } });
      continue;
    }
    for (const g of hlInterior.has(sid) ? [0, 1] : [0]) segmentBundle(idx, s, cats, (k) => tpd[k] ?? 0, idx.segLen[sid]!, s.coords, { sid, g, hop: 0 }, lines, casing, 1.6);
  }
  const done = new Set<string>();
  for (const { c, end } of terminals) {
    const t = terminalGeometry(net, idx, c, end);
    if (!t) continue;
    const s = net.segments[t.sid]!;
    if (hop(s)) continue;
    const key = `${t.sid}:${end === "a" ? c.sa : c.sb}`;
    if (done.has(key)) continue;
    done.add(key);
    const tpd = segTpd.get(t.sid)!;
    segmentBundle(idx, s, segCats.get(t.sid)!, (k) => tpd[k] ?? 0, idx.segLen[t.sid]!, t.coords, { sid: t.sid, g: 1, hop: 0 }, lines, casing, 1.6);
  }
  return { lines: { type: "FeatureCollection", features: lines }, casing: { type: "FeatureCollection", features: casing } };
}

/** All cities with visible service, bucketed by LOD level (rebuilt on filter change). */
export function baseCityData(net: Net, bd: BaseData): FC {
  const features: Feature[] = [];
  for (const c of net.cities) {
    const z = bd.cityMinZoom[c.id]!;
    if (!Number.isFinite(z)) continue;
    const lz = levelIndex(Math.max(z, cityTierZoom(c.importance)));
    features.push({
      type: "Feature",
      id: c.id,
      properties: { id: c.id, name: c.name, imp: c.importance, lz, ns: c.stations.length, mw: round2(bd.cityWidth[c.id]!), rank: round2(1 - c.importance) },
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
    });
  }
  return { type: "FeatureCollection", features };
}

export interface Emphasis {
  /** Cities to emphasise (selection + reachable). */
  focus: Set<number>;
  /** When true, everything not in focus is greyed out. */
  active: boolean;
  origin?: number;
  dest?: number;
}

/** Selection layer: reachable cities as small dots, labels by importance. */
export function focusCityData(net: Net, em: Emphasis): FC {
  const features: Feature[] = [];
  for (const id of em.focus) {
    const c = net.cities[id];
    if (!c) continue;
    const sel = id === em.origin ? 1 : id === em.dest ? 2 : 0;
    features.push({
      type: "Feature",
      id,
      properties: {
        id,
        name: c.name,
        imp: c.importance,
        sel,
        // labels of reachable places appear ~2 levels earlier than in the base map
        // reachable places appear 1 (label) / 2 (dot) LOD levels earlier than in the base map
        lz: sel ? 0 : Math.max(0, levelIndex(cityTierZoom(c.importance)) - 1),
        dz: sel ? 0 : Math.max(0, levelIndex(cityTierZoom(c.importance)) - 2),
        rank: sel ? -1 : round2(1 - c.importance),
      },
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Stations (static), bucketed by importance within their city. */
export function stationData(net: Net, idx: NetIndex, only?: Set<number>): FC {
  const features: Feature[] = [];
  const st = net.file.stations;
  const cities = only ? [...only] : net.cities.map((c) => c.id);
  for (const cid of cities) {
    const c = net.cities[cid];
    if (!c) continue;
    for (const sid of c.stations) {
      const s = st[sid]!;
      const rank = idx.stationRank[sid]!;
      const lz = only ? 0 : stationLevel(s.cats, rank);
      features.push({
        type: "Feature",
        id: sid,
        properties: { name: shortStationName(s.name, c.name), city: s.city, lz, rail: s.cats & (Cat.LongDistance | Cat.Regional) ? 1 : 0, major: lz === 0 ? 1 : 0, rank: rank + (lz === 0 ? 0 : 100) },
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

/** "Berlin Hbf" → "Hbf" inside Berlin (the city name is shown as an area label). */
export function shortStationName(name: string, city: string): string {
  if (name.length > city.length + 1 && name.startsWith(city) && /[\s,\-–(/]/.test(name[city.length]!)) {
    const rest = name.slice(city.length).replace(/^[\s,\-–/]+/, "");
    if (rest.length >= 2) return rest;
  }
  return name;
}

export { STATION_ZOOM };
