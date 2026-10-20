/**
 * Changes between two stations of a city by local public transport ("Transit" in the transfer settings): metro,
 * tram, light rail and suburban rail (RER, S-Bahn) from the local timetables, and local buses.
 *
 * The ETL (packages/etl/src/urban/transit.ts) runs a profile search over a reference week's timetables of a city's
 * rail-bound local transport; local buses (packages/etl/src/urban/bus-transfer.ts) are timed per bus line from its
 * departures and ride times, a direct ride from a stop near one station to a stop near the other (no change of
 * bus). Both store, per station pair and hour of the day (local time of the moment the
 * traveller is ready to leave the arrival station) and day type (Monday–Friday from a Wednesday, Saturday, Sunday),
 * the worst case of the door-to-door time over every minute of that hour: walking from the station to the stop, waiting, riding,
 * changing lines, walking to the other station and a buffer at each end. A late-evening hour with a train every
 * 15 minutes therefore counts the full 15 minutes of waiting; an hour in which the last train leaves counts the wait
 * for the first one in the morning (or has no value when that is beyond `TRANSIT_MAX_MIN`).
 *
 * Within an hour a later moment never does better than the stored value of that hour, but it may do better by
 * waiting at the station for the next hour (rush hour, the first metro): the transfer time at a given moment is the
 * best of the hour's value and every later hour's value plus the wait until it starts (`transitMinutes`). This also
 * makes the arrival at the other station never earlier for a later start, which the search relies on.
 *
 * Changes are by transit only where that beats walking (`changeAt`); otherwise, and at night without service,
 * the change is walked, as with the "Walk" setting.
 */

import { WALK_MAX_MIN, changeOf, type ChangeBy } from "./walk.ts";

/** Mode bits of the lines a transit transfer uses. */
export const TransitMode = { Tram: 1, Metro: 2, Rail: 4, Bus: 8 } as const;

/** Hours of the day with a value per station pair. */
export const TRANSIT_BANDS = 24;
/** Station pairs up to this straight-line distance get transit times (metres). */
export const TRANSIT_MAX_M = 15_000;
/** Worst-case transit transfers longer than this (minutes, waiting included) are not stored (0, no service). */
export const TRANSIT_MAX_MIN = 300;

/** Day types with values of their own: Monday–Friday (from a Wednesday), Saturday, Sunday. */
export const TRANSIT_DAYS = 3;
/** Hourly values per pair: TRANSIT_BANDS per day type. */
export const TRANSIT_VALUES = TRANSIT_DAYS * TRANSIT_BANDS;

/** Day type (0 Monday–Friday, 1 Saturday, 2 Sunday) of a weekday (0 = Monday … 6 = Sunday). */
export function transitDay(weekday: number): number {
  return weekday === 5 ? 1 : weekday === 6 ? 2 : 0;
}

/** Weekday (0 = Monday … 6 = Sunday) of a day number (days since 1970-01-01, a Thursday). */
export function weekdayOf(dayNumber: number): number {
  return (((dayNumber + 3) % 7) + 7) % 7;
}

/**
 * Transit transfer of a station pair as stored by the ETL (`CityFile.transit`, transfer timetable chunks):
 * [stationA, stationB, TransitMode bits, bus hours Monday–Friday, bus hours Saturday, bus hours Sunday, 24 minutes
 * Monday–Friday (hour 0 … 23), 24 minutes Saturday, 24 minutes Sunday], stationA < stationB, the same in both
 * directions (the slower of the two); 0 = no service within `TRANSIT_MAX_MIN` in that hour. Each hour holds the faster
 * of rail-bound transit and local bus; bit h of a day type's bus hours is set where that is the bus (TransitMode.Bus in
 * the mode bits when any is). The fewer buses of the evening, the night and the weekend show as longer values (the
 * wait for the next bus) or none.
 */
export type TransitPair = number[];

/** Numbers of a TransitPair before the hourly minutes. */
export const TRANSIT_HEAD = 3 + TRANSIT_DAYS;

/**
 * Minutes of a transit transfer (the TransitPair at `pair[off]`) starting on `weekday` (0 = Monday) at `minuteOfDay`
 * (local time, 0 … 1439): the best of this hour's worst case and of waiting for a later hour (into the next day);
 * Infinity when there is no service at all.
 */
export function transitMinutes(pair: ArrayLike<number>, off: number, weekday: number, minuteOfDay: number): number {
  return transitChoice(pair, off, weekday, minuteOfDay).min;
}

