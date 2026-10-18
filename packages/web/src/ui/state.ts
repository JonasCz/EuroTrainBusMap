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
  /**
   * The legs are one journey picked from the journeys list (URL `trip=all` instead of `trip=1`): its schedule lists
   * every leg, and back returns to the list instead of the connections from the previous leg.
   */
  journey?: boolean;
  /**
   * Continue the journey of `legs` to this city (URL `next=<city>`): the journeys from the last leg's arrival city,
   * leaving after the arrival (transfer time, maximum wait), to append to the legs.
   */
  extend?: number;
  /**
   * The legs are journeys joined end to end (each one continuing the previous): the leg counts where the earlier
   * ones end, ascending (URL `parts=3,4`). Back from the joined journey drops the last continuation.
   */
  parts?: number[];
  /** Onward connections from every station of the last leg's arrival city, not only the arrival station (URL `onward=city`). */
  wholeCity?: boolean;
  /**
   * Connections with changes (URL `changes=1&mintransfer=10&wait=180|day`, only values that differ from the defaults; the
   * minimum transfer time and maximum wait are also remembered in localStorage as the viewer's defaults). Changes between
   * stations by bike (URL `xfer=bike`, also remembered) apply to the onward connections from a whole city too, so the
   * parameter is kept without `changes`.
   */
  xfer: TransferSettings;
}

/**
 * The state after `patch`: keys set to undefined are dropped, and what belongs to a changed part goes with it (a
 * station with its origin city, legs with the destination, the schedule / onward scope / continuation with the legs).
 */
export function applyPatch(state: AppState, patch: Partial<AppState>): AppState {
  const next: AppState = { ...state, ...patch };
  for (const k of Object.keys(patch) as (keyof AppState)[]) if (patch[k] === undefined) delete next[k];
  // a station belongs to its city: another origin city (or none) drops it, unless the patch names one
  if ("city" in patch && patch.city !== state.city && !("station" in patch)) delete next.station;
  if (next.city === undefined) {
    delete next.dest;
    delete next.station;
    next.legs = [];
  }
  if (next.dest === undefined) next.legs = [];
  // the trip schedule and the onward scope belong to the last leg: a new leg (or step) resets them unless named
  if ("legs" in patch && !("schedule" in patch)) delete next.schedule;
  if (("legs" in patch || "schedule" in patch) && !("journey" in patch)) delete next.journey;
  if (("legs" in patch || "schedule" in patch) && !("wholeCity" in patch)) delete next.wholeCity;
  if (!next.legs.length) {
    delete next.schedule;
    delete next.wholeCity;
  }
  if (!next.schedule) delete next.journey;
  // the continuation search and the joined parts belong to the legs: other legs drop them unless named
  if (("legs" in patch || "dest" in patch) && !("extend" in patch)) delete next.extend;
  if ("legs" in patch && !("parts" in patch) && next.parts) next.parts = next.parts.filter((n) => n < next.legs.length);
  if (!next.legs.length) delete next.extend;
  if (!next.legs.length || !next.parts?.length) delete next.parts;
  return next;
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
    localStorage.setItem(PREFS_KEY, JSON.stringify({ minTransfer: x.minTransfer, maxWait: x.maxWait, changeBy: x.changeBy ?? "walk" }));
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
    changeBy: x.changeBy === "bike" ? "bike" : "walk",
  };
}

function parseSettings(q: URLSearchParams): TransferSettings {
  const base = storedSettings();
  const num = (k: string) => (q.get(k) !== null && /^\d{1,4}$/.test(q.get(k)!) ? Number(q.get(k)) : undefined);
  const wait = q.get("wait"), by = q.get("xfer");
  return sanitize({
    transfers: num("changes") ?? 0,
    minTransfer: num("mintransfer") ?? base.minTransfer,
    maxWait: wait === "day" ? null : (num("wait") ?? base.maxWait),
    changeBy: by === "bike" || by === "walk" ? by : base.changeBy,
  });
}

/** Leg counts where joined journeys end: ascending, each between 1 and the number of legs − 1. */
function parseParts(v: string | null, legs: number): number[] {
  const out: number[] = [];
  for (const p of (v ?? "").split(",")) {
    if (!/^\d{1,3}$/.test(p)) break;
    const n = +p;
    if (n < 1 || n >= legs || (out.length && n <= out[out.length - 1]!)) break;
    out.push(n);
  }
  return out;
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
  const extend = legs.length ? cityByRef(net, q.get("next")) : undefined;
  const parts = legs.length ? parseParts(q.get("parts"), legs.length) : [];
  return {
    ...(city !== undefined ? { city } : {}),
    ...(station && /^[a-z0-9-]{1,80}$/.test(station) ? { station } : {}),
    ...(dest !== undefined && dest !== city ? { dest } : {}),
    ...(isValidDate(date) ? { date } : {}),
    filters: { cats: f === null ? ALL_CATS : decodeCats(f), ...(local ? {} : { local: false }) },
    legs,
    ...(legs.length && (q.get("trip") === "1" || q.get("trip") === "all") ? { schedule: true } : {}),
    ...(legs.length && q.get("trip") === "all" ? { journey: true } : {}),
    ...(legs.length && q.get("onward") === "city" ? { wholeCity: true } : {}),
    ...(extend !== undefined && extend !== city ? { extend } : {}),
    ...(parts.length ? { parts } : {}),
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
    if (s.schedule) q.push(s.journey ? "trip=all" : "trip=1");
    else if (s.wholeCity) q.push("onward=city");
    if (s.parts?.length) q.push(`parts=${s.parts.join(",")}`);
    if (s.extend !== undefined) q.push(`next=${net.slug[s.extend]}`);
  }
  if (s.filters.cats !== ALL_CATS) q.push(`modes=${encodeCats(s.filters.cats) || "none"}`);
  if (s.filters.local === false) q.push("local=0");
  const x = s.xfer ?? DEFAULT_SETTINGS;
  if (x.transfers > 0) {
    q.push(`changes=${x.transfers}`);
    if (x.minTransfer !== DEFAULT_SETTINGS.minTransfer) q.push(`mintransfer=${x.minTransfer}`);
    if (x.maxWait !== DEFAULT_SETTINGS.maxWait) q.push(`wait=${x.maxWait === null ? "day" : x.maxWait}`);
  }
  if (x.changeBy === "bike") q.push("xfer=bike");
  return q.length ? `#${q.join("&")}` : "";
}
