/**
 * Map data derived from the network for fast, progressive loading:
 *
 *   core.json            CoreFile     – cities (+ timezones, tile zooms); everything the app needs to start
 *   stations.json        StationsFile – station names/coords/cats (lazy, needed once a city is selected)
 *   tile layers net, net-m            – gzipped Mapbox vector tiles of the drawn network, in the tile packs
 *                                       (tilepack.ts; layers seg, city; at the max zoom also st = stations)
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
import { monotoneLevels, promoteScenarios } from "./density.ts";
import { lineGroups, smoothLevels } from "./lines.ts";
import { LEVELS, LONG_HOP_ZOOM, catWidth, cityTierZoom, corridorMinZoom, haversineKm, isLongHop, isMajorStation, levelIndex, stationLevel } from "./lod.ts";

export const MAPDATA_VERSION = 6;
export const CAT_BITS = [Cat.LongDistance, Cat.Regional, Cat.Coach, Cat.Bus] as const;
/**
 * Vector tiles: zoom range (tileSize 512) and source-layer names. Tiles at the max zoom hold the full
 * stored geometry (8192 units ≈ 6 m at z9, 50° N); the map overzooms them to its max zoom.
 */
export const TILE_MAXZOOM = 9;
/** Up to this tile zoom, mode filters (not every category on) use their own tile set (`TileIndex.modes`). */
export const MODES_TILE_MAXZOOM = 6;
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
  /**
   * Mode scenarios: the same per category subset (key: mask over CAT_BITS indices, i.e. the Cat
   * bitmask of the enabled categories). Only with density LOD; the full mask is `segLevel`.
   */
  segLevelBy?: Map<number, Int8Array>;
}

/** Packed scenario levels: one base-16 digit (LOD level index) per subset of the other categories. */
export const SCEN_BASE = 16;
/** Digits per category: the subsets of the other categories without "all of them" (that is `l{k}`). */
export const SCEN_DIGITS = 7;

/**
 * Digit of category index `ki` in the packed scenario levels (`s{k}` / `n{k}`) when the categories of
 * `mask` (bits over CAT_BITS indices = Cat bits) are enabled: bit j = the j-th other category is on.
 * SCEN_DIGITS (7) = all others on, i.e. the plain level `l{k}`.
 */
export function scenarioDigit(ki: number, mask: number): number {
  let d = 0, j = 0;
  for (let o = 0; o < CAT_BITS.length; o++) {
    if (o === ki) continue;
    if ((mask >> o) & 1) d |= 1 << j;
    j++;
  }
  return d;
}

/** Inverse of scenarioDigit: the mask (incl. `ki`) of digit `d`. */
export function scenarioMask(ki: number, d: number): number {
  let m = 1 << ki, j = 0;
  for (let o = 0; o < CAT_BITS.length; o++) {
    if (o === ki) continue;
    if ((d >> j) & 1) m |= 1 << o;
    j++;
  }
  return m;
}

export function unpackScenario(v: number): number[] {
  const out: number[] = [];
  for (let d = 0; d < SCEN_DIGITS; d++) out.push(Math.floor(v / SCEN_BASE ** d) % SCEN_BASE);
  return out;
}

export function packScenario(digits: number[]): number {
  return digits.reduce((a, v, d) => a + v * SCEN_BASE ** d, 0);
}

export interface NetIndexOptions {
  /** Density-aware LOD (density.ts): lines appear earlier where the map is sparse. */
  density?: boolean | { budget?: number; maxPromote?: number; cellPx?: number; radius?: number };
  /** With density: also compute the levels of every category subset (`segLevelBy`); default true. */
  scenarios?: boolean;
  /** Reveal chains of hops as a whole (lines.ts); default true. */
  lines?: boolean;
  log?: (s: string) => void;
}

