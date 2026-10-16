/**
 * Map data derived from the network for fast, progressive loading:
 *
 *   core.json            CoreFile     – cities (+ timezones, tile index); everything the app needs to start
 *   stations.json        StationsFile – station names/coords/cats (lazy, needed once a city is selected)
 *   tiles/{z}/{x}/{y}.pbf.gz          – gzipped Mapbox vector tiles of the drawn network
 *                                       (layers seg, city; at the max zoom also term, st)
 *   geo/<shard>.json / geo/c<city>.json GeoFile – corridors (+ segment geometry) referenced by the
 *                                       patterns of one timetable shard, for highlighting a selection
 *
 * The pure parts (index, tile feature properties, packing) live here so the
 * ETL (writer) and the web app (reader) share one definition.
 */
import { decodePolyline, encodePolyline, packCities, packStations, unpackCities, unpackStations, type PackedNetwork } from "./pack.ts";
import type { CatBit, City, Corridor, Segment, Station } from "./schema.ts";
import type * as GeoJSON from "geojson";
import { Cat } from "./schema.ts";
import { promoteSparse } from "./density.ts";
import { LEVELS, LONG_HOP_ZOOM, catWidth, cityTierZoom, corridorMinZoom, haversineKm, isLongHop, levelIndex, stationLevel } from "./lod.ts";

export const MAPDATA_VERSION = 2;
export const CAT_BITS = [Cat.LongDistance, Cat.Regional, Cat.Coach, Cat.Bus] as const;
/** Vector tiles: zoom range (tileSize 512) and source-layer names. */
export const TILE_MAXZOOM = 7;
export const TILE_LAYERS = { seg: "seg", term: "term", city: "city", station: "st" } as const;

export type Pos = [number, number];

/** The subset of a network the map builders need. Arrays may be sparse (partial networks). */
export interface MapNet {
  cities: City[];
  corridors: (Corridor | undefined)[];
  segments: (Segment | undefined)[];
  stations: (Station | undefined)[];
}

export const segId = (code: number) => (code >= 0 ? code : -code - 1);

function d2(p: Pos, q: Pos): number {
  const k = Math.cos((q[1] * Math.PI) / 180);
  return ((p[0] - q[0]) * k) ** 2 + (p[1] - q[1]) ** 2;
}

/**
 * Segments of a network; for data without a line graph (old builds, fixtures)
 * every corridor becomes its own segment (and gets `segs = [id]`).
 */
export function ensureSegments(n: { corridors: Corridor[]; segments?: Segment[] }): Segment[] {
  if (n.segments?.length) return n.segments;
  n.segments = n.corridors.map((c) => {
    c.segs = [c.id];
    const s: Segment = { id: c.id, coords: c.coords, cats: c.cats, tpd: c.tpd, snapped: c.snapped };
    return s;
  });
  return n.segments;
}

// ---------------------------------------------------------------- index

export interface NetIndex {
  /** per segment: longest corridor (km, straight line) using it */
  segLen: Float32Array;
  /** per segment: lead-in between a city point and the stations of every corridor using it */
  segTerm: Uint8Array;
  /** per corridor: index (in segs) of the segment closest to its station at the a / b end */
  cutA: Int32Array;
  cutB: Int32Array;
  /** per segment × CAT_BITS index: earliest LOD level of the corridors using it */
  segLevel: Int8Array;
}

