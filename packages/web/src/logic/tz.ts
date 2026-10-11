/**
 * Time zone helpers built on Intl (no tz database shipped).
 * All instants are UTC epoch milliseconds.
 */
import { dateFromDayNumber, dayNumber } from "./calendar.ts";

const MIN = 60_000;
const partsFmt = new Map<string, Intl.DateTimeFormat>();
const offsetCache = new Map<string, number>();

function fmtFor(tz: string): Intl.DateTimeFormat {
  let f = partsFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    partsFmt.set(tz, f);
  }
  return f;
}

/** Offset of `tz` at instant `utc`, in minutes (local − UTC). */
export function tzOffset(tz: string, utc: number): number {
  // offsets only change on quarter hours; cache per 15-minute bucket
  const bucket = Math.floor(utc / (15 * MIN));
  const key = `${tz}|${bucket}`;
  const hit = offsetCache.get(key);
  if (hit !== undefined) return hit;
  const p: Record<string, number> = {};
  for (const part of fmtFor(tz).formatToParts(new Date(bucket * 15 * MIN))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const local = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!);
  const off = Math.round((local - bucket * 15 * MIN) / MIN);
  if (offsetCache.size > 50_000) offsetCache.clear();
  offsetCache.set(key, off);
  return off;
}

/** Local wall-clock time (date + minutes after midnight) in `tz` → UTC instant. */
export function wallToUtc(date: string, minutes: number, tz: string): number {
  const naive = dayNumber(date) * 1440 * MIN + minutes * MIN;
  const off1 = tzOffset(tz, naive - tzOffset(tz, naive) * MIN);
  let t = naive - off1 * MIN;
  const off2 = tzOffset(tz, t);
  if (off2 !== off1) t = naive - off2 * MIN;
  return t;
}

/**
 * GTFS semantics: a service-day time is measured from "noon minus 12h" of the
 * service date in the trip's timezone (= local midnight except on DST days).
 */
export function serviceTimeToUtc(serviceDate: string, minutes: number, tz: string): number {
  return wallToUtc(serviceDate, 720, tz) + (minutes - 720) * MIN;
}

export interface LocalTime {
  date: string;
  /** minutes after local midnight, 0..1439 */
  minutes: number;
}

export function toLocal(utc: number, tz: string): LocalTime {
  const localMs = utc + tzOffset(tz, utc) * MIN;
  const day = Math.floor(localMs / (1440 * MIN));
  return { date: dateFromDayNumber(day), minutes: Math.floor((localMs - day * 1440 * MIN) / MIN) };
}

export function localDate(utc: number, tz: string): string {
  return toLocal(utc, tz).date;
}

/** "07:05" in the given zone. */
export function fmtTime(utc: number, tz: string): string {
  const { minutes } = toLocal(utc, tz);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Short zone name like "CET", "GMT+3" for display next to times. */
export function tzAbbr(utc: number, tz: string): string {
  try {
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(utc));
    return p.find((x) => x.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/** Day difference of `utc` (in tz) relative to the reference date. */
export function dayShift(utc: number, tz: string, refDate: string): number {
  return dayNumber(localDate(utc, tz)) - dayNumber(refDate);
}

/** "2 h 05" / "45 min" */
export function fmtDuration(min: number): string {
  min = Math.round(min);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h} h ${String(m).padStart(2, "0")}`;
}
