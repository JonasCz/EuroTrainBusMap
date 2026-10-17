/** App state ⇄ URL hash. */
import type { Net } from "../data/net.ts";
import { cityByRef } from "../data/net.ts";
import { isValidDate } from "../logic/calendar.ts";
import { ALL_CATS, decodeCats, encodeCats, type Filters } from "../logic/filters.ts";
import { decodeLegs, encodeLegs, type Leg } from "../logic/journey.ts";
import { DEFAULT_SETTINGS, MAX_TRANSFERS, type TransferSettings } from "../logic/transfer.ts";

export interface AppState {
  city?: number;
  /** Origin narrowed to one station of `city` (slug of its short name, see stationSlug); unset = the whole city. */
  station?: string;
  dest?: number;
  /** Selected date (origin-local), undefined = today. */
  date?: string;
  filters: Filters;
  /** Journey legs; legs[0] departs from `city`. `from` of later legs is resolved lazily (-1). */
  legs: Leg[];
  /** Show the schedule (all stops) of the last leg's trip instead of the connections from its end (URL `trip=1`). */
  schedule?: boolean;
  /** Onward connections from every station of the last leg's arrival city, not only the arrival station (URL `onward=city`). */
  wholeCity?: boolean;
  /**
   * Connections with changes (URL `changes=1&mintransfer=10&wait=180|day`, only values that differ from the defaults; the
   * minimum transfer time and maximum wait are also remembered in localStorage as the viewer's defaults).
   */
  xfer: TransferSettings;
}

const PREFS_KEY = "etbm.transfers";

/** The viewer's remembered minimum transfer time / maximum wait (defaults when the URL names none). */
export function storedSettings(): TransferSettings {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<TransferSettings> | null;
    if (v && typeof v === "object") return sanitize({ ...DEFAULT_SETTINGS, ...v, transfers: 0 });
  } catch {
    /* no storage */
  }
  return DEFAULT_SETTINGS;
}

export function storeSettings(x: TransferSettings): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ minTransfer: x.minTransfer, maxWait: x.maxWait }));
  } catch {
    /* no storage */
  }
}

function sanitize(x: TransferSettings): TransferSettings {
  const int = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  return {
    transfers: int(x.transfers, 0, MAX_TRANSFERS, 0),
    minTransfer: int(x.minTransfer, 0, 120, DEFAULT_SETTINGS.minTransfer),
    maxWait: x.maxWait === null ? null : int(x.maxWait, 15, 24 * 60, 180),
  };
}

function parseSettings(q: URLSearchParams): TransferSettings {
  const base = storedSettings();
  const num = (k: string) => (q.get(k) !== null && /^\d{1,4}$/.test(q.get(k)!) ? Number(q.get(k)) : undefined);
  const wait = q.get("wait");
  return sanitize({
    transfers: num("changes") ?? 0,
    minTransfer: num("mintransfer") ?? base.minTransfer,
    maxWait: wait === "day" ? null : (num("wait") ?? base.maxWait),
  });
}

export function parseHash(net: Net, hash: string): AppState {
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  const city = cityByRef(net, q.get("from"));
  const dest = city !== undefined ? cityByRef(net, q.get("to")) : undefined;
  const station = city !== undefined ? q.get("station") : null;
  const date = q.get("date");
  const f = q.get("modes");
  const local = q.get("local") !== "0";
  const legs = city !== undefined && dest !== undefined ? decodeLegs(q.get("legs"), city) : [];
  return {
    ...(city !== undefined ? { city } : {}),
    ...(station && /^[a-z0-9-]{1,80}$/.test(station) ? { station } : {}),
    ...(dest !== undefined && dest !== city ? { dest } : {}),
    ...(isValidDate(date) ? { date } : {}),
    filters: { cats: f === null ? ALL_CATS : decodeCats(f), ...(local ? {} : { local: false }) },
    legs,
    ...(legs.length && q.get("trip") === "1" ? { schedule: true } : {}),
    ...(legs.length && q.get("onward") === "city" ? { wholeCity: true } : {}),
    xfer: parseSettings(q),
  };
}

export function toHash(net: Net, s: AppState): string {
  const q: string[] = [];
  if (s.city !== undefined) q.push(`from=${net.slug[s.city]}`);
  if (s.city !== undefined && s.station) q.push(`station=${s.station}`);
  if (s.city !== undefined && s.dest !== undefined) q.push(`to=${net.slug[s.dest]}`);
  if (s.date && s.city !== undefined) q.push(`date=${s.date}`);
  if (s.legs.length && s.dest !== undefined) {
    q.push(`legs=${encodeLegs(s.legs)}`);
    if (s.schedule) q.push("trip=1");
    else if (s.wholeCity) q.push("onward=city");
  }
  if (s.filters.cats !== ALL_CATS) q.push(`modes=${encodeCats(s.filters.cats) || "none"}`);
  if (s.filters.local === false) q.push("local=0");
  const x = s.xfer ?? DEFAULT_SETTINGS;
  if (x.transfers > 0) {
    q.push(`changes=${x.transfers}`);
    if (x.minTransfer !== DEFAULT_SETTINGS.minTransfer) q.push(`mintransfer=${x.minTransfer}`);
    if (x.maxWait !== DEFAULT_SETTINGS.maxWait) q.push(`wait=${x.maxWait === null ? "day" : x.maxWait}`);
  }
  return q.length ? `#${q.join("&")}` : "";
}
