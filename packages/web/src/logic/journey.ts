/** A journey = chain of legs, each a ride on one trip between two cities. */
import type { CityFile, Route } from "@etbm/shared";
import { prepare, type NetCtx } from "./context.ts";
import { serviceTimeToUtc } from "./tz.ts";

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
  corridors: number[];
}

export function resolveLeg(cf: CityFile, ctx: NetCtx, leg: Leg): LegInfo | null {
  const t = cf.trips[leg.trip];
  if (!t) return null;
  const p = cf.patterns[t[0]];
  if (!p || leg.board >= leg.alight || leg.alight >= p.stations.length) return null;
  const prep = prepare(cf, ctx);
  const tz = prep.tz[t[0]]!;
  const segs = prep.segments[t[0]]!;
  const segOf = (i: number) => segs.findIndex((s) => i >= s.first && i <= s.last);
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
    corridors: p.corridors.slice(segOf(leg.board), segOf(leg.alight)),
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
