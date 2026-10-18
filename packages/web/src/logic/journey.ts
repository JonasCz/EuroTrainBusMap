/** A journey = chain of legs, each a ride on one trip between two cities. */
import type { CityFile, Route } from "@etbm/shared";
import { prepare, type NetCtx } from "./context.ts";
import { serviceTimeToUtc } from "./tz.ts";
import type { Ride } from "./transfer.ts";

export interface Leg {
  /** City whose CityFile `trip` indexes into. */
  from: number;
  trip: number;
  /** Service date of the trip. */
  date: string;
  board: number;
  alight: number;
}

export interface LegInfo {
  leg: Leg;
  to: number;
  depUtc: number;
  arrUtc: number;
  depStation: number;
  arrStation: number;
  route: Route;
  number?: string;
  headsign: string;
  /** hops ridden (board → alight) */
  corridors: number[];
  /** hops of the vehicle run before boarding and after alighting */
  outside: number[];
}

export function resolveLeg(cf: CityFile, ctx: NetCtx, leg: Leg): LegInfo | null {
  const t = cf.trips[leg.trip];
  if (!t) return null;
  const p = cf.patterns[t[0]];
  if (!p || leg.board >= leg.alight || leg.alight >= p.stations.length) return null;
  const prep = prepare(cf, ctx);
  const tz = prep.tz[t[0]]!;
  const from = ctx.stationCity[p.stations[leg.board]!]!;
  if (from !== leg.from) return null;
  const route = cf.routes[p.route]!;
  return {
    leg,
    to: ctx.stationCity[p.stations[leg.alight]!]!,
    depUtc: serviceTimeToUtc(leg.date, t[1] + p.dep[leg.board]!, tz),
    arrUtc: serviceTimeToUtc(leg.date, t[1] + p.arr[leg.alight]!, tz),
    depStation: p.stations[leg.board]!,
    arrStation: p.stations[leg.alight]!,
    route,
    ...(t[3] !== undefined ? { number: t[3] } : {}),
    headsign: p.headsign,
    corridors: p.corridors.slice(leg.board, leg.alight),
    outside: [...p.corridors.slice(0, leg.board), ...p.corridors.slice(leg.alight)],
  };
}

export function encodeLegs(legs: Leg[]): string {
  return legs.map((l) => `${l.trip}.${l.date.replaceAll("-", "")}.${l.board}.${l.alight}`).join(",");
}

/** Decodes legs; `from` of the first leg is `origin`, later ones are filled in by the caller. */
export function decodeLegs(s: string | null | undefined, origin: number): Leg[] {
  if (!s) return [];
  const out: Leg[] = [];
  for (const part of s.split(",")) {
    const m = /^(\d+)\.(\d{4})(\d{2})(\d{2})\.(\d+)\.(\d+)$/.exec(part);
    if (!m) break;
    out.push({ from: out.length ? -1 : origin, trip: +m[1]!, date: `${m[2]}-${m[3]}-${m[4]}`, board: +m[5]!, alight: +m[6]! });
  }
  return out;
}

/**
 * The trip of `leg` as the search identifies it (Ride: pattern, start, calendar, service date and the alighting stop),
 * when it runs on beyond the alighting stop: continuing the journey, staying on board is an option.
 */
export function rideOf(cf: CityFile, leg: Leg): Ride | null {
  const t = cf.trips[leg.trip];
  const p = t ? cf.patterns[t[0]] : undefined;
  if (!t || !p || leg.alight >= p.stations.length - 1) return null;
  return { stations: p.stations, arr: p.arr, dep: p.dep, start: t[1], cal: t[2], date: leg.date, stop: leg.alight };
}

/**
 * The legs of a journey continued by `route` whose first leg stays on board the vehicle of the last leg (Journey.stay):
 * that leg rides on to where the first one of `route` alights (the same pattern, so the same stop index) – one leg,
 * no change – and the rest of `route` follows.
 */
export function joinStay(legs: Leg[], route: Leg[]): Leg[] {
  const last = legs[legs.length - 1], first = route[0];
  if (!last || !first || first.alight <= last.alight) return [...legs, ...route];
  return [...legs.slice(0, -1), { ...last, alight: first.alight }, ...route.slice(1)];
}

/**
 * The trip of `leg` (indexed in `src`, the CityFile of `leg.from`) in another city's CityFile `dst`: the same pattern
 * (stations, times, restrictions) and the same start and calendar, so stop indices carry over. −1 when `dst` lacks it.
 */
export function tripIn(src: CityFile, leg: Leg, dst: CityFile): number {
  const t = src.trips[leg.trip];
  const p = t ? src.patterns[t[0]] : undefined;
  if (!t || !p) return -1;
  const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const cat = src.routes[p.route]?.cat;
  const pats = new Set<number>();
  dst.patterns.forEach((q, i) => {
    if (same(q.stations, p.stations) && same(q.arr, p.arr) && same(q.dep, p.dep) && same(q.limits ?? [], p.limits ?? []) && dst.routes[q.route]?.cat === cat) pats.add(i);
  });
  return pats.size ? dst.trips.findIndex((x) => pats.has(x[0]) && x[1] === t[1] && x[2] === t[2]) : -1;
}
