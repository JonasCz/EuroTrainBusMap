/**
 * Static data format produced by the ETL (packages/etl) and consumed by the
 * frontend (packages/web). Everything is plain JSON served as static files
 * under `<BASE_PATH>/data/`, so the site can be hosted anywhere.
 *
 * Layout:
 *   data/manifest.json            Manifest (small, fetched with no-cache)
 *   data/<build>/network.json     NetworkFile – cities, stations, corridors (loaded on start)
 *   data/<build>/calendars.json   CalendarsFile – shared service-day bitmasks
 *   data/<build>/city/<id>.json   CityFile – timetable data for one city (loaded on click)
 *   data/<build>/basemap/*.json   GeoJSON basemap layers (land, borders, lakes)
 *   data/<build>/attribution.json AttributionFile
 *
 * Conventions:
 *   - Coordinates are [lon, lat] rounded to 5 decimals (≈1 m).
 *   - Ids are dense integers (array indices) unless stated otherwise.
 *   - Times are minutes after midnight of the *service day* in the trip's
 *     timezone (may exceed 1440 for trips running past midnight).
 */

export const SCHEMA_VERSION = 1;

/** Service categories. Bit flags so several can be combined in masks. */
export const Cat = {
  /** Long-distance / high-speed / international rail (ICE, IC, EC, TGV, RJ, night trains…) */
  LongDistance: 1,
  /** Regional / suburban heavy rail (RE, RB, S-Bahn, TER, R, Os…) */
  Regional: 2,
  /** Intercity coach (FlixBus, BlaBlaCar, national coach operators) */
  Coach: 4,
  /** Regional / intercity bus (non-urban, connects different towns) */
  Bus: 8,
} as const;
export type CatBit = (typeof Cat)[keyof typeof Cat];

/** Extra flags on a route/trip. */
export const Flag = {
  /** Valid with the German Deutschlandticket (regional services in DE). */
  DTicket: 1,
  /** Night train / overnight service. */
  Night: 2,
} as const;

export interface Manifest {
  schema: number;
  /** Build id, used as directory name for versioned data. */
  build: string;
  /** ISO timestamp of when the ETL ran. */
  generatedAt: string;
  /** First service day covered by calendars (YYYY-MM-DD). Day index 0. */
  startDate: string;
  /** Number of days covered by calendar bitmasks. */
  days: number;
  stats: Record<string, number>;
}

export interface City {
  id: number;
  name: string;
  /** ISO 3166-1 alpha-2 */
  country: string;
  /** Representative point (population-weighted / main station). */
  lon: number;
  lat: number;
  population: number;
  /**
   * Importance 0..1 used for label/marker level of detail; combines
   * population and amount of service. Rank 1 = Paris/Berlin-level hubs.
   */
  importance: number;
  /** Union of Cat bits served at this city. */
  cats: number;
  /** Indices into NetworkFile.stations. */
  stations: number[];
  /** IANA timezone. Index into NetworkFile.timezones. */
  tz: number;
}

export interface Station {
  id: number;
  city: number;
  name: string;
  lon: number;
  lat: number;
  /** Union of Cat bits served at this station. */
  cats: number;
}

/**
 * A corridor is a drawable edge between two adjacent cities (consecutive
 * served cities on at least one trip). Geometry follows the railway/road where
 * known, otherwise a smoothed curve.
 */
export interface Corridor {
  id: number;
  a: number; // city id
  b: number; // city id
  /** Polyline [lon,lat][] from city a to city b. */
  coords: [number, number][];
  /** Union of Cat bits running on this corridor. */
  cats: number;
  /** Average trips per day in both directions per category, keyed by Cat bit. */
  tpd: Partial<Record<CatBit, number>>;
  /** Whether geometry is snapped to real infrastructure (true) or synthesized (false). */
  snapped: boolean;
  /** Cat bits on this corridor that carry Deutschlandticket-valid services (Flag.DTicket). */
  dtCats?: number;
  /** Most-used station at the `a` / `b` end (for drawing to the real station at high zoom). */
  sa?: number;
  sb?: number;
}

export interface NetworkFile {
  schema: number;
  build: string;
  timezones: string[];
  cities: City[];
  stations: Station[];
  corridors: Corridor[];
  /**
   * Optional continuation files (paths relative to the build directory, e.g.
   * "network-1.json"), each a NetworkPart. Used when the network would exceed
   * the static host's per-file size limit. Load them all and append their
   * arrays, in order, to `stations` / `corridors` (ids stay dense and global).
   */
  parts?: string[];
}

/** Continuation of NetworkFile.stations / .corridors (see NetworkFile.parts). */
export interface NetworkPart {
  stations?: Station[];
  corridors?: Corridor[];
}

export interface CalendarsFile {
  startDate: string;
  days: number;
  /** Each entry is a base64-encoded little-endian bitmask, bit i = runs on day startDate+i. */
  masks: string[];
}

/** A route/line as shown to users (e.g. "ICE 597", "RE 1", "FlixBus N123"). */
export interface Route {
  /** Display name, e.g. "ICE", "RE 7", "Flixbus 044". */
  name: string;
  /** Operator / agency name. */
  agency: string;
  cat: CatBit;
  flags: number;
  /** Hex colour without '#', if provided by the feed. */
  color?: string;
}

/**
 * A stop pattern: ordered list of (station, arrival offset, departure offset)
 * relative to the trip's start time. Only stops at cities in the network are
 * kept (stops in places that are not cities are dropped). Consecutive stops in
 * the same city are kept (they are distinct stations), so callers must handle
 * them.
 */
export interface Pattern {
  route: number; // index into CityFile.routes
  /** Station ids, in travel order. */
  stations: number[];
  /** Arrival offsets (minutes from trip start), same length as stations. */
  arr: number[];
  /** Departure offsets (minutes from trip start), same length as stations. */
  dep: number[];
  /** Corridor ids traversed between consecutive *cities* (length = number of city changes). */
  corridors: number[];
  /** Headsign / final destination text. */
  headsign: string;
}

/**
 * A concrete trip = pattern + start time + calendar.
 * Tuple for compactness: [patternIdx, startMinutes, calendarIdx, tripShortName?]
 * startMinutes is minutes after service-day midnight in tz `tz` of the route
 * (CityFile.patternTz[patternIdx]).
 */
export type Trip = [pattern: number, start: number, calendar: number, number?: string];

/**
 * Everything needed to answer questions about one city:
 *  - where can I go (downstream cities of patterns through this city),
 *  - timetables to any other city,
 *  - connections onward from this city (by loading the destination's CityFile).
 * Contains all patterns that *call at* this city (with their full stop list,
 * so "train started at X" and arrival at any downstream city is available).
 */
export interface CityFile {
  city: number;
  routes: Route[];
  patterns: Pattern[];
  /** Timezone index (NetworkFile.timezones) per pattern. */
  patternTz: number[];
  trips: Trip[];
  /**
   * Walking transfer minutes between stations of this city:
   * [fromStation, toStation, minutes][]; same-station minimum is `minTransfer`.
   */
  transfers: [number, number, number][];
  minTransfer: number;
}

export interface AttributionFile {
  sources: { name: string; license: string; url?: string; attribution?: string }[];
}

/** Helpers shared by ETL and web. */
export function hasCat(mask: number, cat: number): boolean {
  return (mask & cat) !== 0;
}
