/**
 * Feed generators: for operators that publish no GTFS, one script per source (packages/etl/generators/<id>.ts, see
 * the README there) fetches the operator's timetable page / data, parses it and returns a GTFS feed. The registry
 * (registry.ts) runs it on every build, writes the feed as a zip into the feed cache and the feed then goes through
 * the normal pipeline (gtfs/load.ts) like a downloaded one. A generator that fails (page changed, unknown footnote,
 * network error…) throws: the source is logged and skipped, the build goes on without it. A source that still parses
 * but is out of date gives a feed flagged stale (GtfsFeed.info.stale), kept and labelled like an expired GTFS feed.
 */
import type { GtfsFeed } from "./gtfs.ts";
import type { Observation } from "./state.ts";
import type { MissingStop } from "./geocodes.ts";

export type { GtfsFeed } from "./gtfs.ts";

/** What a generator gets from the build. */
export interface GeneratorContext {
  /** First day of the build's timetable window (YYYY-MM-DD, the build's --start). */
  startDate: string;
  /** Length of the window in days (the build's --days); generators emit service dates from startDate − 1 to startDate + days. */
  days: number;
  /**
   * GET (or POST with `form`) a page with the build's User-Agent, a timeout and retries; throws after the last retry.
   * Responses other than 2xx are errors, and so are answers that do not match `expect` (a page cut off half-way).
   */
  fetchText(url: string, opts?: { form?: Record<string, string>; expect?: RegExp }): Promise<string>;
  /**
   * Record the normalised content of one timetable page (its tables and notes, not the rest of the page) under a
   * stable key. The build keeps the hash between runs (state.ts) and says whether the content changed since the last
   * build; this never affects whether the feed is built.
   */
  observe(key: string, content: string): Observation;
  /**
   * Stops of the timetable that have no reviewed coordinates (geocodes.ts) and the routes / trains / lines dropped for
   * it. The generator keeps building the rest; the report carries both so that an agent can geocode the stops
   * (`pnpm run geocode -- <id>`). Call once, with the store's `missing`.
   */
  needsGeocoding(missing: MissingStop[], dropped: string[]): void;
  /** Keys of the pages the last saved build observed for this generator (empty without state): pages that went away. */
  knownPages(): string[];
  log(msg: string): void;
  warn(msg: string): void;
}

export interface FeedGenerator {
  /** Unique id, equal to the file name without .ts; feeds.json refers to it as `{ "generated": "<id>" }`. */
  id: string;
  /** One or two sentences: what the source is and how it becomes GTFS. */
  description: string;
  /** The timetable page the data comes from: linked from the trips in the app and from the data sources list. */
  sourceUrl: string;
  /**
   * Fetch, parse and convert. Throw (GeneratorError or any Error) on anything unexpected – a changed page structure,
   * an unknown footnote: the build then skips this source instead of publishing wrong data. A source that parses
   * but is out of date (an older timetable year, data not re-confirmed for too long) is not an error: return the
   * feed with `info.stale` set and its service on the weeks before `info.stale.until` (staleServiceWindow).
   */
  generate(ctx: GeneratorContext): Promise<GtfsFeed>;
}

/** An expected failure of a generator: the source changed in a way the script does not know (message says what). */
export class GeneratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeneratorError";
  }
}

/** Identity helper for generator files: `export default defineGenerator({ ... })` gives type checking. */
export function defineGenerator(g: FeedGenerator): FeedGenerator {
  return g;
}

/** Outcome of one generator run (build report, `generate` CLI). */
export interface GeneratorReport {
  id: string;
  feed: string;
  sourceUrl: string;
  ok: boolean;
  /** Why the source was skipped (ok = false). */
  error?: string;
  /** Warnings of the run (data the script kept out, fallbacks). */
  warnings: string[];
  seconds: number;
  /** When the generator started reading its source (ISO, UTC): the feed's feed_info feed_version, shown in the app. */
  retrievedAt?: string;
  /** The source parsed but is out of date (GtfsFeed.info.stale): kept, projected and labelled by the build. */
  stale?: { until: string; reason: string };
  /** Pages observed with ctx.observe: content hash, whether it changed since the last build and when it last did. */
  pages?: Observation[];
  /** Stops waiting for geocoding and what was left out of the feed because of them (the rest of the feed is built). */
  needsGeocoding?: { stops: MissingStop[]; dropped: string[] };
  /** Pages of the last build that this run did not see any more. */
  removedPages?: string[];
  counts?: { stops: number; routes: number; trips: number; stopTimes: number; serviceDays: number; firstDate?: string; lastDate?: string };
}
