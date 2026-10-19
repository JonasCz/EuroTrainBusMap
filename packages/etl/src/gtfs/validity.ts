/**
 * Is a feed still in date, and what to do when it is not. The service window of a GTFS zip (first and last day with
 * service in calendar.txt / calendar_dates.txt, and feed_info.txt's feed_end_date), read once per zip and kept beside
 * it (`<zip>.validity.json`, keyed by size and mtime), and the rule every stage applies before using a feed:
 *
 *  - in date: used as it is;
 *  - **stale** – its service ended before the build's first day, but not more than `staleMaxDays` (feeds.json,
 *    default STALE_MAX_DAYS = 2 years; `--stale-max-days`) before it: kept. The loader projects the feed's last valid
 *    service pattern onto the build window (`pickReferenceDays`: per weekday the typical day of its last
 *    REFERENCE_WEEKS weeks) and every route of it carries the expiry date (`Route.expired`, attribution `expired`),
 *    shown in the app as "Timetables out of date — expired 15 Jul 2025". The same for the local transport layer and
 *    the transit transfers (they read the feed's last weeks). Nothing is stored anywhere: the projection is computed
 *    from the zip on every build, so a feed comes back as current by itself when its source publishes a new timetable;
 *  - **too old** – ended more than `staleMaxDays` before the build: skipped with a warning (`expiredFeeds` in the
 *    build report), as are sources that disappear or stop parsing (failed downloads / generators).
 *
 *  - last service day: the latest end_date of a calendar.txt row with at least one weekday, or the latest
 *    calendar_dates.txt date with exception_type 1, whichever is later (the first service day likewise);
 *  - feed_end_date: "the dataset provides complete and reliable schedule information up to this date" – a feed
 *    whose bulk of service stops there and that runs on only a stray service afterwards (Zaragoza, Oct 2026) or a
 *    frequency-based one with a few holiday dates beyond it (Casablanca tram) is out of date from that day.
 *
 * A feed with neither (no calendar files, unreadable dates) counts as in date: the loader decides.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { listZip } from "./load.ts";
import { epochDayToIso, isoToEpochDay } from "../core/time.ts";
import { weekday } from "../core/calendar.ts";

/** Default cap on stale data: a feed whose service ended more than this many days before the build is skipped. */
export const STALE_MAX_DAYS = 730;
/** Weeks before a stale feed's end that its service pattern is taken from (per weekday, the typical day). */
export const REFERENCE_WEEKS = 6;

export interface FeedValidity {
  /** First day with service (YYYY-MM-DD), null when unknown. */
  firstService?: string | null;
  /** Last day with service (YYYY-MM-DD), null when the feed has no readable calendar. */
  lastService: string | null;
  /** feed_info.txt feed_end_date (YYYY-MM-DD), null when absent. */
  feedEnd: string | null;
}

/** "20261105" → "2026-11-05"; null for anything else. */
function ymd(s: string | undefined): string | null {
  const t = (s ?? "").trim();
  return /^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : null;
}

