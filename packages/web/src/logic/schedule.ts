/**
 * The schedule of one vehicle run (a trip on a service date): every stop of its pattern with
 * the times shown in the trip view, split into the part before boarding, the ridden part and
 * the part after alighting.
 */
import { StopLimit, canAlight, stopLimit, type CityFile, type Route, type ScheduleFile } from "@etbm/shared";
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
  /** Index in the pattern; −1 for a stop only listed in the schedule (ScheduleRun.via: not a destination, no connections). */
  stop: number;
  /** Station of a pattern stop (connections, map); −1 for a listed-only stop. */
  station: number;
  /** Name shown instead of the station's: a listed-only stop, or the real stop behind a town's main stop (ScheduleRun.at). */
  minorName?: string;
  /** City id; −1 for a listed-only stop outside every city. */
  city: number;
  /** IANA tz of the stop (its city's, else the trip's). */
  tz: string;
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
  /** Onward connections from here make sense: a pattern stop after boarding, outside the boarding city, where passengers may alight. */
  onward: boolean;
  /** Boarding / alighting restrictions of a pattern stop (StopLimit bits: drop-off only, boarding only); absent when none. */
  limit?: number;
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
  /** Indices in `stops` (not in the pattern) of the boarding and alighting stops. */
  board: number;
  alight: number;
  /** Every stop of the run, the pattern's and those only listed in the schedule (ScheduleRun.via), in travel order. */
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

/**
 * The schedule of a leg's trip. `sf` is the schedule file of the CityFile's timetable (scheduleFile): without it,
 * runs whose pattern leaves stops out (Pattern.run) list only the pattern's stops.
 */
export function tripSchedule(cf: CityFile, ctx: NetCtx, leg: Leg, sf?: ScheduleFile | null): TripSchedule | null {
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
  const run = p.run !== undefined ? sf?.runs[p.run] : undefined;
  const minor = (i: number) => sf?.stops[i];
  const at = new Map<number, number>();
  for (let k = 0; k + 1 < (run?.at?.length ?? 0); k += 2) at.set(run!.at![k]!, run!.at![k + 1]!);
  // pattern stops interleaved with the listed-only stops (via: [next, stop, arr, dep] quadruples, in travel order)
  interface Item { k: number; station: number; minorName?: string; city: number; arr: number; dep: number }
  const items: Item[] = [];
  const via = run?.via ?? [];
  let v = 0;
  for (let k = 0; k <= n; k++) {
    for (; v + 3 < via.length && via[v]! <= k; v += 4) {
      const m = minor(via[v + 1]!);
      items.push({ k: -1, station: -1, minorName: m?.[0] ?? "?", city: m?.[3] ?? -1, arr: via[v + 2]!, dep: via[v + 3]! });
    }
    if (k === n) break;
    const station = p.stations[k]!;
    const real = at.get(k);
    const name = real !== undefined ? minor(real)?.[0] : undefined;
    items.push({ k, station, ...(name !== undefined ? { minorName: name } : {}), city: ctx.stationCity[station]!, arr: p.arr[k]!, dep: p.dep[k]! });
  }
  const m = items.length;
  const board = items.findIndex((x) => x.k === leg.board);
  const alight = items.findIndex((x) => x.k === leg.alight);
  const stops: ScheduleStop[] = items.map((it, i) => {
    const city = it.city;
    const stz = (city >= 0 ? ctx.cityTz[city] : undefined) ?? tz;
    const arrUtc = i === 0 ? null : serviceTimeToUtc(leg.date, start + it.arr, tz);
    const depUtc = i === m - 1 ? null : serviceTimeToUtc(leg.date, start + it.dep, tz);
    const dwell = i === 0 || i === m - 1 ? 0 : it.dep - it.arr;
    const show = stopShow(i, m, dwell, alight);
    const shown = (show === "dep" ? depUtc : arrUtc)!;
    const listed = it.k < 0;
    // restrictions that matter: not alighting at the first stop / boarding at the last (meaningless there)
    const limit = listed ? 0 : stopLimit(p.limits, it.k) & ~(i === 0 ? StopLimit.NoAlighting : 0) & ~(i === m - 1 ? StopLimit.NoBoarding : 0);
    return {
      stop: listed ? -1 : it.k,
      station: it.station,
      ...(it.minorName !== undefined ? { minorName: it.minorName } : {}),
      city,
      tz: stz,
      arrUtc,
      depUtc,
      dwell,
      show,
      part: stopPart(i, board, alight),
      rideIn: i > board && i <= alight,
      rideOut: i >= board && i < alight,
      dayShift: dayShift(shown, stz, refDate),
      onward: !listed && i > board && city !== boardCity && canAlight(p, it.k),
      cityRep: false,
      ...(limit ? { limit } : {}),
    };
  });
  // once per run of pattern stops in one city (listed-only stops never offer connections)
  const pat = stops.flatMap((x, i) => (x.stop >= 0 ? [i] : []));
  for (const r of cityReps(pat.map((i) => stops[i]!.city), pat.indexOf(alight), (j) => ctx.stationRank[stops[pat[j]!]!.station] ?? 0)) stops[pat[r]!]!.cityRep = true;
  return {
    leg,
    pattern: pi,
    route,
    ...(number !== undefined ? { number } : {}),
    headsign: p.headsign,
    tripTz: tz,
    board,
    alight,
    stops,
    refDate,
    refTz,
    ride: p.corridors.slice(leg.board, leg.alight),
    outside: [...p.corridors.slice(0, leg.board), ...p.corridors.slice(leg.alight)],
  };
}
