/**
 * Operator adapters: the fixes and additions for one operator (or one feed) that are not generic rules. Each adapter
 * is a file in packages/etl/operators/ (see the README there); the registry (registry.ts) loads them all, checks that
 * they do not overlap and applies them at fixed points of every build.
 */
import type { Classification, RouteInfo } from "../core/classify.ts";
import type { FeedDef, FeedOptions, ModeClass } from "../feeds.ts";

/**
 * Which rows an adapter may touch. A route is in scope when its feed is in `feeds` or its feed's country is in
 * `countries` (neither given: any feed) and, when `agencies` is given, its agency name matches one of them.
 * An adapter must name at least one of the three: a rule for everything is a generic rule and belongs in the main code.
 */
export interface OperatorScope {
  /** Feed ids (FeedDef.id in feeds.json, or of an adapter's extraFeeds). */
  feeds?: string[];
  /** Feed countries (FeedDef.country), for a rule that holds for every feed of a country. */
  countries?: string[];
  /** Agency names (as in agency.txt, before options.agencyName). */
  agencies?: RegExp[];
}

/** The feed a hook runs for. */
export interface FeedRef {
  /** Feed key (FeedDef.id, or id~file for feeds of several files). */
  key: string;
  id: string;
  country: string;
}

/** What a classify.before hook may say about a route (combined with a trip category). */
export interface RouteOverride {
  /** Mode class instead of the one of the route_type (e.g. "bus" for a coach trip category on a rail route). */
  mode?: ModeClass;
  /** Flags to add (Flag bits from @etbm/shared, e.g. Flag.ReservationOnly). */
  flags?: number;
}

export interface ClassifyHooks {
  /**
   * Before the generic rules (core/classify.ts), for every (route, trip category) of the feed in scope. `mode` is the
   * mode class of the route_type. Return undefined to leave the route to the generic rules.
   */
  before?(r: RouteInfo, mode: ModeClass, feed: FeedRef): RouteOverride | undefined;
  /**
   * After the generic rules, before the feed's railCatDefault: return a new Classification, null to drop the route,
   * or undefined to keep the generic result. Not called for routes the generic rules dropped.
   */
  after?(r: RouteInfo, cl: Classification, feed: FeedRef): Classification | null | undefined;
}

/**
 * What an onLoad hook can do with the feed being loaded (gtfs/load.ts), after its stop_times and stops are read and
 * before the short-bus filter. The tables hold this feed only:
 *  - t_kt(trip_key, trip_id, rc, service_key, headsign, short_name, shape_id, cls): kept trips with their class
 *  - t_st(trip_key, seq, stop_id, arr, dep, dist, pd): their stop times (minutes)
 *  - t_stops_all(stop_id, name, lat, lon, parent_id, tz, loc_type, vehicle_type): stops.txt
 *  - t_trips(route_id, service_id, trip_id, headsign, short_name, shape_id, prefix), t_routes(route_id, agency_id,
 *    route_type, short, long, desc, color): trips.txt and routes.txt
 * Nothing is written outside the framework's own calls, and the source files are never changed.
 */
export interface LoadApi {
  feed: FeedRef;
  /** Normalized (lower-case) column names of one of the feed's GTFS files; null when the feed has no such file. */
  columns(file: string): ReadonlySet<string> | null;
  /** Read-only query (SELECT / WITH) over the tables above. */
  all<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  scalar(sql: string): Promise<number>;
  /**
   * Drops trips: `selectTripKeys` is a query returning trip_key values. The framework limits it to the adapter's
   * scope (its agencies' routes), logs `reason` with the count and returns the number of trips dropped.
   */
  dropTrips(selectTripKeys: string, reason: string): Promise<number>;
}

/** A route as the build stage sees it (build.ts, when the route of a trip is created). */
export interface RouteFacts {
  feed: FeedRef;
  /** Agency name after options.agencyName. */
  agency: string;
  /** Display name of the route ("ICE", "TER", "Paris-Gare-de-Lyon/Marseille-St-Charles"). */
  name: string;
  short: string;
  long: string;
  /** Cat bit of the trip. */
  cat: number;
  routeType: number | null;
}

/** What a route hook may add to a route. */
export interface RouteExtras {
  /**
   * Brand shown for a route named only by where it runs (Route.brand; routeBrand in @etbm/shared): an operator whose
   * trains carry only their end stations as the name.
   */
  brand?: string;
  /** A high-speed service although its names carry no high-speed brand (steers rail geometry; geometry/guide.ts). */
  highSpeed?: boolean;
}

export interface OperatorAdapter {
  /** Unique id, equal to the file name without .ts (e.g. "sncf" for sncf.ts). Adapters run in id order. */
  id: string;
  /** One or two sentences: what the operator's data does differently and what the adapter does about it. */
  description: string;
  appliesTo: OperatorScope;
  /**
   * Feed options (feeds.ts FeedOptions) for every feed of appliesTo.feeds, merged into the feed's options when the
   * config is loaded. An option may be set by one source only: feeds.json or one adapter.
   */
  feedOptions?: Partial<FeedOptions>;
  /** Feeds this adapter adds to the build, each inserted right after the feed `after` (keeps feed order stable). */
  extraFeeds?: { after: string; def: FeedDef }[];
  /**
   * The operator has its own feed(s): routes of other feeds whose agency, route short or long name matches
   * `pattern` (case-insensitive) are skipped when one of `feeds` is in the build; their boarding / alighting
   * restrictions are kept as hints for the operator's trips (limit_hints).
   */
  exclusive?: { pattern: string; feeds: string[] };
  classify?: ClassifyHooks;
  onLoad?(api: LoadApi): Promise<void>;
  /** Build-time extras for a route in scope; undefined = nothing to add. Called once per route and trip category. */
  route?(r: RouteFacts): RouteExtras | undefined;
}

/** Identity helper for adapter files: `export default defineOperator({ ... })` gives type checking. */
export function defineOperator(a: OperatorAdapter): OperatorAdapter {
  return a;
}
