/** App state ⇄ URL hash. */
import type { Net } from "../data/net.ts";
import { cityByRef } from "../data/net.ts";
import { isValidDate } from "../logic/calendar.ts";
import { ALL_CATS, decodeCats, encodeCats, LOCAL_LETTER, localOn, type Filters } from "../logic/filters.ts";
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
   * The schedule (URL `trip=sofar` instead of `trip=1`) is the journey so far, opened from the connections at its end:
   * back returns to those connections (keeping their scope, `wholeCity`) instead of the previous step.
   */
  review?: boolean;
  /**
   * Continue the journey of `legs` to this city (URL `next=<city>`): the journeys from the last leg's arrival city,
   * leaving after the arrival (transfer time, maximum wait), to append to the legs.
   */
  extend?: number;
  /**
   * The legs are journeys joined end to end (each one continuing the previous): the leg counts where the earlier
   * ones end, ascending (URL `parts=3,4`). Joining one is an edit of the journey (undone by Undo, see App.set); Back
   * goes to the journeys of the pair, as from any journey.
   */
  parts?: number[];
  /** Onward connections from every station of the last leg's arrival city, not only the arrival station (URL `onward=city`). */
  wholeCity?: boolean;
  /**
   * Connections with changes (URL `changes=1&mintransfer=10&wait=180|day`, only values that differ from the defaults; the
   * minimum transfer time and maximum wait are also remembered in localStorage as the viewer's defaults). Changes between
   * stations by bike or local transport (URL `xfer=bike` / `xfer=transit`, also remembered) apply to the onward connections from a whole city too, so the
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
  if (("legs" in patch || "schedule" in patch) && !("review" in patch)) delete next.review;
  if (("legs" in patch || "schedule" in patch) && !("wholeCity" in patch)) delete next.wholeCity;
  if (!next.legs.length) {
    delete next.schedule;
    delete next.wholeCity;
  }
  if (!next.schedule) {
    delete next.journey;
    delete next.review;
  }
  // the onward scope is the connections': kept under a schedule only to return to them
  if (next.schedule && !next.review) delete next.wholeCity;
  // the continuation search and the joined parts belong to the legs: other legs drop them unless named
  if (("legs" in patch || "dest" in patch) && !("extend" in patch)) delete next.extend;
  if ("legs" in patch && !("parts" in patch) && next.parts) next.parts = next.parts.filter((n) => n < next.legs.length);
  if (!next.legs.length) delete next.extend;
  if (!next.legs.length || !next.parts?.length) delete next.parts;
  return next;
}

/**
 * The view one level up from `s` (the panel's Back and Esc; never an edit undone, see App.undo): the continuation search
 * → the journey it continues; the journey so far opened from the connections → those connections; the connections
 * from a leg's end → the schedule of that leg's trip; a step-by-step journey's trip → the connections it was picked
 * from; a journey (or a single trip) → the journeys or departures of its pair; a pair → its origin city (or station);
 * a station → its city; a city → the map. Null on the map.
 */
export function upPatch(s: AppState): Partial<AppState> | null {
  if (s.city === undefined) return null;
  if (s.legs.length && s.dest !== undefined) {
    if (s.extend !== undefined) return { extend: undefined };
    if (s.review) return { schedule: undefined, wholeCity: s.wholeCity };
    if (!s.schedule) return { schedule: true };
    if (s.journey || s.legs.length === 1) return { legs: [] };
    return { legs: s.legs.slice(0, -1) };
  }
  if (s.dest !== undefined) return { dest: undefined };
  if (s.station !== undefined) return { station: undefined };
  return { city: undefined, date: undefined };
}

/** What a view is, for the breadcrumbs (see navPath). */
export type ViewLevel = "map" | "city" | "station" | "pair" | "connections" | "trip" | "journey" | "sofar" | "continue";

