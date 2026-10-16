/**
 * Map data derived from the network for fast, progressive loading:
 *
 *   core.json            CoreFile     – cities (+ timezones, tile index); everything the app needs to start
 *   stations.json        StationsFile – station names/coords/cats (lazy, needed once a city is selected)
 *   tiles/{z}/{x}/{y}.pbf.gz          – gzipped Mapbox vector tiles of the drawn network
 *                                       (layers seg, city; at the max zoom also st = stations)
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
import { lineGroups, smoothLevels } from "./lines.ts";
import { LEVELS, LONG_HOP_ZOOM, catWidth, cityTierZoom, corridorMinZoom, haversineKm, isLongHop, levelIndex, stationLevel } from "./lod.ts";

export const MAPDATA_VERSION = 5;
export const CAT_BITS = [Cat.LongDistance, Cat.Regional, Cat.Coach, Cat.Bus] as const;
/**
 * Vector tiles: zoom range (tileSize 512) and source-layer names. Tiles at the max zoom hold the full
 * stored geometry (8192 units ≈ 6 m at z9, 50° N); the map overzooms them to its max zoom.
 */
export const TILE_MAXZOOM = 9;
export const TILE_LAYERS = { seg: "seg", city: "city", station: "st" } as const;

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
  /** per segment × CAT_BITS index: earliest LOD level of the corridors using it */
  segLevel: Int8Array;
}

export interface NetIndexOptions {
  /** Density-aware LOD (density.ts): lines appear earlier where the map is sparse. */
  density?: boolean | { budget?: number; maxPromote?: number };
  /** Reveal chains of hops as a whole (lines.ts); default true. */
  lines?: boolean;
  log?: (s: string) => void;
}

