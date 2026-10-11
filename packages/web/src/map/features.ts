/**
 * GeoJSON builders for the network layers. Corridors are drawn as bundles of
 * per-category lines placed side by side with line-offset; because categories
 * appear at different zooms, offsets are precomputed per LOD level so a bundle
 * stays centred whatever subset is visible.
 */
import { Cat } from "@etbm/shared";
import type * as GeoJSON from "geojson";
import type { City, Station } from "@etbm/shared";
import type { CorridorExt } from "../data/net.ts";
import { CAT_ORDER, effectiveCats, type Filters } from "../logic/filters.ts";
import { LEVELS, STATION_ZOOM, catWidth, cityTierZoom, corridorMinZoom, haversineKm, isLongHop, levelIndex, stationLevel } from "./lod.ts";

type FC = GeoJSON.FeatureCollection;

/** The subset of the network the map builders need (also built inside the worker). */
export interface MapNet {
  cities: City[];
  corridors: CorridorExt[];
  hasDtCats: boolean;
  file: { stations: Station[] };
}
type Net = MapNet;
type Feature = GeoJSON.Feature;
type Pos = [number, number];

/** Gap between bundled lines, in width units. */
export const GAP = 0.3;

const catIndex = (k: number) => CAT_ORDER.indexOf(k as (typeof CAT_ORDER)[number]);

/** Static per-network lookups (computed once). */
export interface NetIndex {
  lenKm: Float32Array;
  /** minLon, minLat, maxLon, maxLat per corridor */
  bbox: Float32Array;
  /** whether to reverse coords so bundles keep a consistent side order */
  flip: Uint8Array;
  /** station → rank within its city */
  stationRank: Int32Array;
}

export function buildNetIndex(net: Net): NetIndex {
  const n = net.corridors.length;
  const lenKm = new Float32Array(n);
  const bbox = new Float32Array(n * 4);
  const flip = new Uint8Array(n);
  for (const c of net.corridors) {
    const co = c.coords;
    const p0 = co[0]!;
    const p1 = co[co.length - 1]!;
    lenKm[c.id] = haversineKm(p0, p1);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of co) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    bbox.set([x0, y0, x1, y1], c.id * 4);
    const dx = (p1[0] - p0[0]) * Math.cos((((p0[1] + p1[1]) / 2) * Math.PI) / 180);
    const dy = p1[1] - p0[1];
    flip[c.id] = (Math.abs(dx) >= Math.abs(dy) ? dx < 0 : dy < 0) ? 1 : 0;
  }
  const stationRank = new Int32Array(net.file.stations.length);
  for (const c of net.cities) c.stations.forEach((s, i) => (stationRank[s] = i));
  return { lenKm, bbox, flip, stationRank };
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
  /** per city: zoom at which its first visible corridor appears (Infinity = none) */
  cityMinZoom: Float32Array;
  /** per city: max bundle width (units) of incident corridors visible by z 7.5 */
  cityWidth: Float32Array;
}