export function viewLevel(s: AppState): ViewLevel {
  if (s.city === undefined) return "map";
  if (s.dest === undefined || !s.legs.length) return s.dest !== undefined ? "pair" : s.station !== undefined ? "station" : "city";
  if (s.extend !== undefined) return "continue";
  if (!s.schedule) return "connections";
  if (s.review) return "sofar";
  return s.journey ? "journey" : "trip";
}

/**
 * The views above `s`, the farthest first (breadcrumbs): every step up to the origin city, without the map, the whole
 * city above one of its stations and the trips of a step-by-step journey before the last step (each one's connections
 * stand for it). The last one is where Back goes.
 */
export function navPath(s: AppState): { state: AppState; level: ViewLevel }[] {
  const out: { state: AppState; level: ViewLevel }[] = [];
  let cur = s;
  for (let i = 0; i < 64; i++) {
    const up = upPatch(cur);
    if (!up) break;
    cur = applyPatch(cur, up);
    const level = viewLevel(cur);
    if (level === "map") break;
    out.unshift({ state: cur, level });
  }
  const parent = out[out.length - 1];
  return out.filter((x, i) => x === parent || x.level !== "trip" && !(x.level === "city" && out[i + 1]?.level === "station"));
}

/**
 * The patch that removes the first or the last leg of the shown journey (at least two legs; `ends`: the arrival city of
 * every leg). Without its last leg the journey ends where that leg started; without its first one it starts where the
 * second leg boards (`date`: that departure's local date there, if not today) – the origin city, its date and the
 * joined parts follow. The destination becomes the city where the journey now ends (the pair whose journeys back
 * returns to), and the view stays the same: the whole journey (one leg left: that trip's schedule), or the journey so
 * far opened from the connections. Null when there is nothing to remove.
 */
export function removeLegPatch(s: AppState, end: "first" | "last", ends: readonly number[], date?: string): Partial<AppState> | null {
  const n = s.legs.length;
  if (n < 2 || ends.length !== n || s.city === undefined || !s.schedule) return null;
  const first = end === "first";
  const city = first ? ends[0]! : s.city;
  const legs = first ? s.legs.slice(1).map((l, i) => (i === 0 ? { ...l, from: city } : l)) : s.legs.slice(0, -1);
  const left = first ? ends.slice(1) : ends.slice(0, -1);
  // the journey cannot end where it starts (a destination equal to the origin is dropped): its first change then
  const dest = left[left.length - 1] !== city ? left[left.length - 1]! : left.find((c) => c !== city);
  if (dest === undefined) return null;
  const parts = (s.parts ?? []).map((p) => (first ? p - 1 : p)).filter((p) => p >= 1 && p < legs.length);
  return {
    ...(first ? { city, station: undefined, date } : {}),
    dest,
    legs,
    parts: parts.length ? parts : undefined,
    schedule: true,
    journey: s.journey && legs.length > 1 ? true : undefined,
    review: s.review || undefined,
    // the onward scope belongs to the connections at the end, which removing the first leg keeps
    wholeCity: s.review && first ? s.wholeCity : undefined,
    extend: undefined,
  };
}

/**
 * The patch that extends the shown journey on its own vehicles (at least one leg, a schedule shown): with "last" the last
 * leg rides on to its stop `stop` (pattern index, after the alighting stop) in city `city`, which becomes the
 * destination; with "first" the first leg boards earlier, at its stop `stop` in city `city`, which becomes the origin
 * (`date`: the departure's local date there, if not today). No change is added, the view stays the same (the whole
 * journey, a trip's schedule or the journey so far). Null when the stop does not extend the journey.
 */
export function extendLegPatch(s: AppState, end: "first" | "last", stop: number, city: number, date?: string): Partial<AppState> | null {
  const n = s.legs.length;
  if (!n || s.city === undefined || s.dest === undefined || !s.schedule || city < 0) return null;
  const view = { schedule: true, journey: s.journey || undefined, review: s.review || undefined, parts: s.parts, extend: undefined };
  if (end === "last") {
    const l = s.legs[n - 1]!;
    if (stop <= l.alight || city === s.city) return null;
    return { ...view, dest: city, legs: [...s.legs.slice(0, -1), { ...l, alight: stop }], wholeCity: undefined };
  }
  const l = s.legs[0]!;
  if (stop >= l.board || city === s.dest) return null;
  return { ...view, city, station: undefined, date, legs: [{ ...l, from: city, board: stop }, ...s.legs.slice(1)], wholeCity: s.review ? s.wholeCity : undefined };
}