/** Split one CSV line (quoted fields with commas and doubled quotes). */
export function csvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') (cur += '"'), i++;
        else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") out.push(cur), (cur = "");
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Stream the rows of one file of a zip: `onRow(cells, column index by lower-case name)`. */
async function eachRow(zip: string, entry: string, onRow: (cells: string[], col: Map<string, number>) => void): Promise<void> {
  const p = spawn("unzip", ["-p", zip, entry], { stdio: ["ignore", "pipe", "ignore"] });
  const rl = createInterface({ input: p.stdout, crlfDelay: Infinity });
  let col: Map<string, number> | null = null;
  for await (const raw of rl) {
    const line = raw.replace(/^﻿/, "");
    if (!line.trim()) continue;
    const cells = csvLine(line);
    if (!col) {
      col = new Map(cells.map((c, i) => [c.trim().toLowerCase(), i]));
      continue;
    }
    onRow(cells, col);
  }
  await new Promise((r) => p.on("close", r));
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** Read the service window of a GTFS zip (no cache). */
export async function readFeedValidity(zip: string): Promise<FeedValidity> {
  const entries = listZip(zip);
  const find = (name: string) => entries.find((e) => e.split("/").pop()!.toLowerCase() === name && !e.startsWith("__MACOSX"));
  let last: string | null = null;
  let first: string | null = null;
  const later = (d: string | null) => {
    if (d && (!last || d > last)) last = d;
  };
  const earlier = (d: string | null) => {
    if (d && (!first || d < first)) first = d;
  };
  const cal = find("calendar.txt");
  if (cal)
    await eachRow(zip, cal, (c, col) => {
      if (WEEKDAYS.some((w) => (c[col.get(w) ?? -1] ?? "").trim() === "1")) {
        later(ymd(c[col.get("end_date") ?? -1]));
        earlier(ymd(c[col.get("start_date") ?? -1]));
      }
    });
  const cd = find("calendar_dates.txt");
  if (cd)
    await eachRow(zip, cd, (c, col) => {
      if ((c[col.get("exception_type") ?? -1] ?? "").trim() === "1") {
        const d = ymd(c[col.get("date") ?? -1]);
        later(d);
        earlier(d);
      }
    });
  let feedEnd: string | null = null;
  const fi = find("feed_info.txt");
  if (fi)
    await eachRow(zip, fi, (c, col) => {
      feedEnd ??= ymd(c[col.get("feed_end_date") ?? -1]);
    });
  return { firstService: first, lastService: last, feedEnd };
}

/** The service window of a zip, cached in `<zip>.validity.json` while the zip's size and mtime stay the same. */
export async function feedValidity(zip: string): Promise<FeedValidity> {
  const st = await stat(zip);
  const stamp = `v2:${st.size}:${Math.round(st.mtimeMs)}`;
  const cacheFile = zip + ".validity.json";
  if (existsSync(cacheFile)) {
    try {
      const j = JSON.parse(await readFile(cacheFile, "utf8")) as FeedValidity & { stamp?: string };
      if (j.stamp === stamp) return { firstService: j.firstService ?? null, lastService: j.lastService, feedEnd: j.feedEnd };
    } catch {
      /* re-read */
    }
  }
  const v = await readFeedValidity(zip);
  await writeFile(cacheFile, JSON.stringify({ ...v, stamp })).catch(() => {});
  return v;
}

/**
 * Why a feed is out of date for a build starting on `startDate`, or null when it is in date: its last service day,
 * or its feed_end_date, lies before the build's first day.
 */
export function expiredReason(v: FeedValidity, startDate: string): string | null {
  if (v.lastService && v.lastService < startDate) return `service ended on ${v.lastService}`;
  if (v.feedEnd && v.feedEnd < startDate) return `feed_info ends on ${v.feedEnd}${v.lastService && v.lastService > v.feedEnd ? ` (stray services to ${v.lastService})` : ""}`;
  return null;
}

/**
 * The day a feed out of date for a build starting on `startDate` ran out (the earlier of its last service day and its
 * feed_end_date, whichever made it out of date), or null when it is in date.
 */
export function expiryDate(v: FeedValidity, startDate: string): string | null {
  if (v.lastService && v.lastService < startDate) return v.feedEnd && v.feedEnd < v.lastService ? v.feedEnd : v.lastService;
  if (v.feedEnd && v.feedEnd < startDate) return v.feedEnd;
  return null;
}

/** What a build does with a feed: use it, keep it as stale (projected, labelled) or skip it (beyond the cap). */
export type FeedState =
  | { kind: "current" }
  /** `end`: the last day of its service (Route.expired); `from`: its first service day, when known */
  | { kind: "stale"; end: string; from: string | null; reason: string }
  | { kind: "too-old"; end: string; reason: string };

/** Whole days from `a` to `b` (YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  return isoToEpochDay(b) - isoToEpochDay(a);
}

/** The state of a feed for a build starting on `startDate` with stale data capped at `maxDays` days. */
export function feedState(v: FeedValidity, startDate: string, maxDays = STALE_MAX_DAYS): FeedState {
  const end = expiryDate(v, startDate);
  const reason = expiredReason(v, startDate);
  if (!end || !reason) return { kind: "current" };
  const age = daysBetween(end, startDate);
  if (age > maxDays) return { kind: "too-old", end, reason: `${reason}, ${age} days before the build (limit ${maxDays})` };
  return { kind: "stale", end, from: v.firstService ?? null, reason };
}

/** feedState of a zip (read through the cache); current when unreadable. */
export async function zipState(zip: string, startDate: string, maxDays = STALE_MAX_DAYS): Promise<FeedState> {
  try {
    return feedState(await feedValidity(zip), startDate, maxDays);
  } catch {
    return { kind: "current" };
  }
}

// ---------------------------------------------------------------- projection of a stale feed

/**
 * The days a stale feed's pattern is read from: the REFERENCE_WEEKS weeks up to its end, not before its first
 * service day. `from` and `days` (the window is `from` … `from + days − 1`).
 */
export function referenceWindow(end: string, firstService?: string | null, weeks = REFERENCE_WEEKS): { from: string; days: number } {
  let from = epochDayToIso(isoToEpochDay(end) - (weeks * 7 - 1));
  if (firstService && firstService > from && firstService <= end) from = firstService;
  return { from, days: daysBetween(from, end) + 1 };
}

/** One day of the reference window: its offset from the window's first day, the trips running and their services. */
export interface RefDay {
  offset: number;
  /** 0 = Monday … 6 = Sunday */
  weekday: number;
  trips: number;
  /** signature of the set of active services ("" when none run) */
  sig: string;
}

/**
 * Per weekday (0 = Monday … 6 = Sunday) the reference day a stale feed's service is projected from (its offset in
 * the window), or null when that weekday has no day in the window. Among the days of one weekday the most common set
 * of services wins (a holiday, with its own services or none, is outvoted by the ordinary weeks); a tie between sets
 * goes to the day whose trip count is closest to the weekday's median, then to the later day. A weekday whose most
 * common set is "nothing runs" stays without service.
 */
export function pickReferenceDays(days: RefDay[]): (number | null)[] {
  const out: (number | null)[] = [];
  for (let wd = 0; wd < 7; wd++) {
    const cands = days.filter((d) => d.weekday === wd);
    if (!cands.length) {
      out.push(null);
      continue;
    }
    const groups = new Map<string, RefDay[]>();
    for (const d of cands) groups.set(d.sig, [...(groups.get(d.sig) ?? []), d]);
    const top = Math.max(...[...groups.values()].map((g) => g.length));
    const tied = [...groups.values()].filter((g) => g.length === top).flat();
    const counts = cands.map((d) => d.trips).sort((a, b) => a - b);
    const median = counts.length % 2 ? counts[(counts.length - 1) / 2]! : (counts[counts.length / 2 - 1]! + counts[counts.length / 2]!) / 2;
    tied.sort((a, b) => Math.abs(a.trips - median) - Math.abs(b.trips - median) || b.offset - a.offset);
    const best = tied[0]!;
    out.push(best.trips > 0 ? best.offset : null);
  }
  return out;
}

/**
 * The projection of a stale feed onto the build: for every build day `startDate + i` (i from `fromDay` to `toDay`)
 * the reference day of its weekday (offset in the window starting `refFrom`), as [i, offset] pairs; weekdays
 * without a reference day get no service.
 */
export function projectionDays(startDate: string, fromDay: number, toDay: number, refFrom: string, picks: (number | null)[]): [number, number][] {
  const out: [number, number][] = [];
  const s = isoToEpochDay(startDate);
  for (let i = fromDay; i <= toDay; i++) {
    const p = picks[weekday(s + i)];
    if (p !== null && p !== undefined) out.push([i, p]);
  }
  return out;
}

/** Weekday (0 = Monday) of a YYYY-MM-DD date. */
export function isoWeekdayOf(iso: string): number {
  return weekday(isoToEpochDay(iso));
}