/** The whole network under the current filters (rebuilt only when filters change). */
export function baseCorridorData(net: Net, idx: NetIndex, f: Filters): BaseData {
  const lines: Feature[] = [];
  const casing: Feature[] = [];
  const hops: Feature[] = [];
  const cityMinZoom = new Float32Array(net.cities.length).fill(Infinity);
  const cityWidth = new Float32Array(net.cities.length);
  const midLevel = levelIndex(7.5);
  for (const c of net.corridors) {
    if (c.coords.length < 2) continue;
    const cats = visibleCats(net, c, f);
    if (!cats) continue;
    const coords = idx.flip[c.id] ? [...c.coords].reverse() : c.coords;
    const len = idx.lenKm[c.id]!;
    const present = CAT_ORDER.filter((k) => cats & k);
    if (isLongHop(len, c.snapped)) {
      for (const k of present) {
        hops.push({ type: "Feature", properties: { cid: c.id, cat: k, w: catWidth(k, c.tpd[k] ?? 0) }, geometry: { type: "LineString", coordinates: coords } });
      }
      continue;
    }
    const minz = present.map((k) => levelIndex(corridorMinZoom(k, c.tpd[k] ?? 0, len, c.snapped)));
    const widths = present.map((k) => catWidth(k, c.tpd[k] ?? 0, c.snapped));
    const lzMin = Math.min(...minz);
    // offsets at each level from lzMin; `o`/`t` = final (all visible), oK/tK overrides
    const final = pack(widths);
    const perCat: Record<string, number>[] = present.map(() => ({}));
    const casingProps: Record<string, number> = { cid: c.id, lz: lzMin, t: final.total };
    for (let L = lzMin; L < LEVELS.length; L++) {
      const vis = present.map((_, i) => minz[i]! <= L);
      if (vis.every(Boolean)) break;
      const p = pack(widths.filter((_, i) => vis[i]));
      let j = 0;
      present.forEach((_, i) => {
        if (vis[i]) perCat[i]![`o${L}`] = p.offsets[j++]!;
      });
      casingProps[`t${L}`] = p.total;
      if (L === midLevel) cityWidthUpdate(c, p.total);
    }
    if (midLevel >= lzMin && !(`t${midLevel}` in casingProps)) cityWidthUpdate(c, minz.every((m) => m <= midLevel) ? final.total : 0);
    present.forEach((k, i) => {
      lines.push({
        type: "Feature",
        properties: { cid: c.id, cat: k, w: round2(widths[i]!), lz: minz[i], o: final.offsets[i], k: c.tpd[k] ?? 0, u: c.snapped ? 0 : 1, ...perCat[i] },
        geometry: { type: "LineString", coordinates: coords },
      });
    });
    casing.push({ type: "Feature", properties: casingProps, geometry: { type: "LineString", coordinates: coords } });
    const z = LEVELS[lzMin]!;
    if (z < cityMinZoom[c.a]!) cityMinZoom[c.a] = z;
    if (z < cityMinZoom[c.b]!) cityMinZoom[c.b] = z;
  }
  function cityWidthUpdate(c: CorridorExt, w: number) {
    if (w > cityWidth[c.a]!) cityWidth[c.a] = w;
    if (w > cityWidth[c.b]!) cityWidth[c.b] = w;
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
 * Geometry ending at the corridor's real stations (sa/sb) instead of the city
 * point: cut the polyline at its closest approach to each station.
 */
export function stationGeometry(net: Net, c: CorridorExt): Pos[] {
  const co = c.coords;
  let start = 0;
  let end = co.length - 1;
  const head: Pos[] = [];
  const tail: Pos[] = [];
  const st = net.file.stations;
  const near = (p: Pos, q: Pos) => (p[0] - q[0]) ** 2 * Math.cos((q[1] * Math.PI) / 180) ** 2 + (p[1] - q[1]) ** 2;
  if (c.sa !== undefined && st[c.sa]) {
    const s: Pos = [st[c.sa]!.lon, st[c.sa]!.lat];
    let best = 0;
    for (let i = 0; i < co.length / 2; i++) if (near(co[i]!, s) < near(co[best]!, s)) best = i;
    start = best + 1;
    head.push(s);
  }
  if (c.sb !== undefined && st[c.sb]) {
    const s: Pos = [st[c.sb]!.lon, st[c.sb]!.lat];
    let best = co.length - 1;
    for (let i = co.length - 1; i >= co.length / 2; i--) if (near(co[i]!, s) < near(co[best]!, s)) best = i;
    end = best - 1;
    tail.push(s);
  }
  if (!head.length) head.push(co[0]!);
  if (!tail.length) tail.push(co[co.length - 1]!);
  return [...head, ...co.slice(start, Math.max(start, end + 1)), ...tail];
}

/** Station-level corridors (z ≥ STATION_ZOOM) inside a bounding box. */
export function stationCorridorData(net: Net, idx: NetIndex, f: Filters, bounds: [number, number, number, number]): { lines: FC; casing: FC } {
  const lines: Feature[] = [];
  const casing: Feature[] = [];
  const [x0, y0, x1, y1] = bounds;
  for (const c of net.corridors) {
    const b = c.id * 4;
    if (idx.bbox[b]! > x1 || idx.bbox[b + 2]! < x0 || idx.bbox[b + 1]! > y1 || idx.bbox[b + 3]! < y0) continue;
    const cats = visibleCats(net, c, f);
    if (!cats) continue;
    const present = CAT_ORDER.filter((k) => cats & k);
    if (isLongHop(idx.lenKm[c.id]!, c.snapped)) {
      const g = stationGeometry(net, c);
      const coords = [g[0]!, g[g.length - 1]!];
      for (const k of present) lines.push({ type: "Feature", properties: { cid: c.id, cat: k, w: 1, o: 0, k: 0, hop: 1 }, geometry: { type: "LineString", coordinates: coords } });
      continue;
    }
    let coords = stationGeometry(net, c);
    if (idx.flip[c.id]) coords = coords.reverse();
    const widths = present.map((k) => catWidth(k, c.tpd[k] ?? 0, c.snapped));
    const p = pack(widths);
    present.forEach((k, i) => lines.push({ type: "Feature", properties: { cid: c.id, cat: k, w: widths[i], o: p.offsets[i], k: c.tpd[k] ?? 0, hop: 0, u: c.snapped ? 0 : 1 }, geometry: { type: "LineString", coordinates: coords } }));
    casing.push({ type: "Feature", properties: { cid: c.id, t: p.total }, geometry: { type: "LineString", coordinates: coords } });
  }
  return { lines: { type: "FeatureCollection", features: lines }, casing: { type: "FeatureCollection", features: casing } };
}

/** Highlighted corridors (selection): only the given categories, always visible. */
export function highlightData(net: Net, idx: NetIndex, hl: Map<number, number>): { lines: FC; casing: FC } {
  const lines: Feature[] = [];
  const casing: Feature[] = [];
  for (const [cid, cats] of hl) {
    const c = net.corridors[cid];
    if (!c || c.coords.length < 2) continue;
    const present = CAT_ORDER.filter((k) => cats & k);
    if (!present.length) continue;
    const hop = isLongHop(idx.lenKm[cid]!, c.snapped) ? 1 : 0;
    const widths = present.map((k) => Math.max(1.6, catWidth(k, c.tpd[k] ?? 0, c.snapped)));
    const p = pack(widths);
    for (const g of hop ? [0] : [0, 1]) {
      let coords = g ? stationGeometry(net, c) : c.coords;
      if (idx.flip[cid]) coords = [...coords].reverse();
      present.forEach((k, i) =>
        lines.push({ type: "Feature", properties: { cid, cat: k, w: widths[i], o: hop ? 0 : p.offsets[i], g, hop, k: c.tpd[k] ?? 0 }, geometry: { type: "LineString", coordinates: coords } }),
      );
      if (!hop) casing.push({ type: "Feature", properties: { cid, t: p.total, g }, geometry: { type: "LineString", coordinates: coords } });
    }
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