export function buildNetIndex(net: MapNet, opts: NetIndexOptions = {}): NetIndex {
  const nC = net.corridors.length;
  const nS = net.segments.length;
  const segLen = new Float32Array(nS);
  const NC = CAT_BITS.length;
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
  let byMask: Map<number, Int8Array> | undefined;
  if (opts.density) {
    const t0 = Date.now();
    const full = (1 << NC) - 1;
    // the full set first (reference scenario), then every other non-empty subset
    const masks = opts.scenarios === false ? [full] : [full, ...Array.from({ length: full - 1 }, (_, i) => full - 1 - i)];
    // connectivity by city: a coach line from a city's bus station grows out of the city's rail network
    const nodeOf = (station: number) => {
      const city = net.stations[station]?.city;
      return city === undefined || city < 0 ? -1 - station : city;
    };
    const res = promoteScenarios(
      {
        segCoords: net.segments.map((s) => s?.coords),
        corridors: corList.map((c) => (c ? { ...c, a: nodeOf(c.a), b: nodeOf(c.b) } : undefined)),
        cats: CAT_BITS,
        levels: corLevel,
        fixed,
        group: opts.lines !== false ? group : undefined,
      },
      masks,
      typeof opts.density === "object" ? opts.density : {},
    );
    monotoneLevels(res, NC);
    corLevel.set(res[0]!.levels);
    opts.log?.(`mapdata: density LOD promoted ${CAT_BITS.map((k, i) => `${k}:${res[0]!.promoted[i]}`).join(" ")} corridor lines, ${masks.length} mode scenarios (${Date.now() - t0} ms)`);
    if (masks.length > 1) {
      byMask = new Map();
      for (const r of res.slice(1)) byMask.set(r.mask, segLevels(net, r.levels, NC));
    }
  }
  const segLevel = segLevels(net, corLevel, NC);
  for (const c of net.corridors) {
    if (!c) continue;
    const len = corLen[c.id]!;
    for (const code of c.segs ?? []) {
      const s = segId(code);
      if (len > segLen[s]!) segLen[s] = len;
    }
  }
  return { segLen, segLevel, ...(byMask ? { segLevelBy: byMask } : {}) };
}

/** Segment × cat level = earliest level of the corridors using the segment. */
function segLevels(net: MapNet, corLevel: Int8Array, NC: number): Int8Array {
  const segLevel = new Int8Array(net.segments.length * NC).fill(127);
  for (const c of net.corridors) {
    if (!c) continue;
    for (const code of c.segs ?? []) {
      const s = segId(code);
      for (let k = 0; k < NC; k++) if (corLevel[c.id * NC + k]! < segLevel[s * NC + k]!) segLevel[s * NC + k] = corLevel[c.id * NC + k]!;
    }
  }
  return segLevel;
}

// ---------------------------------------------------------------- tile features

/**
 * Properties of one drawn segment (layer `seg`). Per present category k
 * (1, 2, 4, 8): `w{k}` width unit, `l{k}` LOD level index with every mode on and, where hiding other
 * modes moves it earlier, `s{k}` = the levels of the other mode subsets packed as base-16 digits
 * (scenarioDigit). The client packs visible categories side by side and picks the level of the active
 * filter with style expressions, so tiles do not depend on the active filters.
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
    // long-distance trunks may appear earlier on their aggregated traffic
    const agg = k === Cat.LongDistance ? levelIndex(corridorMinZoom(k, tpd, len, s.snapped)) : 127;
    const level = (segLevel: Int8Array) => (hop ? levelIndex(LONG_HOP_ZOOM) : Math.min(segLevel[s.id * CAT_BITS.length + i]!, agg, LEVELS.length - 1));
    const l = level(idx.segLevel);
    props[`l${k}`] = l;
    // levels with other categories hidden, packed (only where one differs)
    if (idx.segLevelBy) {
      const digits = Array.from({ length: SCEN_DIGITS }, (_, d) => {
        const by = idx.segLevelBy!.get(scenarioMask(i, d));
        return by ? level(by) : l;
      });
      if (digits.some((v) => v !== l)) props[`s${k}`] = packScenario(digits);
    }
    props[`w${k}`] = Math.round(catWidth(k, tpd, s.snapped) * 100) / 100;
  });
  props.k = Math.round(props.k! * 10) / 10;
  return props;
}

/** Earliest level of category k on a feature over all mode scenarios (`l{k}` and the packed `s{k}`), undefined if absent. */
export function minScenarioLevel(props: Record<string, number | string>, k: number, plain = "l", packed = "s"): number | undefined {
  const l = props[`${plain}${k}`] as number | undefined;
  if (l === undefined) return undefined;
  const p = props[`${packed}${k}`] as number | undefined;
  return p === undefined ? l : Math.min(l, ...unpackScenario(p));
}

