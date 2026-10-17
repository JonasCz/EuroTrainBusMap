/**
 * Direct departures between two cities on a given (origin-local) date.
 */
import type { CityFile, Route } from "@etbm/shared";
import { addDays, dayNumber, inHorizon, lastDate, runsOnDate } from "./calendar.ts";
import { ServiceDays, mergeRows, serviceKey } from "./merge.ts";
import { addTraffic, bestStop, patternTpd, prepare, stopAt, trafficCats, type CorridorTraffic, type NetCtx } from "./context.ts";
import { routeAllowed, type Filters } from "./filters.ts";
import { localDate, serviceTimeToUtc } from "./tz.ts";

export interface StopTime {
  stop: number;
  station: number;
  utc: number;
}

export interface Departure {
  trip: number;
  pattern: number;
  /** Service date of the trip (YYYY-MM-DD, in trip tz). */
  serviceDate: string;
  board: number;
  alight: number;
  depUtc: number;
  arrUtc: number;
  depStation: number;
  arrStation: number;
  route: Route;
  number?: string;
  headsign: string;
  /** First station of the trip if it started outside the origin city. */
  startStation: number | null;
  /** Last station of the trip. */
  endStation: number;
  minutes: number;
  /** Days this service runs, e.g. "Mon–Fri", "Sun only" (null = daily); see daysNote. */
  note: string | null;
  corridors: number[];
  /** Other stops of the same trip in origin / destination city. */
  altBoard: StopTime[];
  altAlight: StopTime[];
  tripTz: string;
}

interface Candidate {
  pattern: number;
  board: number;
  alight: number;
  boardSeg: [number, number];
  alightSeg: [number, number];
  corridors: number[];
}

/** Pattern/stop combinations that go from cf.city (or only from `originStation` of it) directly to `dest`. */
export function pairCandidates(cf: CityFile, ctx: NetCtx, f: Filters, dest: number, originStation?: number): Candidate[] {
  const prep = prepare(cf, ctx);
  const out: Candidate[] = [];
  cf.patterns.forEach((p, pi) => {
    const route = cf.routes[p.route];
    if (!route || !routeAllowed(route, f)) return;
    const segs = prep.segments[pi]!;
    const ia = segs.findIndex((s) => s.city === cf.city);
    if (ia < 0) return;
    let ib = -1;
    for (let j = ia + 1; j < segs.length; j++) {
      if (segs[j]!.city === cf.city) break;
      if (segs[j]!.city === dest) {
        ib = j;
        break;
      }
    }
    if (ib < 0) return;
    const sa = segs[ia]!;
    const sb = segs[ib]!;
    const board = originStation !== undefined ? stopAt(p, sa, originStation) : bestStop(p, sa, ctx);
    if (board < 0) return;
    const alight = bestStop(p, sb, ctx);
    out.push({
      pattern: pi,
      board,
      alight,
      // with a chosen station there are no "also from …" alternatives
      boardSeg: originStation !== undefined ? [board, board] : [sa.first, sa.last],
      alightSeg: [sb.first, sb.last],
      corridors: p.corridors.slice(board, alight),
    });
  });
  return out;
}

/** corridor id → Cat bit → trips/day of the services running between the pair (any day in the horizon). */
export function pairTraffic(cf: CityFile, ctx: NetCtx, f: Filters, dest: number, originStation?: number): CorridorTraffic {
  const t: CorridorTraffic = new Map();
  const prep = prepare(cf, ctx);
  for (const c of pairCandidates(cf, ctx, f, dest, originStation)) {
    if (!prep.tripsByPattern[c.pattern]!.some((ti) => ctx.cal.anyDay[cf.trips[ti]![2]])) continue;
    addTraffic(t, c.corridors, cf.routes[cf.patterns[c.pattern]!.route]!.cat, patternTpd(cf, ctx, c.pattern));
  }
  return t;
}

/** corridor id → Cat bits of services running between the pair (any day). */
export function pairCorridors(cf: CityFile, ctx: NetCtx, f: Filters, dest: number, originStation?: number): Map<number, number> {
  return trafficCats(pairTraffic(cf, ctx, f, dest, originStation));
}

