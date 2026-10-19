/**
 * A small in-memory GTFS feed for the feed generators (types.ts): the tables the loader reads (gtfs/load.ts), a
 * validator that refuses a feed the loader would silently mangle (dangling ids, times going backwards, impossible
 * coordinates, no service in the build window) and a writer (CSV files + zip, read back by the loader with unzip).
 * Service days are explicit dates (calendar_dates.txt, exception_type 1): a generator computes the days a train
 * runs from the source's rules, which is simpler to check than weekday patterns with exceptions.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { epochDayToIso, isoToEpochDay } from "../core/time.ts";
import { weekday } from "../core/calendar.ts";
import { GeneratorError } from "./types.ts";
import { csvLine } from "../gtfs/validity.ts";

export interface GtfsAgency {
  agency_id: string;
  agency_name: string;
  agency_url: string;
  agency_timezone: string;
  agency_lang?: string;
}
export interface GtfsStop {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  stop_timezone?: string;
}
export interface GtfsRoute {
  route_id: string;
  agency_id: string;
  route_short_name: string;
  route_long_name: string;
  /** GTFS (extended) route type: 2 / 100–117 rail, 3 / 700 bus, 200 coach… */
  route_type: number;
  route_url?: string;
}
export interface GtfsTrip {
  route_id: string;
  service_id: string;
  trip_id: string;
  trip_headsign: string;
  /** Train / line number shown with the route name. */
  trip_short_name?: string;
}
export interface GtfsStopTime {
  trip_id: string;
  stop_sequence: number;
  stop_id: string;
  /** Minutes after midnight of the service day (may exceed 1440 past midnight). */
  arr: number;
  dep: number;
}
export interface GtfsFeed {
  agency: GtfsAgency[];
  stops: GtfsStop[];
  routes: GtfsRoute[];
  trips: GtfsTrip[];
  stopTimes: GtfsStopTime[];
  /** service_id → service dates (YYYY-MM-DD) */
  services: Map<string, string[]>;
  /**
   * feed_info.txt: publisher of the generated feed and where the data came from. `retrievedAt` (ISO time, UTC, set by
   * the registry when the generator starts reading the source) is written as feed_version: the version of a feed made
   * from a web page is the moment it was read; the build shows it next to the source link (readRetrievedAt).
   */
  info: {
    publisher: string;
    publisherUrl: string;
    lang: string;
    sourceUrl: string;
    retrievedAt?: string;
    /**
     * The source still parses but its timetable is out of date (an older timetable year, a source not re-confirmed
     * for too long): `until` is the last day it is valid for (YYYY-MM-DD), written as feed_info feed_end_date, and the
     * generator emits the service of the weeks up to it (staleServiceWindow in the registry). The build then treats
     * the feed like any expired GTFS feed: its last pattern is projected onto the build window and labelled
     * "Timetables out of date — expired {until}" (gtfs/validity.ts). `reason` goes to the build report.
     */
    stale?: { until: string; reason: string };
  };
}

/** YYYY-MM-DD ± n days. */
export function addDays(iso: string, n: number): string {
  return epochDayToIso(isoToEpochDay(iso) + n);
}
/** Day of week of a date: 0 = Monday … 6 = Sunday. */
export function isoWeekday(iso: string): number {
  return weekday(isoToEpochDay(iso));
}
/** Every date from `from` to `to` (inclusive). */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = isoToEpochDay(from), e = isoToEpochDay(to); d <= e; d++) out.push(epochDayToIso(d));
  return out;
}
/**
 * First day of the European annual timetable of `year` (the change takes effect at midnight after the second
 * Saturday of December, so the new timetable starts on the following Sunday): 2025-12-14, 2026-12-13.
 */
export function timetableChange(year: number): string {
  const dec1 = `${year}-12-01`;
  const firstSat = 5 - isoWeekday(dec1); // Saturday = 5
  return addDays(dec1, (firstSat + 7) % 7 + 7 + 1);
}
/** The annual timetable period containing `iso`: [first day, last day]. */
export function timetablePeriod(iso: string): { start: string; end: string } {
  const y = Number(iso.slice(0, 4));
  const ch = timetableChange(y);
  return iso >= ch ? { start: ch, end: addDays(timetableChange(y + 1), -1) } : { start: timetableChange(y - 1), end: addDays(ch, -1) };
}

/** "06:03" / "6:03" → minutes; null when not a time. */
export function parseHm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