/** `transitMinutes` and the day type and hour whose value it uses (−1 without service). */
export function transitChoice(pair: ArrayLike<number>, off: number, weekday: number, minuteOfDay: number): { min: number; day: number; hour: number } {
  const m = Math.min(1439, Math.max(0, Math.floor(minuteOfDay)));
  const h = Math.floor(m / 60);
  const base = off + TRANSIT_HEAD;
  const d0 = transitDay(weekday), d1 = transitDay((weekday + 1) % 7);
  const v0 = pair[base + d0 * TRANSIT_BANDS + h]!;
  let best = v0 > 0 ? v0 : Infinity;
  let day = d0, hour = best < Infinity ? h : -1;
  for (let k = 1; k <= TRANSIT_BANDS; k++) {
    const wait = (h + k) * 60 - m;
    if (wait >= best) break;
    const dk = h + k >= TRANSIT_BANDS ? d1 : d0, hk = (h + k) % TRANSIT_BANDS;
    const v = pair[base + dk * TRANSIT_BANDS + hk]!;
    if (v > 0 && wait + v < best) {
      best = wait + v;
      day = dk;
      hour = hk;
    }
  }
  return { min: best, day, hour };
}

/**
 * The change between two stations of a city starting on `weekday` (0 = Monday) at `minuteOfDay` (local time of the
 * moment the traveller is ready to leave): with "transit", the transit time where there is one (the TransitPair
 * starting at `pair[off]`) and it beats walking, with the TransitMode bits of the lines taken (TransitMode.Bus alone
 * for a ride by local bus), else the walk; otherwise as `changeOf`. `walkMin` is the stored walking time (undefined
 * beyond walking / cycling range). Undefined when neither is possible.
 */
export function changeAt(
  walkMin: number | undefined,
  pair: ArrayLike<number> | undefined,
  off: number,
  by: ChangeBy,
  weekday: number,
  minuteOfDay: number,
): { min: number; by: ChangeBy; modes?: number } | undefined {
  if (by !== "transit") return walkMin === undefined ? undefined : changeOf(walkMin, by);
  const walk = walkMin !== undefined && walkMin <= WALK_MAX_MIN ? walkMin : Infinity;
  const t = pair ? transitChoice(pair, off, weekday, minuteOfDay) : null;
  if (t && t.min < walk) return { min: t.min, by: "transit", modes: transitModesAt(pair!, off, t.day, t.hour) };
  return walk < Infinity ? { min: walk, by: "walk" } : undefined;
}

/**
 * TransitMode bits of the lines a TransitPair (at `pair[off]`) uses on a day type in an hour: TransitMode.Bus, or the
 * rail-bound modes.
 */
export function transitModesAt(pair: ArrayLike<number>, off: number, day: number, hour: number): number {
  const modes = pair[off + 2]!;
  return hour >= 0 && pair[off + 3 + day]! & (1 << hour) ? TransitMode.Bus : modes & ~TransitMode.Bus;
}

/** Whether the hourly values `values[off …]` (TRANSIT_VALUES of them) ever beat walking (`walkMin` undefined: beyond walking range). */
export function transitUseful(values: ArrayLike<number>, off: number, walkMin: number | undefined): boolean {
  const walk = walkMin !== undefined && walkMin <= WALK_MAX_MIN ? walkMin : Infinity;
  for (let h = 0; h < TRANSIT_VALUES; h++) if (values[off + h]! > 0 && values[off + h]! < walk) return true;
  return false;
}

/**
 * How the lines of a transit transfer are called locally: "metro/RER", "U-/S-Bahn", "Underground", "tram", "local bus".
 * `modes` are TransitMode bits, `country` the ISO code of the city.
 */
export function transitModeLabel(modes: number, country: string): string {
  if (modes === TransitMode.Bus) return "local bus";
  const de = country === "DE" || country === "AT" || country === "CH";
  const parts: string[] = [];
  const metro = modes & TransitMode.Metro, rail = modes & TransitMode.Rail;
  if (de && metro && rail) parts.push("U-/S-Bahn");
  else {
    if (metro) parts.push(de ? "U-Bahn" : country === "GB" ? "Underground" : "metro");
    if (rail) parts.push(de || country === "DK" ? (country === "DK" ? "S-tog" : "S-Bahn") : country === "FR" ? "RER" : "train");
  }
  if (modes & TransitMode.Tram) parts.push("tram");
  if (modes & TransitMode.Bus) parts.push("bus");
  return parts.join("/") || "local transport";
}