/** Zoom from which any line of a segment is drawn (under some mode filter; `modes` false: with every mode on). */
export function segmentMinZoom(props: Record<string, number>, modes = true): number {
  let l = 127;
  for (const k of CAT_BITS) l = Math.min(l, (modes ? minScenarioLevel(props, k) : props[`l${k}`]) ?? 127);
  return LEVELS[Math.min(l, LEVELS.length - 1)]!;
}

/**
 * City marker properties: `m{k}` = earliest zoom of a line of category k ending
 * at the city (`n{k}`: the earliest level index per mode subset, packed like `s{k}`), `tz` the
 * importance tier zoom; the client shows a city from max(tz, min visible m).
 */
export function cityProps(net: MapNet, idx: NetIndex, segProps: (Record<string, number> | null)[]): (Record<string, number | string> | null)[] {
  const m = net.cities.map(() => ({}) as Record<string, number>);
  /** per city and category: earliest level per mode scenario digit */
  const sl: Record<number, number[]>[] = [];
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
        // per mode scenario (level indices)
        const ds = p[`s${k}`] !== undefined ? unpackScenario(p[`s${k}`]!) : new Array<number>(SCEN_DIGITS).fill(p[`l${k}`]!);
        const cur = (sl[city] ??= {})[k];
        sl[city]![k] = cur ? cur.map((v, d) => Math.min(v, ds[d]!)) : ds;
        if (p[`l${k}`]! <= midLevel) w += p[`w${k}`]! + 0.3;
      }
      if (w > width[city]!) width[city] = w;
    }
  }
  // tier zoom: global importance tier, earlier where the map around the city is empty
  const tz = net.cities.map((c) => cityTierZoom(c.importance));
  const order = net.cities.map((c) => c.id).filter((id) => Object.keys(m[id]!).length);
  order.sort((a, b) => net.cities[b]!.importance - net.cities[a]!.importance || a - b);
  const local = localTierZooms(
    order.map((id) => {
      const c = net.cities[id]!;
      return { lon: c.lon, lat: c.lat, tier: tz[id]!, line: Math.min(...CAT_BITS.map((k) => m[id]![`m${k}`] ?? Infinity)) };
    }),
  );
  order.forEach((id, i) => (tz[id] = local[i]!));
  return net.cities.map((c) => {
    const r = m[c.id]!;
    if (!Object.keys(r).length) return null;
    // `n{k}`: packed level indices of the earliest line per mode scenario, where one differs from `m{k}`
    const n: Record<string, number> = {};
    for (const k of CAT_BITS) {
      const ds = sl[c.id]?.[k];
      if (ds && r[`m${k}`] !== undefined && ds.some((v) => LEVELS[v] !== r[`m${k}`])) n[`n${k}`] = packScenario(ds);
    }
    return { id: c.id, name: c.name, imp: c.importance, ns: c.stations.length, mw: Math.round(width[c.id]! * 100) / 100, tz: tz[c.id]!, ...r, ...n };
  });
}

/** Locally relative city tiers (localTierZooms): a city may show early while no city shown then lies within this many px. */
export const CITY_SPACING_PX = 140;
/** Earliest zoom of a locally promoted city. */
export const CITY_LOCAL_FLOOR = 4;

