/**
 * Changes between two stations of a city by local public transport ("Transit" in the transfer settings): metro,
 * tram, light rail and suburban rail (RER, S-Bahn) from the local timetables. Buses are not used.
 *
 * The ETL (packages/etl/src/urban/transit.ts) runs a profile search over a reference week's timetables of a city's
 * rail-bound local transport and stores, per station pair and hour of the day (local time of the moment the
 * traveller is ready to leave the arrival station), the worst case of the door-to-door time over every minute of
 * that hour and over a weekday, a Saturday and a Sunday: walking from the station to the stop, waiting, riding,
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
export const TransitMode = { Tram: 1, Metro: 2, Rail: 4 } as const;

/** Hours of the day with a value per station pair. */
export const TRANSIT_BANDS = 24;
/** Station pairs up to this straight-line distance get transit times (metres). */
export const TRANSIT_MAX_M = 15_000;
/** Worst-case transit transfers longer than this (minutes, waiting included) are not stored (0, no service). */
export const TRANSIT_MAX_MIN = 300;

/**
 * Transit transfer of a station pair as stored by the ETL (`CityFile.transit`, transfer timetable chunks):
 * [stationA, stationB, TransitMode bits, minutes for hour 0, …, minutes for hour 23], stationA < stationB, the same
 * in both directions (the slower of the two); 0 = no service within `TRANSIT_MAX_MIN` in that hour.
 */
export type TransitPair = number[];

/**
 * Minutes of a transit transfer starting at `minuteOfDay` (local time, 0 … 1439) from the hourly worst cases
 * `bands[off] … bands[off + 23]` (0 = no service): the best of this hour's value and of waiting for a later hour
 * (wrapping to the next day); Infinity when there is no service at all.
 */
export function transitMinutes(bands: ArrayLike<number>, off: number, minuteOfDay: number): number {
  const m = Math.min(1439, Math.max(0, Math.floor(minuteOfDay)));
  const h = Math.floor(m / 60);
  let best = bands[off + h]! > 0 ? bands[off + h]! : Infinity;
  for (let k = 1; k <= TRANSIT_BANDS; k++) {
    const wait = (h + k) * 60 - m;
    if (wait >= best) break;
    const v = bands[off + ((h + k) % TRANSIT_BANDS)]!;
    if (v > 0 && wait + v < best) best = wait + v;
  }
  return best;
}

/**
 * The change between two stations of a city at `minuteOfDay` (local time of the moment the traveller is ready to
 * leave): with "transit", the transit time where there is one (`bands` from `off`) and it beats walking, else the walk;
 * otherwise as `changeOf`. `walkMin` is the stored walking time (undefined beyond walking / cycling range).
 * Undefined when neither is possible.
 */
export function changeAt(
  walkMin: number | undefined,
  bands: ArrayLike<number> | undefined,
  off: number,
  by: ChangeBy,
  minuteOfDay: number,
): { min: number; by: ChangeBy } | undefined {
  if (by !== "transit") return walkMin === undefined ? undefined : changeOf(walkMin, by);
  const walk = walkMin !== undefined && walkMin <= WALK_MAX_MIN ? walkMin : Infinity;
  const t = bands ? transitMinutes(bands, off, minuteOfDay) : Infinity;
  if (t < walk) return { min: t, by: "transit" };
  return walk < Infinity ? { min: walk, by: "walk" } : undefined;
}

/** Whether a stored transit pair ever beats walking (`walkMin` undefined: beyond walking range). */
export function transitUseful(bands: ArrayLike<number>, off: number, walkMin: number | undefined): boolean {
  const walk = walkMin !== undefined && walkMin <= WALK_MAX_MIN ? walkMin : Infinity;
  for (let h = 0; h < TRANSIT_BANDS; h++) if (bands[off + h]! > 0 && bands[off + h]! < walk) return true;
  return false;
}

/**
 * How the lines of a transit transfer are called locally: "metro/RER", "U-/S-Bahn", "Underground", "tram".
 * `modes` are TransitMode bits, `country` the ISO code of the city.
 */
export function transitModeLabel(modes: number, country: string): string {
  const de = country === "DE" || country === "AT" || country === "CH";
  const parts: string[] = [];
  const metro = modes & TransitMode.Metro, rail = modes & TransitMode.Rail;
  if (de && metro && rail) parts.push("U-/S-Bahn");
  else {
    if (metro) parts.push(de ? "U-Bahn" : country === "GB" ? "Underground" : "metro");
    if (rail) parts.push(de || country === "DK" ? (country === "DK" ? "S-tog" : "S-Bahn") : country === "FR" ? "RER" : "train");
  }
  if (modes & TransitMode.Tram) parts.push("tram");
  return parts.join("/") || "local transport";
}
