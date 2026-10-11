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

/**
 * Human-readable day restriction of a calendar, e.g. "Fri, Sun only",
 * "Mon–Fri only", "not Sat", "only Fri 14 Nov". Returns null for (nearly)
 * daily services.
 */
export function weekdayNote(cal: CalIndex, calendar: number): string | null {
  const tot = new Array(7).fill(0) as number[];
  const run = new Array(7).fill(0) as number[];
  const runDays: number[] = [];
  for (let i = 0; i < cal.days; i++) {
    const wd = (((cal.start + i + 4) % 7) + 7) % 7;
    tot[wd]!++;
    if (runsOnDay(cal, calendar, i)) {
      run[wd]!++;
      runDays.push(i);
    }
  }
  if (runDays.length === 0) return "no service";
  if (runDays.length <= 3 && cal.days > 14) {
    return "only " + runDays.map((i) => formatDateShort(dateFromDayNumber(cal.start + i))).join(", ");
  }
  const set = WD_ORDER.filter((wd) => tot[wd]! > 0 && run[wd]! / tot[wd]! >= 0.5);
  if (set.length === 7 || set.length === 0) return null;
  if (set.length === 6) {
    const missing = WD_ORDER.find((wd) => !set.includes(wd))!;
    return `not ${WD_SHORT[missing]}`;
  }
  // contiguous run in Mon..Sun order of length ≥ 3 → range
  const pos = set.map((wd) => WD_ORDER.indexOf(wd));
  const contiguous = pos.every((p, i) => i === 0 || p === pos[i - 1]! + 1);
  if (contiguous && set.length >= 3) return `${WD_SHORT[set[0]!]}–${WD_SHORT[set[set.length - 1]!]} only`;
  return `${set.map((wd) => WD_SHORT[wd]).join(", ")} only`;
}
