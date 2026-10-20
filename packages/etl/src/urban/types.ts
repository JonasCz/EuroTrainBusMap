/** Local (within-city) transport: lines and stops extracted from GTFS, drawn as a display layer only. */

export type LonLat = [number, number];

/** Mode codes (tile property `m`). */
export const UMode = { Bus: 0, Tram: 1, Metro: 2, Cable: 3 } as const;
export type UModeCode = (typeof UMode)[keyof typeof UMode];
export const UMODE_NAME = ["bus", "tram", "metro", "cable"] as const;

/** One drawn alignment of a line (a direction / branch). */
export interface UrbanPattern {
  /** Polyline of the alignment (shape, or routed / straight between the stops). */
  coords: LonLat[];
  /** Indices into UrbanFeed.stops, in travel order. */
  stops: number[];
  /** Number of trips of the representative day on this pattern. */
  trips: number;
  /** How the geometry was obtained. */
  geom: "shape" | "road" | "rail" | "stops";
  /** Bus patterns: when they run, for the station changes by local bus (bus-transfer.ts); not part of the layer. */
  times?: PatternTimes;
}

/** Day types of PatternTimes.deps: the reference Wednesday, the Saturday and the Sunday after it. */
export const TIME_DAYS = 3;

/** Timetable summary of a bus pattern: no full timetable, only what a station change by bus needs. */
export interface PatternTimes {
  /** minutes from the departure at the first stop to each stop (of `stops`), from a representative trip */
  t: number[];
  /** per day type (TIME_DAYS): departures at the first stop, minutes of the service day (may pass 1440), ascending */
  deps: number[][];
}

export interface UrbanLine {
  mode: UModeCode;
  /** Short name as printed on the vehicle ("U2", "T3", "42"). */
  name: string;
  /** "A – B" description (long name or first / last stop). */
  desc: string;
  agency: string;
  /** Hex colour without '#', or "" when the feed gives none. */
  color: string;
  /** Representative-weekday trips per direction (peak direction). */
  tpd: number;
  patterns: UrbanPattern[];
}

export interface UrbanStop {
  id: string;
  name: string;
  lon: number;
  lat: number;
  /** parent_station id (feed-local) or "". */
  parent: string;
}

/** Extraction result of one GTFS feed (cached as JSON). */
export interface UrbanFeed {
  key: string;
  version: number;
  lines: UrbanLine[];
  stops: UrbanStop[];
  stats: { routes: number; kept: number; shaped: number; dropped: Record<string, number> };
  /**
   * The feed's service ended on this day (a stale feed within the cap, gtfs/validity.ts): its lines were read from its
   * last weeks and carry the date (tile property `e`, "Timetables out of date" in the popup). Set per build, not cached.
   */
  expired?: string;
}

/** Bump when the extraction changes (invalidates cached feeds). */
export const EXTRACT_VERSION = 5;