/**
 * Check a generated feed; throws a GeneratorError naming the first problem. `window` = the build's service window:
 * at least one trip must run in it (a feed without service is an error, not an empty success) – for a stale feed
 * (info.stale) the window passed is its own last weeks (staleServiceWindow in the registry).
 */
export function validateGtfs(feed: GtfsFeed, window?: { from: string; to: string }): void {
  const fail = (m: string): never => {
    throw new GeneratorError(`invalid generated GTFS: ${m}`);
  };
  const uniq = <T>(rows: T[], key: (r: T) => string, what: string) => {
    const s = new Set<string>();
    for (const r of rows) {
      const k = key(r);
      if (!k) fail(`${what} with an empty id`);
      if (s.has(k)) fail(`duplicate ${what} "${k}"`);
      s.add(k);
    }
    return s;
  };
  if (!feed.agency.length) fail("no agency");
  const agencies = uniq(feed.agency, (a) => a.agency_id, "agency_id");
  for (const a of feed.agency) {
    if (!a.agency_name || !/^https?:\/\//.test(a.agency_url)) fail(`agency ${a.agency_id}: name and url required`);
    try {
      new Intl.DateTimeFormat("en", { timeZone: a.agency_timezone });
    } catch {
      fail(`agency ${a.agency_id}: unknown timezone ${a.agency_timezone}`);
    }
  }
  const stops = uniq(feed.stops, (s) => s.stop_id, "stop_id");
  for (const s of feed.stops)
    if (!s.stop_name || !(Math.abs(s.stop_lat) <= 90 && Math.abs(s.stop_lon) <= 180) || (s.stop_lat === 0 && s.stop_lon === 0)) fail(`stop ${s.stop_id}: bad name or coordinates`);
  const routes = uniq(feed.routes, (r) => r.route_id, "route_id");
  for (const r of feed.routes) {
    if (!agencies.has(r.agency_id)) fail(`route ${r.route_id}: unknown agency ${r.agency_id}`);
    if (!r.route_short_name && !r.route_long_name) fail(`route ${r.route_id}: no name`);
    if (!Number.isInteger(r.route_type)) fail(`route ${r.route_id}: bad route_type`);
  }
  const trips = uniq(feed.trips, (t) => t.trip_id, "trip_id");
  for (const t of feed.trips) {
    if (!routes.has(t.route_id)) fail(`trip ${t.trip_id}: unknown route ${t.route_id}`);
    const days = feed.services.get(t.service_id);
    if (!days) fail(`trip ${t.trip_id}: unknown service ${t.service_id}`);
  }
  for (const [id, days] of feed.services) for (const d of days) if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || epochDayToIso(isoToEpochDay(d)) !== d) fail(`service ${id}: bad date ${d}`);
  const byTrip = new Map<string, GtfsStopTime[]>();
  for (const st of feed.stopTimes) {
    if (!trips.has(st.trip_id)) fail(`stop_time of unknown trip ${st.trip_id}`);
    if (!stops.has(st.stop_id)) fail(`trip ${st.trip_id}: unknown stop ${st.stop_id}`);
    let l = byTrip.get(st.trip_id);
    if (!l) byTrip.set(st.trip_id, (l = []));
    l.push(st);
  }
  for (const t of feed.trips) {
    const l = (byTrip.get(t.trip_id) ?? []).sort((a, b) => a.stop_sequence - b.stop_sequence);
    if (l.length < 2) fail(`trip ${t.trip_id}: fewer than 2 stops`);
    let prev = -1;
    const seen = new Set<string>();
    for (const st of l) {
      if (!(st.arr >= 0 && st.dep >= st.arr && st.arr >= prev)) fail(`trip ${t.trip_id}: times go backwards at ${st.stop_id}`);
      if (seen.has(st.stop_id)) fail(`trip ${t.trip_id}: calls twice at ${st.stop_id}`);
      seen.add(st.stop_id);
      prev = st.dep;
    }
    if (l[l.length - 1]!.arr === l[0]!.dep) fail(`trip ${t.trip_id}: takes no time`);
  }
  if (window) {
    const running = feed.trips.some((t) => feed.services.get(t.service_id)!.some((d) => d >= window.from && d <= window.to));
    if (!running) fail(`no trip runs between ${window.from} and ${window.to}`);
  }
}

