/**
 * Service-day calendars: base64 little-endian bitmasks, bit i = runs on
 * startDate + i. Dates are plain "YYYY-MM-DD" strings (calendar dates, no tz).
 */
import type { CalendarsFile } from "@etbm/shared";

const DAY_MS = 86_400_000;
const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export interface CalIndex {
  startDate: string;
  days: number;
  /** Day number (days since 1970-01-01) of startDate. */
  start: number;
  masks: Uint8Array[];
  /** Whether each calendar runs on at least one day of the horizon. */
  anyDay: boolean[];
}

export function decodeMask(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeMask(bits: boolean[]): string {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => {
    if (b) bytes[i >> 3]! |= 1 << (i & 7);
  });
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function buildCalIndex(file: CalendarsFile): CalIndex {
  const masks = file.masks.map(decodeMask);
  return {
    startDate: file.startDate,
    days: file.days,
    start: dayNumber(file.startDate),
    masks,
    anyDay: masks.map((m) => m.some((b) => b !== 0)),
  };
}

/** Days since 1970-01-01 for a YYYY-MM-DD date. */
export function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(Date.UTC(y!, m! - 1, d!) / DAY_MS);
}

export function dateFromDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  return dateFromDayNumber(dayNumber(date) + n);
}

export function isValidDate(s: string | null | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(date: string): number {
  return (((dayNumber(date) + 4) % 7) + 7) % 7;
}

export function runsOnDay(cal: CalIndex, calendar: number, dayIdx: number): boolean {
  if (dayIdx < 0 || dayIdx >= cal.days) return false;
  const m = cal.masks[calendar];
  if (!m) return false;
  return ((m[dayIdx >> 3] ?? 0) & (1 << (dayIdx & 7))) !== 0;
}

export function runsOnDate(cal: CalIndex, calendar: number, date: string): boolean {
  return runsOnDay(cal, calendar, dayNumber(date) - cal.start);
}

export function inHorizon(cal: CalIndex, date: string): boolean {
  const i = dayNumber(date) - cal.start;
  return i >= 0 && i < cal.days;
}

export function lastDate(cal: CalIndex): string {
  return dateFromDayNumber(cal.start + cal.days - 1);
}

/** "Fri 14 Nov" */
export function formatDateShort(date: string): string {
  const n = dayNumber(date);
  const d = new Date(n * DAY_MS);
  return `${WD_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`;
}

const WD_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun

/** A day mask over the calendar horizon (bit i = day startDate + i), like CalIndex.masks. */
export type DayMask = Uint8Array;

export function maskHas(m: DayMask, i: number): boolean {
  return i >= 0 && ((m[i >> 3] ?? 0) & (1 << (i & 7))) !== 0;
}

/**
 * Days on which a trip of `calendar` departs, when its departure falls `shift` days after
 * its service day (e.g. +1 for a departure at 25:10). Days outside the horizon are dropped.
 */
export function departureMask(cal: CalIndex, calendar: number, shift = 0): DayMask {
  const out = new Uint8Array(Math.ceil(cal.days / 8));
  for (let i = 0; i < cal.days; i++) if (runsOnDay(cal, calendar, i - shift)) out[i >> 3]! |= 1 << (i & 7);
  return out;
}

/** a |= b */
export function orMask(a: DayMask, b: DayMask): DayMask {
  for (let i = 0; i < a.length; i++) a[i]! |= b[i] ?? 0;
  return a;
}

const dateOf = (cal: CalIndex, i: number) => dateFromDayNumber(cal.start + i);
/** "11 Oct" */
function dayMonth(date: string): string {
  const d = new Date(dayNumber(date) * DAY_MS);
  return `${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`;
}

/** "Daily", "Daily except Sat", "Mon–Fri", "Sun only", "Mon, Thu" (Mon..Sun order). */
function weekdaySetLabel(set: number[]): string {
  if (set.length === 7) return "Daily";
  if (set.length === 1) return `${WD_SHORT[set[0]!]} only`;
  const pos = set.map((wd) => WD_ORDER.indexOf(wd));
  const contiguous = pos.every((p, i) => i === 0 || p === pos[i - 1]! + 1);
  if (contiguous && set.length >= 3) return `${WD_SHORT[set[0]!]}–${WD_SHORT[set[set.length - 1]!]}`;
  if (set.length >= 5) return `Daily except ${WD_ORDER.filter((wd) => !set.includes(wd)).map((wd) => WD_SHORT[wd]).join(", ")}`;
  return set.map((wd) => WD_SHORT[wd]).join(", ");
}

/** "runs 11, 18, 25 Oct +3" */
function dateList(cal: CalIndex, days: number[], show = 3): string {
  const shown = days.slice(0, show).map((i) => dayMonth(dateOf(cal, i)).split(" ") as [string, string]);
  const parts = shown.map(([d, m], k) => (shown[k + 1]?.[1] === m ? d : `${d} ${m}`));
  return `runs ${parts.join(", ")}${days.length > show ? ` +${days.length - show}` : ""}`;
}

/**
 * Exact human-readable description of the days in `mask`, e.g. "Mon–Fri", "Sun only",
 * "Daily except Sat", "Mon–Fri except 2 dates", "Sat, Sun until 30 Nov", "runs 11, 18, 25 Oct +5".
 * Returns null for a service that runs every day of the horizon.
 *
 * A weekday set is only claimed when it is (nearly) exact: every weekday in the set runs
 * on (almost) all of its dates within the service period, and the others (almost) never.
 */
export function daysNote(cal: CalIndex, mask: DayMask): string | null {
  const D = cal.days;
  const runDays: number[] = [];
  for (let i = 0; i < D; i++) if (maskHas(mask, i)) runDays.push(i);
  if (!runDays.length) return "no service";
  if (runDays.length <= 3 && D > 14) return "only " + runDays.map((i) => formatDateShort(dateOf(cal, i))).join(", ");
  // service period: first..last running day; gaps of under a week at the horizon edges are
  // explained by the weekday pattern itself
  let lo = runDays[0]!, hi = runDays[runDays.length - 1]!;
  if (lo < 7) lo = 0;
  if (hi > D - 8) hi = D - 1;
  const tot = new Array(7).fill(0) as number[];
  const run = new Array(7).fill(0) as number[];
  for (let i = lo; i <= hi; i++) {
    const wd = (((cal.start + i + 4) % 7) + 7) % 7;
    tot[wd]!++;
    if (maskHas(mask, i)) run[wd]!++;
  }
  // per weekday, the choice (in / out of the set) with fewer exceptions
  const set = WD_ORDER.filter((wd) => tot[wd]! > 0 && run[wd]! * 2 > tot[wd]!);
  const missing: number[] = [], extra: number[] = [];
  for (let i = lo; i <= hi; i++) {
    const wd = (((cal.start + i + 4) % 7) + 7) % 7;
    const on = maskHas(mask, i);
    if (set.includes(wd) && !on) missing.push(i);
    else if (!set.includes(wd) && on) extra.push(i);
  }
  const setDays = set.reduce((a, wd) => a + tot[wd]!, 0);
  if (!set.length || missing.length > Math.max(3, Math.floor(0.1 * setDays)) || extra.length > 2) return dateList(cal, runDays);
  let note = weekdaySetLabel(set);
  const dates = (l: number[]) => l.map((i) => formatDateShort(dateOf(cal, i))).join(", ");
  if (missing.length) {
    const what = missing.length <= 2 ? dates(missing) : `${missing.length} ${note.includes("except") ? "other " : ""}dates`;
    note += note.includes("except") ? ` and ${what}` : ` except ${what}`;
  }
  if (extra.length) note += `, also ${dates(extra)}`;
  if (lo > 0) note += ` from ${dayMonth(dateOf(cal, lo))}`;
  if (hi < D - 1) note += ` until ${dayMonth(dateOf(cal, hi))}`;
  return note === "Daily" ? null : note;
}

/** Day restriction of a calendar (service days), see daysNote. */
export function weekdayNote(cal: CalIndex, calendar: number): string | null {
  return daysNote(cal, departureMask(cal, calendar));
}
