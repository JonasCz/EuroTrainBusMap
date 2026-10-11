/**
 * Parse a GTFS time "HH:MM:SS" (hours may exceed 24, may be single digit,
 * surrounding whitespace allowed) into minutes after service-day midnight.
 * Seconds are truncated. Returns null for empty / invalid input.
 */
export function parseGtfsTime(s: string | null | undefined): number | null {
  if (s == null) return null;
  const t = s.trim();
  if (!t) return null;
  const m = /^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (min > 59) return null;
  return h * 60 + min;
}

/** Same as parseGtfsTime but for SQL: returns the DuckDB expression for column `col`. */
export function sqlGtfsTime(col: string): string {
  // try_cast handles garbage → NULL; trim handles " 7:05:00".
  return `(try_cast(split_part(trim(${col}), ':', 1) AS INTEGER) * 60 + try_cast(split_part(trim(${col}), ':', 2) AS INTEGER))`;
}

/** Parse YYYYMMDD into a UTC epoch-day number. */
export function parseGtfsDate(s: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}

export function epochDayToIso(d: number): string {
  return new Date(d * 86400000).toISOString().slice(0, 10);
}

export function isoToEpochDay(iso: string): number {
  return Math.floor(Date.parse(iso + "T00:00:00Z") / 86400000);
}

/** Today's date (YYYY-MM-DD) in the given timezone. */
export function todayIn(tz: string, now = new Date()): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(now);
}

const offsetCache = new Map<string, number>();
/**
 * UTC offset in minutes of timezone `tz` at local noon of epoch day `day`
 * (positive east of Greenwich, e.g. Europe/Berlin summer = 120).
 */
export function tzOffsetMinutes(tz: string, day: number): number {
  const key = tz + "|" + day;
  const c = offsetCache.get(key);
  if (c !== undefined) return c;
  let off = 0;
  try {
    const d = new Date(day * 86400000 + 12 * 3600000);
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" });
    const part = f.formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(part);
    if (m) off = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  } catch {
    off = 0;
  }
  offsetCache.set(key, off);
  return off;
}

/** Whether tz is a UTC-like zone (feeds using these give times in UTC). */
export function isUtcLike(tz: string | null | undefined): boolean {
  if (!tz) return false;
  return /^(utc|gmt|etc\/(utc|gmt|uct|zulu|universal)|universal|zulu|uct)$/i.test(tz.trim());
}

/** Normalize a timezone name; invalid → null. */
export function validTz(tz: string | null | undefined): string | null {
  if (!tz) return null;
  const t = tz.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: t });
    return t;
  } catch {
    return null;
  }
}