/**
 * What the app records in a history entry (history.state.etbm; kept over reloads): `prev`, the URL hash of the entry
 * before it (when it was pushed from there); `undo`, what the edit that made it did (back to `prev` undoes it);
 * `redo`, the edit undone by going back from the next entry (forward redoes it).
 */
export interface Entry {
  prev?: string;
  undo?: string;
  redo?: { text: string; hash: string };
}

export function entryOf(state: unknown): Entry {
  const e = (state as { etbm?: unknown } | null)?.etbm;
  if (!e || typeof e !== "object") return {};
  const x = e as Record<string, unknown>;
  const r = x.redo as Record<string, unknown> | undefined;
  return {
    ...(typeof x.prev === "string" ? { prev: x.prev } : {}),
    ...(typeof x.undo === "string" ? { undo: x.undo } : {}),
    ...(r && typeof r.text === "string" && typeof r.hash === "string" ? { redo: { text: r.text, hash: r.hash } } : {}),
  };
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
    changeBy: x.changeBy === "bike" || x.changeBy === "transit" ? x.changeBy : "walk",
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
    changeBy: by === "bike" || by === "walk" || by === "transit" ? by : base.changeBy,
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
  const legs = city !== undefined && dest !== undefined ? decodeLegs(q.get("legs"), city) : [];
  const extend = legs.length ? cityByRef(net, q.get("next")) : undefined;
  const parts = legs.length ? parseParts(q.get("parts"), legs.length) : [];
  const trip = q.get("trip");
  return {
    ...(city !== undefined ? { city } : {}),
    ...(station && /^[a-z0-9-]{1,80}$/.test(station) ? { station } : {}),
    ...(dest !== undefined && dest !== city ? { dest } : {}),
    ...(isValidDate(date) ? { date } : {}),
    filters: { cats: f === null ? ALL_CATS : decodeCats(f), ...(f === null || f.includes(LOCAL_LETTER) ? {} : { local: false }) },
    legs,
    ...(legs.length && (trip === "1" || trip === "all" || trip === "sofar") ? { schedule: true } : {}),
    ...(legs.length && trip === "all" ? { journey: true } : {}),
    ...(legs.length && trip === "sofar" ? { review: true } : {}),
    ...(legs.length && q.get("onward") === "city" && (trip === null || trip === "sofar") ? { wholeCity: true } : {}),
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
    if (s.schedule) q.push(s.journey ? "trip=all" : s.review ? "trip=sofar" : "trip=1");
    if (s.wholeCity && (!s.schedule || s.review)) q.push("onward=city");
    if (s.parts?.length) q.push(`parts=${s.parts.join(",")}`);
    if (s.extend !== undefined) q.push(`next=${net.slug[s.extend]}`);
  }
  if (s.filters.cats !== ALL_CATS || !localOn(s.filters)) q.push(`modes=${encodeCats(s.filters.cats) + (localOn(s.filters) ? LOCAL_LETTER : "") || "none"}`);
  const x = s.xfer ?? DEFAULT_SETTINGS;
  if (x.transfers > 0) {
    q.push(`changes=${x.transfers}`);
    if (x.minTransfer !== DEFAULT_SETTINGS.minTransfer) q.push(`mintransfer=${x.minTransfer}`);
    if (x.maxWait !== DEFAULT_SETTINGS.maxWait) q.push(`wait=${x.maxWait === null ? "day" : x.maxWait}`);
  }
  if (x.changeBy === "bike" || x.changeBy === "transit") q.push(`xfer=${x.changeBy}`);
  return q.length ? `#${q.join("&")}` : "";
}