/**
 * Locally relative tier zooms. The importance tiers (cityTierZoom) are global: importance comes from
 * population and departures relative to the busiest city of Europe, so in a sparse region (Iceland,
 * northern Scandinavia, an island) even the regional capital only shows from z7 or later, next to an
 * empty map. Here, in priority order (most important first), a point takes the earliest zoom from
 * `floor` on at which no point already shown at that zoom lies within `spacing` px – like the
 * stations' thinning – but never later than its own tier: dense regions keep the global tiers, a
 * sparse one shows its most important places as early as the room allows.
 * `line` = zoom of the earliest line at the point (it is shown from max(tier, line)).
 * Returns the tier zoom per point (≤ `tier`).
 */
export function localTierZooms(pts: readonly { lon: number; lat: number; tier: number; line: number }[], spacing = CITY_SPACING_PX, floor = CITY_LOCAL_FLOOR): number[] {
  const out = pts.map((p) => p.tier);
  const L0 = levelIndex(floor);
  // per level: grid of the points shown there, cell = spacing px at the level's zoom (mercator units)
  const grids = LEVELS.map(() => new Map<string, number[]>());
  const cell = LEVELS.map((z) => spacing / (512 * 2 ** z));
  const mx = (lon: number) => (lon + 180) / 360;
  const my = (lat: number) => {
    const sn = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
    return 0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI);
  };
  const xs = pts.map((p) => mx(p.lon)), ys = pts.map((p) => my(p.lat));
  const free = (i: number, L: number) => {
    const cs = cell[L]!, gx = Math.floor(xs[i]! / cs), gy = Math.floor(ys[i]! / cs);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grids[L]!.get(`${gx + dx},${gy + dy}`) ?? []) if (Math.hypot(xs[i]! - xs[j]!, ys[i]! - ys[j]!) < cs) return false;
    return true;
  };
  pts.forEach((p, i) => {
    for (let L = L0; L < LEVELS.length && LEVELS[L]! < p.tier; L++) {
      const z = Math.max(LEVELS[L]!, p.line);
      if (z >= p.tier) break;
      if (free(i, levelIndex(z))) {
        out[i] = z;
        break;
      }
    }
    const shown = Math.max(out[i]!, p.line);
    for (let L = 0; L < LEVELS.length; L++) {
      if (LEVELS[L]! < shown) continue;
      const cs = cell[L]!, key = `${Math.floor(xs[i]! / cs)},${Math.floor(ys[i]! / cs)}`;
      (grids[L]!.get(key) ?? grids[L]!.set(key, []).get(key)!).push(i);
    }
  });
  return out;
}

/** Zoom from which a city marker may be shown (under some mode filter). */
export function cityMinZoom(props: Record<string, number | string>): number {
  let z = Infinity;
  for (const k of CAT_BITS) {
    if (props[`m${k}`] === undefined) continue;
    z = Math.min(z, props[`m${k}`] as number);
    if (props[`n${k}`] !== undefined) z = Math.min(z, ...unpackScenario(props[`n${k}`] as number).map((l) => LEVELS[l]!));
  }
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
  const lz = stationLevel(s.cats, rank, c.stations.length);
  const major = isMajorStation(s.cats, rank);
  return { id: s.id, name: shortStationName(s.name, c.name), city: s.city, lz, rail: s.cats & (Cat.LongDistance | Cat.Regional) ? 1 : 0, major: major ? 1 : 0, rank: rank + (major ? 0 : 100) };
}

// ---------------------------------------------------------------- core / stations files

/** Zoom range of the network tiles (tile layers `net` and `net-m` of the tile packs, tilepack.ts). */
export interface TileIndex {
  minzoom: number;
  maxzoom: number;
  /**
   * Tile layer `net-m` for mode filters up to `maxzoom` (it holds the lines every category subset shows earlier,
   * density.ts); beyond it `net` serves every filter.
   */
  modes?: { maxzoom: number };
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