export function buildNetIndex(net: MapNet, opts: NetIndexOptions = {}): NetIndex {
  const nC = net.corridors.length;
  const nS = net.segments.length;
  const segLen = new Float32Array(nS);
  const NC = CAT_BITS.length;
  const segLevel = new Int8Array(nS * NC).fill(127);
  // corridor × cat level (base rules), and corridor length
  const corLevel = new Int8Array(nC * NC).fill(127);
  const corLen = new Float32Array(nC);
  const fixed = new Uint8Array(nC * NC);
  for (const c of net.corridors) {
    if (!c) continue;
    const co = c.coords?.length ? c.coords : null;
    const sa = net.stations[c.a], sb = net.stations[c.b];
    const len = co ? haversineKm(co[0]!, co[co.length - 1]!) : sa && sb ? haversineKm([sa.lon, sa.lat], [sb.lon, sb.lat]) : 0;
    corLen[c.id] = len;
    CAT_BITS.forEach((k, i) => {
      if (!(c.cats & k)) return;
      corLevel[c.id * NC + i] = levelIndex(corridorMinZoom(k, c.tpd[k] ?? 0, len, c.snapped));
      if (isLongHop(len, c.snapped)) fixed[c.id * NC + i] = 1;
    });
  }
  // a line (chain of hops) is revealed as a whole: all its hops get the earliest level among them
  const corList = net.corridors.map((c) => (c ? { a: c.a, b: c.b, segs: c.segs ?? [], cats: c.cats, tpd: c.tpd } : undefined));
  const group = lineGroups(corList, CAT_BITS, fixed);
  if (opts.lines !== false) smoothLevels(corLevel, group);
  if (opts.density) {
    const t0 = Date.now();
    const r = promoteSparse(
      {
        segCoords: net.segments.map((s) => s?.coords),
        corridors: corList,
        cats: CAT_BITS,
        levels: corLevel,
        fixed,
        group: opts.lines !== false ? group : undefined,
      },
      typeof opts.density === "object" ? opts.density : {},
    );
    opts.log?.(`mapdata: density LOD promoted ${CAT_BITS.map((k, i) => `${k}:${r.promoted[i]}`).join(" ")} corridor lines (${Date.now() - t0} ms)`);
  }
  for (const c of net.corridors) {
    if (!c) continue;
    const len = corLen[c.id]!;
    for (const code of c.segs ?? []) {
      const s = segId(code);
      for (let k = 0; k < NC; k++) if (corLevel[c.id * NC + k]! < segLevel[s * NC + k]!) segLevel[s * NC + k] = corLevel[c.id * NC + k]!;
      if (len > segLen[s]!) segLen[s] = len;
    }
  }
  return { segLen, segLevel };
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
  const props: Record<string, number> = { sid: s.id, k: 0, u: s.snapped ? 0 : 1, hop: hop ? 1 : 0 };
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
    // a corridor ends at two stations: its first / last piece belongs to the city of that station
    for (const [station, code] of [[c.a, c.segs[0]!], [c.b, c.segs[c.segs.length - 1]!]] as const) {
      const city = net.stations[station]?.city;
      if (city === undefined) continue;
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

/**
 * One-word remainders that say nothing without the city ("London Bridge" must not become "Bridge",
 * "Paris Nord" not "Nord"): generic place words, compass points and "central" in common languages.
 */
const GENERIC_REMAINDER = new Set(
  (
    "bridge road street lane way avenue cross park square place gate green hill junction town city main old new harbour harbor port " +
    "central centre center centrum centro centrale zentrum centraal mitte north south east west nord sud sued ost est ouest norte sur oeste este " +
    "nord-est nord-ouest sud-est sud-ouest nordost nordwest sudost sudwest " +
    "brucke brug pont ponte puente most strasse str rue via ulica ul platz plaza piazza plein " +
    "airport flughafen aeroport aeropuerto lotnisko terminal station stop halt depot works " +
    "stasjon jernbanestasjon togstasjon busstasjon stasjonen stationen bahnhof gare stazione estacion estacao dworzec stacja stanice nadrazi stanica " +
    "banegard jarnvagsstation asema rautatieasema vasutallomas gara"
  ).split(" "),
);

const foldWord = (w: string) =>
  w
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/[.]/g, "");

/**
 * "Berlin Hbf" → "Hbf" inside Berlin (the city name is shown as an area label), but only while the
 * remainder is distinctive: a single generic word ("London Bridge", "Paris Nord", "Leeds Central") or a
 * bare number keeps the full name.
 */
export function shortStationName(name: string, city: string): string {
  if (name.length > city.length + 1 && name.startsWith(city) && /[\s,\-–(/]/.test(name[city.length]!)) {
    const rest = name.slice(city.length).replace(/^[\s,\-–/]+/, "");
    if (rest.length >= 2 && !isGenericRemainder(rest)) return rest;
  }
  return name;
}

function isGenericRemainder(rest: string): boolean {
  const words = rest.split(/[\s,\-–/]+/).filter(Boolean);
  if (words.length === 1) return GENERIC_REMAINDER.has(foldWord(words[0]!)) || /^\d+[a-z]?$/i.test(words[0]!);
  // two words that are both generic ("Central Station", "North Road")
  return words.length === 2 && words.every((w) => GENERIC_REMAINDER.has(foldWord(w)));
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
    /** number of segment codes per corridor; codes zigzag-delta-encoded across corridors */
    segN: number[];
    segs: number[];
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
  segments: Map<number, { coords: Pos[]; snapped: boolean; hop: boolean }>;
}

const zz = (d: number) => (d >= 0 ? 2 * d : -2 * d - 1);
const unzz = (z: number) => (z & 1 ? -(z + 1) / 2 : z / 2);

export function packGeo(net: MapNet, idx: NetIndex, corridorIds: Iterable<number>, stationIds: Iterable<number> = []): GeoFile {
  const ids = [...new Set(corridorIds)].filter((id) => net.corridors[id]).sort((x, y) => x - y);
  const f: GeoFile = {
    mapdata: MAPDATA_VERSION,
    corridors: { id: [], a: [], b: [], cats: [], tpd: [[], [], [], []], snapped: [], segN: [], segs: [] },
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
    const segs = c.segs ?? [];
    k.segN.push(segs.length);
    for (const code of segs) {
      const u = code >= 0 ? 2 * code : 2 * (-code - 1) + 1;
      k.segs.push(zz(u - prevCode));
      prevCode = u;
      segIds.add(segId(code));
    }
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
    corridors.push(c);
  }
  const segments: GeoData["segments"] = new Map();
  const ref = { lat: 0, lon: 0 };
  let gid = 0;
  f.segments.id.forEach((d, i) => {
    gid += d;
    const fl = f.segments.flags[i]!;
    segments.set(gid, { coords: decodePolyline(f.segments.poly[i]!, ref), snapped: (fl & 1) === 1, hop: (fl & 2) === 2 });
  });
  return { stations, corridors, segments };
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
