/**
 * The schedule of one vehicle run (a trip on a service date): every stop of its pattern with
 * the times shown in the trip view, split into the part before boarding, the ridden part and
 * the part after alighting.
 */
import type { CityFile, Route } from "@etbm/shared";
import { prepare, type NetCtx } from "./context.ts";
import type { Leg } from "./journey.ts";
import { dayShift, localDate, serviceTimeToUtc } from "./tz.ts";

/** A stop whose dwell is longer than this (minutes) shows its arrival and its departure. */
export const DWELL_SHOW_MIN = 5;

/** Which part of the run a stop lies in: before boarding, ridden (board..alight), after alighting. */
export type StopPart = "before" | "ride" | "after";

/** Which times a stop shows. */
export type StopShow = "dep" | "arr" | "both";

export interface ScheduleStop {
  /** Index in the pattern. */
  stop: number;
  station: number;
  city: number;
  /** Arrival instant (UTC ms); null at the first stop. */
  arrUtc: number | null;
  /** Departure instant (UTC ms); null at the last stop. */
  depUtc: number | null;
  /** Minutes between arrival and departure (0 at the ends). */
  dwell: number;
  /** Times shown: the departure (first / intermediate stops), the arrival (last stop, alighting stop) or both (dwell > DWELL_SHOW_MIN). */
  show: StopShow;
  part: StopPart;
  /** The hop from the previous stop / to the next one is ridden (draws the line in the mode colour). */
  rideIn: boolean;
  rideOut: boolean;
  /** Day of the shown (first) time in the stop's city tz, relative to the boarding date at the boarding stop (+1 after midnight). */
  dayShift: number;
  /** Onward connections from here make sense: a stop after boarding, outside the boarding city. */
  onward: boolean;
  /**
   * The stop that stands for its run of consecutive stops in one city (the alighting stop, else the best-ranked
   * station): where "connections from the whole city" is offered, once per city.
   */
  cityRep: boolean;
}

export interface TripSchedule {
  leg: Leg;
  pattern: number;
  route: Route;
  number?: string;
  headsign: string;
  /** IANA tz of the trip's times. */
  tripTz: string;
  board: number;
  alight: number;
  stops: ScheduleStop[];
  /** Local date and tz at the boarding stop: the reference for day shifts (as the timetable rows). */
  refDate: string;
  refTz: string;
  /** Corridors (hops) ridden board → alight, and those of the run before boarding / after alighting. */
  ride: number[];
  outside: number[];
}

/** Times a stop shows: first stop departure, last stop arrival, both on a long dwell. */
export function stopShow(i: number, n: number, dwell: number, alight: number): StopShow {
  if (i === 0) return "dep";
  if (i === n - 1) return "arr";
  if (dwell > DWELL_SHOW_MIN) return "both";
  return i === alight ? "arr" : "dep";
}

/** Part of the run of stop `i` for a ride board → alight. */
export function stopPart(i: number, board: number, alight: number): StopPart {
  return i < board ? "before" : i > alight ? "after" : "ride";
}

/** Per run of consecutive stops in the same city, the stop standing for it: `prefer` if in the run, else the lowest rank (first on ties). */
export function cityReps(cities: number[], prefer: number, rank: (i: number) => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < cities.length; ) {
    let j = i;
    while (j + 1 < cities.length && cities[j + 1] === cities[i]) j++;
    let best = i;
    if (prefer >= i && prefer <= j) best = prefer;
    else for (let k = i + 1; k <= j; k++) if (rank(k) < rank(best)) best = k;
    out.push(best);
    i = j + 1;
  }
  return out;
}

export function tripSchedule(cf: CityFile, ctx: NetCtx, leg: Leg): TripSchedule | null {
  const t = cf.trips[leg.trip];
  if (!t) return null;
  const [pi, start, , number] = t;
  const p = cf.patterns[pi];
  if (!p || leg.board >= leg.alight || leg.alight >= p.stations.length) return null;
  const route = cf.routes[p.route];
  if (!route) return null;
  const tz = prepare(cf, ctx).tz[pi]!;
  const n = p.stations.length;
  const boardCity = ctx.stationCity[p.stations[leg.board]!]!;
  const refTz = ctx.cityTz[boardCity] ?? tz;
  const refDate = localDate(serviceTimeToUtc(leg.date, start + p.dep[leg.board]!, tz), refTz);
  const stops: ScheduleStop[] = p.stations.map((station, i) => {
    const city = ctx.stationCity[station]!;
    const arrUtc = i === 0 ? null : serviceTimeToUtc(leg.date, start + p.arr[i]!, tz);
    const depUtc = i === n - 1 ? null : serviceTimeToUtc(leg.date, start + p.dep[i]!, tz);
    const dwell = i === 0 || i === n - 1 ? 0 : p.dep[i]! - p.arr[i]!;
    const show = stopShow(i, n, dwell, leg.alight);
    const shown = (show === "dep" ? depUtc : arrUtc)!;
    return {
      stop: i,
      station,
      city,
      arrUtc,
      depUtc,
      dwell,
      show,
      part: stopPart(i, leg.board, leg.alight),
      rideIn: i > leg.board && i <= leg.alight,
      rideOut: i >= leg.board && i < leg.alight,
      dayShift: dayShift(shown, ctx.cityTz[city] ?? tz, refDate),
      onward: i > leg.board && city !== boardCity,
      cityRep: false,
    };
  });
  for (const i of cityReps(stops.map((x) => x.city), leg.alight, (i) => ctx.stationRank[stops[i]!.station] ?? 0)) stops[i]!.cityRep = true;
  return {
    leg,
    pattern: pi,
    route,
    ...(number !== undefined ? { number } : {}),
    headsign: p.headsign,
    tripTz: tz,
    board: leg.board,
    alight: leg.alight,
    stops,
    refDate,
    refTz,
    ride: p.corridors.slice(leg.board, leg.alight),
    outside: [...p.corridors.slice(0, leg.board), ...p.corridors.slice(leg.alight)],
  };
}