/** Departures from cf.city to dest whose departure falls on `date` (origin-local). */
export function timetable(cf: CityFile, ctx: NetCtx, f: Filters, dest: number, date: string, cands = pairCandidates(cf, ctx, f, dest, undefined)): Departure[] {
  const prep = prepare(cf, ctx);
  const originTz = ctx.cityTz[cf.city]!;
  const out: Departure[] = [];
  const keys: string[] = [];
  const services = new ServiceDays();
  for (const c of cands) {
    const p = cf.patterns[c.pattern]!;
    const tz = prep.tz[c.pattern]!;
    const route = cf.routes[p.route]!;
    for (const ti of prep.tripsByPattern[c.pattern]!) {
      const [, start, cal, number] = cf.trips[ti]!;
      // a trip on service day S departs at start+dep minutes, possibly > 24 h
      const depOff = start + p.dep[c.board]!;
      const key = serviceKey(route, number, tz, [p.stations[c.board]!, depOff], [p.stations[c.alight]!, start + p.arr[c.alight]!]);
      services.add(key, { calendar: cal, shift: Math.floor(depOff / 1440) });
      const back = Math.floor(depOff / 1440) + 1;
      for (let k = -back; k <= 1; k++) {
        const svc = addDays(date, k);
        if (!runsOnDate(ctx.cal, cal, svc)) continue;
        const depUtc = serviceTimeToUtc(svc, depOff, tz);
        if (localDate(depUtc, originTz) !== date) continue;
        const arrUtc = serviceTimeToUtc(svc, start + p.arr[c.alight]!, tz);
        const st = (i: number): StopTime => ({ stop: i, station: p.stations[i]!, utc: serviceTimeToUtc(svc, start + (i === c.board || i < c.alightSeg[0] ? p.dep[i]! : p.arr[i]!), tz) });
        const altBoard: StopTime[] = [];
        for (let i = c.boardSeg[0]; i <= c.boardSeg[1]; i++) if (i !== c.board && i < p.stations.length - 1) altBoard.push(st(i));
        const altAlight: StopTime[] = [];
        for (let i = c.alightSeg[0]; i <= c.alightSeg[1]; i++) if (i !== c.alight) altAlight.push(st(i));
        const first = p.stations[0]!;
        out.push({
          trip: ti,
          pattern: c.pattern,
          serviceDate: svc,
          board: c.board,
          alight: c.alight,
          depUtc,
          arrUtc,
          depStation: p.stations[c.board]!,
          arrStation: p.stations[c.alight]!,
          route: cf.routes[p.route]!,
          ...(number !== undefined ? { number } : {}),
          headsign: p.headsign,
          startStation: ctx.stationCity[first] === cf.city ? null : first,
          endStation: p.stations[p.stations.length - 1]!,
          minutes: Math.round((arrUtc - depUtc) / 60000),
          note: null, // set by mergeRows
          corridors: c.corridors,
          altBoard,
          altAlight,
          tripTz: tz,
        });
        keys.push(key);
      }
    }
  }
  // one row per service: split trips (disjoint calendars) and duplicates on this date merge
  const order = out.map((_, i) => i).sort((a, b) => out[a]!.depUtc - out[b]!.depUtc || out[a]!.arrUtc - out[b]!.arrUtc || a - b);
  return mergeRows(order.map((i) => out[i]!), order.map((i) => keys[i]!), ctx.cal, services);
}

/** Next dates (after `date`) with at least one departure, up to `limit`. */
export function nextServiceDates(cf: CityFile, ctx: NetCtx, f: Filters, dest: number, date: string, limit = 5, originStation?: number): string[] {
  const cands = pairCandidates(cf, ctx, f, dest, originStation);
  if (!cands.length) return [];
  const out: string[] = [];
  const end = dayNumber(lastDate(ctx.cal)) + 1;
  let d = dayNumber(date) < ctx.cal.start ? addDays(ctx.cal.startDate, -1) : date;
  while (out.length < limit) {
    d = addDays(d, 1);
    if (dayNumber(d) > end) break;
    if (timetable(cf, ctx, f, dest, d, cands).length) out.push(d);
  }
  return out;
}

export { inHorizon };