/** Segment indices (in c.segs) where the corridor passes closest to its stations. */
export function cutIndices(net: MapNet, c: Corridor): [number, number] {
  const segs = c.segs ?? [];
  const n = segs.length;
  if (n <= 1) return [0, Math.max(0, n - 1)];
  const best = (stId: number | undefined, from: number, to: number, dflt: number) => {
    const st = stId !== undefined ? net.stations[stId] : undefined;
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

export interface NetIndexOptions {
  /** Density-aware LOD (density.ts): lines appear earlier where the map is sparse. */
  density?: boolean | { budget?: number; maxPromote?: number };
  log?: (s: string) => void;
}

export function buildNetIndex(net: MapNet, opts: NetIndexOptions = {}): NetIndex {
  const nC = net.corridors.length;
  const nS = net.segments.length;
  const segLen = new Float32Array(nS);
  const segTerm = new Uint8Array(nS).fill(255);
  const cutA = new Int32Array(nC), cutB = new Int32Array(nC);
  const NC = CAT_BITS.length;
  const segLevel = new Int8Array(nS * NC).fill(127);
  // corridor × cat level (base rules), and corridor length
  const corLevel = new Int8Array(nC * NC).fill(127);
  const corLen = new Float32Array(nC);
  const fixed = new Uint8Array(nC * NC);
  for (const c of net.corridors) {
    if (!c) continue;
    const co = c.coords?.length ? c.coords : null;
    const ca = net.cities[c.a]!, cb = net.cities[c.b]!;
    const len = co ? haversineKm(co[0]!, co[co.length - 1]!) : haversineKm([ca.lon, ca.lat], [cb.lon, cb.lat]);
    corLen[c.id] = len;
    CAT_BITS.forEach((k, i) => {
      if (!(c.cats & k)) return;
      corLevel[c.id * NC + i] = levelIndex(corridorMinZoom(k, c.tpd[k] ?? 0, len, c.snapped));
      if (isLongHop(len, c.snapped)) fixed[c.id * NC + i] = 1;
    });
  }
  if (opts.density) {
    const t0 = Date.now();
    const r = promoteSparse(
      {
        segCoords: net.segments.map((s) => s?.coords),
        corridors: net.corridors.map((c) => (c ? { a: c.a, b: c.b, segs: c.segs ?? [], cats: c.cats, tpd: c.tpd } : undefined)),
        cats: CAT_BITS,
        levels: corLevel,
        fixed,
      },
      typeof opts.density === "object" ? opts.density : {},
    );
    opts.log?.(`mapdata: density LOD promoted ${CAT_BITS.map((k, i) => `${k}:${r.promoted[i]}`).join(" ")} corridor lines (${Date.now() - t0} ms)`);
  }
  for (const c of net.corridors) {
    if (!c) continue;
    const len = corLen[c.id]!;
    const segs = c.segs ?? [];
    const [ka, kb] = cutIndices(net, c);
    cutA[c.id] = ka;
    cutB[c.id] = kb;
    segs.forEach((code, i) => {
      const s = segId(code);
      for (let k = 0; k < NC; k++) if (corLevel[c.id * NC + k]! < segLevel[s * NC + k]!) segLevel[s * NC + k] = corLevel[c.id * NC + k]!;
      if (len > segLen[s]!) segLen[s] = len;
      if (i > ka && i < kb) segTerm[s] = 0;
      else if (segTerm[s] === 255) segTerm[s] = 1;
    });
  }
  for (let i = 0; i < nS; i++) if (segTerm[i] === 255) segTerm[i] = 0;
  return { segLen, segTerm, cutA, cutB, segLevel };
}

/**
 * End piece of a corridor at station zoom: the segment at cut index `k`
 * (cutA for end "a", cutB for "b"), cut at the closest approach to the
 * corridor's station and joined to it, in the segment's own orientation.
 */
export function terminalGeometry(
  segCoords: (sid: number) => Pos[] | undefined,
  stationOf: (id: number) => Station | undefined,
  c: Corridor,
  ka: number,
  kb: number,
  end: "a" | "b",
): { sid: number; coords: Pos[] } | null {
  const segs = c.segs;
  if (!segs?.length) return null;
  if (end === "b" && ka === kb) return null; // one piece cut at both ends (returned for "a")
  const code = segs[end === "a" ? ka : kb]!;
  const sid = segId(code);
  const co = segCoords(sid);
  if (!co || co.length < 2) return null;
  let p: Pos[] = code >= 0 ? [...co] : [...co].reverse();
  const station = (id: number | undefined): Pos | null => {
    const st = id !== undefined ? stationOf(id) : undefined;
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

// ---------------------------------------------------------------- tile features

/**
 * Properties of one drawn segment (layer `seg`/`term`). Per present category k
 * (1, 2, 4, 8): `w{k}` width unit, `l{k}` LOD level index. The client packs visible categories side by side
 * with style expressions, so tiles do not depend on the active filters.
 */
export function segmentProps(net: MapNet, idx: NetIndex, s: Segment): Record<string, number> | null {
  if (!s.cats || s.coords.length < 2) return null;
  const len = idx.segLen[s.id]!;
  const hop = isLongHop(len, s.snapped);
  const props: Record<string, number> = { sid: s.id, k: 0, u: s.snapped ? 0 : 1, term: idx.segTerm[s.id]!, hop: hop ? 1 : 0 };
  CAT_BITS.forEach((k, i) => {
    if (!(s.cats & k)) return;
    const tpd = s.tpd[k] ?? 0;
    props.k! += tpd;
    const users = idx.segLevel[s.id * CAT_BITS.length + i]!;
    // long-distance trunks may appear earlier on their aggregated traffic
    const agg = k === Cat.LongDistance ? levelIndex(corridorMinZoom(k, tpd, len, s.snapped)) : 127;
    props[`l${k}`] = hop ? levelIndex(LONG_HOP_ZOOM) : Math.min(users, agg, LEVELS.length - 1);
    props[`w${k}`] = Math.round(catWidth(k, tpd, s.snapped) * 100) / 100;
  });
  props.k = Math.round(props.k! * 10) / 10;
  return props;
}

/** Zoom from which any line of a segment is drawn. */
export function segmentMinZoom(props: Record<string, number>): number {
  let l = 127;
  for (const k of CAT_BITS) if (props[`l${k}`] !== undefined) l = Math.min(l, props[`l${k}`]!);
  return LEVELS[Math.min(l, LEVELS.length - 1)]!;
}

/**
 * City marker properties: `m{k}` = earliest zoom of a line of category k ending
 * at the city, `tz` the
 * importance tier zoom; the client shows a city from max(tz, min visible m).
 */
export function cityProps(net: MapNet, idx: NetIndex, segProps: (Record<string, number> | null)[]): (Record<string, number | string> | null)[] {
  const m = net.cities.map(() => ({}) as Record<string, number>);
  const width = new Float32Array(net.cities.length);
  const midLevel = levelIndex(7.5);
  for (const c of net.corridors) {
    if (!c?.segs?.length) continue;
    for (const [city, code] of [[c.a, c.segs[0]!], [c.b, c.segs[c.segs.length - 1]!]] as const) {
      const p = segProps[segId(code)];
      if (!p) continue;
      let w = 0;
      for (const k of CAT_BITS) {
        if (!(c.cats & k) || p[`l${k}`] === undefined) continue;
        const z = LEVELS[p[`l${k}`]!]!;
        const r = m[city]!;
        if (r[`m${k}`] === undefined || z < r[`m${k}`]!) r[`m${k}`] = z;
        if (p[`l${k}`]! <= midLevel) w += p[`w${k}`]! + 0.3;
      }
      if (w > width[city]!) width[city] = w;
    }
  }
  return net.cities.map((c) => {
    const r = m[c.id]!;
    if (!Object.keys(r).length) return null;
    return { id: c.id, name: c.name, imp: c.importance, ns: c.stations.length, mw: Math.round(width[c.id]! * 100) / 100, tz: cityTierZoom(c.importance), ...r };
  });
}

/** Zoom from which a city marker is shown with all categories enabled. */
export function cityMinZoom(props: Record<string, number | string>): number {
  let z = Infinity;
  for (const k of CAT_BITS) if (props[`m${k}`] !== undefined) z = Math.min(z, props[`m${k}`] as number);
  return Math.max(z, props.tz as number);
}

/** "Berlin Hbf" → "Hbf" inside Berlin (the city name is shown as an area label). */
export function shortStationName(name: string, city: string): string {
  if (name.length > city.length + 1 && name.startsWith(city) && /[\s,\-–(/]/.test(name[city.length]!)) {
    const rest = name.slice(city.length).replace(/^[\s,\-–/]+/, "");
    if (rest.length >= 2) return rest;
  }
  return name;
}

export function stationProps(c: City, s: Station, rank: number): Record<string, number | string> {
  const lz = stationLevel(s.cats, rank);
  return { id: s.id, name: shortStationName(s.name, c.name), city: s.city, lz, rail: s.cats & (Cat.LongDistance | Cat.Regional) ? 1 : 0, major: lz === 0 ? 1 : 0, rank: rank + (lz === 0 ? 0 : 100) };
}

// ---------------------------------------------------------------- core / stations files

export interface TileIndex {
  minzoom: number;
  maxzoom: number;
  /** Per zoom: existing tiles as a flat [x0, y0, x1, y1, …] list. */
  tiles: Record<string, number[]>;
  /** Path template relative to the build dir. */
  url: string;
}

/** Startup file: cities only (stations, corridors and geometry are loaded on demand). */
export interface CoreFile {
  schema: number;
  mapdata: number;
  build: string;
  timezones: string[];
  countries: string[];
  /** cities without population; coordinates in 1e-`cityPrec` degrees */
  cities: PackedNetwork["cities"];
  cityPrec: number;
  counts: { stations: number; corridors: number; segments: number };
  tiles: TileIndex;
}

export interface StationsFile {
  mapdata: number;
  stations: PackedNetwork["stations"];
}

export function packCore(o: Omit<CoreFile, "countries" | "cities" | "mapdata" | "cityPrec"> & { cityList: City[]; nStations: number }): CoreFile {
  const cityPrec = 4; // ≈ 10 m: plenty for markers, the drawn network comes from the tiles
  const { countries, cities } = packCities(o.cityList, o.nStations, { prec: cityPrec, population: false });
  const { cityList: _c, nStations: _n, ...rest } = o;
  return { ...rest, mapdata: MAPDATA_VERSION, countries, cities, cityPrec };
}

export function unpackCore(f: CoreFile): City[] {
  return unpackCities(f.countries, f.cities, f.cityPrec);
}

export function packStationsFile(cities: City[], stations: Station[]): StationsFile {
  return { mapdata: MAPDATA_VERSION, stations: packStations(cities, stations) };
}

export function unpackStationsFile(cities: City[], f: StationsFile): Station[] {
  return unpackStations(cities, f.stations);
}

// ---------------------------------------------------------------- geo files (per timetable shard)

/**
 * Corridors referenced by one timetable shard, with the geometry of their
 * segments: everything needed to draw the highlight of a selection.
 */
export interface GeoFile {
  mapdata: number;
  corridors: {
    /** delta-encoded sorted corridor ids */
    id: number[];
    a: number[];
    b: number[];
    cats: number[];
    /** trips/day × 10 for Cat bits 1, 2, 4, 8 */
    tpd: [number[], number[], number[], number[]];
    snapped: number[];
    /** station ids (−1 = none) */
    sa: number[];
    sb: number[];
    /** number of segment codes per corridor; codes zigzag-delta-encoded across corridors */
    segN: number[];
    segs: number[];
    /** NetIndex.cutA / cutB */
    cutA: number[];
    cutB: number[];
  };
  segments: {
    /** delta-encoded sorted segment ids */
    id: number[];
    /** chained polylines (precision 5) */
    poly: string[];
    /** bit 0: snapped, bit 1: long hop */
    flags: number[];
  };
  /**
   * Stations of the shard's cities and of every stop of its patterns (names for
   * timetables, positions for the selected cities' station markers).
   */
  stations: {
    /** delta-encoded sorted station ids */
    id: number[];
    /** a leading "~" stands for the station's city name */
    name: string[];
    /** delta-encoded integers in 1e-5 degrees */
    lon: number[];
    lat: number[];
    cats: number[];
    /** departures per day × 10 */
    tpd: number[];
  };
}

export interface GeoData {
  stations: Station[];
  corridors: Corridor[];
  cut: Map<number, [number, number]>;
  segments: Map<number, { coords: Pos[]; snapped: boolean; hop: boolean }>;
}

const zz = (d: number) => (d >= 0 ? 2 * d : -2 * d - 1);
const unzz = (z: number) => (z & 1 ? -(z + 1) / 2 : z / 2);

export function packGeo(net: MapNet, idx: NetIndex, corridorIds: Iterable<number>, stationIds: Iterable<number> = []): GeoFile {
  const ids = [...new Set(corridorIds)].filter((id) => net.corridors[id]).sort((x, y) => x - y);
  const f: GeoFile = {
    mapdata: MAPDATA_VERSION,
    corridors: { id: [], a: [], b: [], cats: [], tpd: [[], [], [], []], snapped: [], sa: [], sb: [], segN: [], segs: [], cutA: [], cutB: [] },
    segments: { id: [], poly: [], flags: [] },
    stations: { id: [], name: [], lon: [], lat: [], cats: [], tpd: [] },
  };
  let ps = 0, plon = 0, plat = 0;
  for (const sid of [...new Set(stationIds)].sort((x, y) => x - y)) {
    const st = net.stations[sid];
    if (!st) continue;
    const cn = net.cities[st.city]?.name ?? "";
    let name = st.name.replace(/^~+/, "");
    if (cn && name.length > cn.length && name.startsWith(cn)) name = "~" + name.slice(cn.length);
    const lon = Math.round(st.lon * 1e5), lat = Math.round(st.lat * 1e5);
    f.stations.id.push(sid - ps);
    f.stations.name.push(name);
    f.stations.lon.push(lon - plon);
    f.stations.lat.push(lat - plat);
    f.stations.cats.push(st.cats);
    f.stations.tpd.push(Math.round((st.tpd ?? 0) * 10));
    ps = sid;
    plon = lon;
    plat = lat;
  }
  const segIds = new Set<number>();
  let prevId = 0, prevCode = 0;
  for (const id of ids) {
    const c = net.corridors[id]!;
    const k = f.corridors;
    k.id.push(id - prevId);
    prevId = id;
    k.a.push(c.a);
    k.b.push(c.b);
    k.cats.push(c.cats);
    CAT_BITS.forEach((cat, i) => k.tpd[i]!.push(Math.round((c.tpd[cat] ?? 0) * 10)));
    k.snapped.push(c.snapped ? 1 : 0);
    k.sa.push(c.sa ?? -1);
    k.sb.push(c.sb ?? -1);
    const segs = c.segs ?? [];
    k.segN.push(segs.length);
    for (const code of segs) {
      const u = code >= 0 ? 2 * code : 2 * (-code - 1) + 1;
      k.segs.push(zz(u - prevCode));
      prevCode = u;
      segIds.add(segId(code));
    }
    k.cutA.push(idx.cutA[id]!);
    k.cutB.push(idx.cutB[id]!);
  }
  const ref = { lat: 0, lon: 0 };
  let prevS = 0;
  for (const sid of [...segIds].sort((x, y) => x - y)) {
    const s = net.segments[sid];
    if (!s) continue;
    f.segments.id.push(sid - prevS);
    prevS = sid;
    f.segments.poly.push(encodePolyline(s.coords, ref));
    f.segments.flags.push((s.snapped ? 1 : 0) | (isLongHop(idx.segLen[sid]!, s.snapped) ? 2 : 0));
  }
  return f;
}

/** `cityOf(stationId)` resolves the "~" name prefix (the station's city). */
export function unpackGeo(f: GeoFile, cityOf: (station: number) => City | undefined = () => undefined): GeoData {
  const stations: Station[] = [];
  const ps = f.stations ?? { id: [], name: [], lon: [], lat: [], cats: [], tpd: [] };
  let sid = 0, lon = 0, lat = 0;
  ps.id.forEach((d, i) => {
    sid += d;
    lon += ps.lon[i]!;
    lat += ps.lat[i]!;
    const c = cityOf(sid);
    const nm = ps.name[i]!;
    stations.push({
      id: sid,
      city: c?.id ?? -1,
      name: nm.startsWith("~") ? (c?.name ?? "") + nm.slice(1) : nm,
      lon: lon / 1e5,
      lat: lat / 1e5,
      cats: ps.cats[i]!,
      ...(ps.tpd[i] ? { tpd: ps.tpd[i]! / 10 } : {}),
    });
  });
  const corridors: Corridor[] = [];
  const cut = new Map<number, [number, number]>();
  const k = f.corridors;
  let id = 0, prevCode = 0, pos = 0;
  for (let i = 0; i < k.id.length; i++) {
    id += k.id[i]!;
    const tpd: Corridor["tpd"] = {};
    CAT_BITS.forEach((cat, j) => {
      const v = k.tpd[j]![i]!;
      if (v) tpd[cat as CatBit] = v / 10;
    });
    const segs: number[] = [];
    for (let n = 0; n < k.segN[i]!; n++) {
      prevCode += unzz(k.segs[pos++]!);
      segs.push(prevCode & 1 ? -((prevCode - 1) / 2) - 1 : prevCode / 2);
    }
    const c: Corridor = { id, a: k.a[i]!, b: k.b[i]!, coords: [], cats: k.cats[i]!, tpd, snapped: k.snapped[i] === 1, segs };
    if (k.sa[i]! >= 0) c.sa = k.sa[i];
    if (k.sb[i]! >= 0) c.sb = k.sb[i];
    corridors.push(c);
    cut.set(id, [k.cutA[i]!, k.cutB[i]!]);
  }
  const segments: GeoData["segments"] = new Map();
  const ref = { lat: 0, lon: 0 };
  let gid = 0;
  f.segments.id.forEach((d, i) => {
    gid += d;
    const fl = f.segments.flags[i]!;
    segments.set(gid, { coords: decodePolyline(f.segments.poly[i]!, ref), snapped: (fl & 1) === 1, hop: (fl & 2) === 2 });
  });
  return { stations, corridors, cut, segments };
}

/**
 * Join lines with identical properties head to tail (segments are oriented
 * consistently, so a straight continuation keeps its direction). Cuts the
 * feature count – and tile size – by an order of magnitude at low zoom.
 */
export function mergeLines(features: GeoJSON.Feature[]): GeoJSON.Feature[] {
  const key = (f: GeoJSON.Feature) => JSON.stringify(f.properties);
  const pt = (p: number[]) => `${p[0]},${p[1]}`;
  const coords = (f: GeoJSON.Feature) => (f.geometry as GeoJSON.LineString).coordinates;
  const byStart = new Map<string, number[]>();
  const endCount = new Map<string, number>();
  const keys = features.map(key);
  features.forEach((f, i) => {
    const c = coords(f);
    const ks = `${keys[i]}|${pt(c[0]!)}`;
    (byStart.get(ks) ?? byStart.set(ks, []).get(ks)!).push(i);
    const ke = `${keys[i]}|${pt(c[c.length - 1]!)}`;
    endCount.set(ke, (endCount.get(ke) ?? 0) + 1);
  });
  const used = new Uint8Array(features.length);
  const out: GeoJSON.Feature[] = [];
  const walk = (i: number) => {
    const line = [...coords(features[i]!)];
    used[i] = 1;
    for (;;) {
      const end = `${keys[i]}|${pt(line[line.length - 1]!)}`;
      const next = byStart.get(end)?.filter((j) => !used[j]);
      if (!next || next.length !== 1) break;
      const j = next[0]!;
      used[j] = 1;
      line.push(...coords(features[j]!).slice(1));
    }
    out.push({ type: "Feature", properties: features[i]!.properties, geometry: { type: "LineString", coordinates: line } });
  };
  // start at features without a unique predecessor, then whatever is left (cycles)
  features.forEach((f, i) => {
    const s = `${keys[i]}|${pt(coords(f)[0]!)}`;
    if (!used[i] && (endCount.get(s) ?? 0) !== 1) walk(i);
  });
  features.forEach((_, i) => {
    if (!used[i]) walk(i);
  });
  return out;
}

/** Tile key list helpers. */
export function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

export function tileSet(index: TileIndex): Set<string> {
  const out = new Set<string>();
  for (const [z, xy] of Object.entries(index.tiles)) for (let i = 0; i < xy.length; i += 2) out.add(tileKey(+z, xy[i]!, xy[i + 1]!));
  return out;
}