function csvCell(v: string | number | undefined): string {
  if (v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csv(header: string[], rows: (string | number | undefined)[][]): string {
  return [header.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n";
}
function hms(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}
const ymd = (iso: string) => iso.replace(/-/g, "");

/** The feed's files as text (file name → CSV). */
export function gtfsFiles(feed: GtfsFeed): Record<string, string> {
  const dates = [...feed.services.values()].flat().sort();
  return {
    "agency.txt": csv(["agency_id", "agency_name", "agency_url", "agency_timezone", "agency_lang"], feed.agency.map((a) => [a.agency_id, a.agency_name, a.agency_url, a.agency_timezone, a.agency_lang])),
    "stops.txt": csv(["stop_id", "stop_name", "stop_lat", "stop_lon", "stop_timezone"], feed.stops.map((s) => [s.stop_id, s.stop_name, s.stop_lat.toFixed(6), s.stop_lon.toFixed(6), s.stop_timezone])),
    "routes.txt": csv(["route_id", "agency_id", "route_short_name", "route_long_name", "route_type", "route_url"], feed.routes.map((r) => [r.route_id, r.agency_id, r.route_short_name, r.route_long_name, r.route_type, r.route_url])),
    "trips.txt": csv(["route_id", "service_id", "trip_id", "trip_headsign", "trip_short_name"], feed.trips.map((t) => [t.route_id, t.service_id, t.trip_id, t.trip_headsign, t.trip_short_name])),
    "stop_times.txt": csv(
      ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"],
      [...feed.stopTimes].sort((a, b) => (a.trip_id < b.trip_id ? -1 : a.trip_id > b.trip_id ? 1 : a.stop_sequence - b.stop_sequence)).map((s) => [s.trip_id, hms(s.arr), hms(s.dep), s.stop_id, s.stop_sequence]),
    ),
    "calendar_dates.txt": csv(["service_id", "date", "exception_type"], [...feed.services].flatMap(([id, ds]) => [...ds].sort().map((d) => [id, ymd(d), 1]))),
    "feed_info.txt": csv(
      ["feed_publisher_name", "feed_publisher_url", "feed_lang", "feed_start_date", "feed_end_date", "feed_version"],
      [[feed.info.publisher, feed.info.publisherUrl, feed.info.lang, dates.length ? ymd(dates[0]!) : undefined, feed.info.stale ? ymd(feed.info.stale.until) : dates.length ? ymd(dates[dates.length - 1]!) : undefined, feed.info.retrievedAt]],
    ),
  };
}

/** Write the feed as a GTFS zip at `dest` (atomically: a partial zip never replaces a good one). */
export async function writeGtfsZip(feed: GtfsFeed, dest: string, tmpRoot: string): Promise<void> {
  await mkdir(tmpRoot, { recursive: true });
  const dir = await mkdtemp(join(tmpRoot, "gtfs-"));
  try {
    const files = gtfsFiles(feed);
    for (const [n, text] of Object.entries(files)) await writeFile(join(dir, n), text);
    const tmpZip = join(dir, "feed.zip");
    execFileSync("zip", ["-q", "-X", "-j", tmpZip, ...Object.keys(files).map((n) => join(dir, n))], { stdio: ["ignore", "ignore", "pipe"] });
    await mkdir(dirname(dest), { recursive: true });
    await rename(tmpZip, dest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** "2026-10-19T17:53:12Z": a retrieval time as written to feed_info.txt. */
export const RETRIEVED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** The current time as a retrieval time (UTC, whole seconds). */
export function retrievalTime(d = new Date()): string {
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * When the source of a generated feed zip was read (feed_info.txt feed_version, see GtfsFeed.info), or null for a
 * zip without one (an older generated zip, or any downloaded feed).
 */
export function readRetrievedAt(zip: string): string | null {
  try {
    const text = execFileSync("unzip", ["-p", zip, "feed_info.txt"], { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
    const [head, row] = text.split(/\r?\n/);
    const i = csvLine(head ?? "").indexOf("feed_version");
    const v = i >= 0 ? csvLine(row ?? "")[i]?.trim() : undefined;
    return v && RETRIEVED_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Counts for logs and the build report. */
export function feedCounts(feed: GtfsFeed): { stops: number; routes: number; trips: number; stopTimes: number; serviceDays: number; firstDate?: string; lastDate?: string } {
  const days = [...new Set([...feed.services.values()].flat())].sort();
  return {
    stops: feed.stops.length,
    routes: feed.routes.length,
    trips: feed.trips.length,
    stopTimes: feed.stopTimes.length,
    serviceDays: days.length,
    ...(days.length ? { firstDate: days[0], lastDate: days[days.length - 1] } : {}),
  };
}
