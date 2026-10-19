/**
 * Is a feed still in date? The service window of a GTFS zip (last day with service in calendar.txt /
 * calendar_dates.txt, and feed_info.txt's feed_end_date), read once per zip and kept beside it
 * (`<zip>.validity.json`, keyed by size and mtime), and the rule every stage applies before using a feed: a feed
 * whose service ended before the build's first day is skipped with a warning (load, local transport layer,
 * transit transfers), so an expired feed drops out of the build – and the attribution – by itself, and comes back
 * when its source publishes a new timetable.
 *
 *  - last service day: the latest end_date of a calendar.txt row with at least one weekday, or the latest
 *    calendar_dates.txt date with exception_type 1, whichever is later;
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

export interface FeedValidity {
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
  const later = (d: string | null) => {
    if (d && (!last || d > last)) last = d;
  };
  const cal = find("calendar.txt");
  if (cal)
    await eachRow(zip, cal, (c, col) => {
      if (WEEKDAYS.some((w) => (c[col.get(w) ?? -1] ?? "").trim() === "1")) later(ymd(c[col.get("end_date") ?? -1]));
    });
  const cd = find("calendar_dates.txt");
  if (cd)
    await eachRow(zip, cd, (c, col) => {
      if ((c[col.get("exception_type") ?? -1] ?? "").trim() === "1") later(ymd(c[col.get("date") ?? -1]));
    });
  let feedEnd: string | null = null;
  const fi = find("feed_info.txt");
  if (fi)
    await eachRow(zip, fi, (c, col) => {
      feedEnd ??= ymd(c[col.get("feed_end_date") ?? -1]);
    });
  return { lastService: last, feedEnd };
}

/** The service window of a zip, cached in `<zip>.validity.json` while the zip's size and mtime stay the same. */
export async function feedValidity(zip: string): Promise<FeedValidity> {
  const st = await stat(zip);
  const stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
  const cacheFile = zip + ".validity.json";
  if (existsSync(cacheFile)) {
    try {
      const j = JSON.parse(await readFile(cacheFile, "utf8")) as FeedValidity & { stamp?: string };
      if (j.stamp === stamp) return { lastService: j.lastService, feedEnd: j.feedEnd };
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

/** expiredReason for a zip (read through the cache); null when in date or unreadable. */
export async function zipExpired(zip: string, startDate: string): Promise<string | null> {
  try {
    return expiredReason(await feedValidity(zip), startDate);
  } catch {
    return null;
  }
}
