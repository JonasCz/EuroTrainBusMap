/**
 * Onward connections from a city after arriving there at a given instant.
 */
import { changeOf, type ChangeBy, type CityFile, type Route } from "@etbm/shared";
import { addDays, runsOnDate } from "./calendar.ts";
import { ServiceDays, mergeRows, serviceKey } from "./merge.ts";
import { bestStop, prepare, type NetCtx } from "./context.ts";
import { routeAllowed, type Filters } from "./filters.ts";
import { localDate, serviceTimeToUtc } from "./tz.ts";
import type { TripSchedule } from "./schedule.ts";

export interface Arrival {
  city: number;
  station: number;
  utc: number;
  /** Route name + trip number of the arriving vehicle, to detect through services. */
  routeName?: string;
  number?: string;
  /** Board only at the arrival station (default: any station of the city, with the walking transfer time). */
  onlyStation?: boolean;
  /** How changes to another station are made (default "walk"; "bike": cycled where faster, see walk.ts). */
  changeBy?: ChangeBy;
}

export interface OnwardStop {
  stop: number;
  city: number;
  station: number;
  arrUtc: number;
  /** corridors from the boarding stop to this stop */
  corridors: number[];
  /** Set when the stop comes from another trip of a merged row (split train): ride that one. */
  via?: { trip: number; serviceDate: string; board: number };
}

export interface Connection {
  trip: number;
  pattern: number;
  serviceDate: string;
  board: number;
  depUtc: number;
  depStation: number;
  /** Required transfer minutes (walk or ride / min transfer); 0 for a through service. */
  transfer: number;
  /** How the change to another station is made ("bike": cycled); unset at the arrival station. */
  changeBy?: ChangeBy;
  /** Time between arrival and departure, minutes. */
  wait: number;
  /** Same vehicle continues (stay on board). */
  through: boolean;
  route: Route;
  number?: string;
  headsign: string;
  startStation: number | null;
  stops: OnwardStop[];
  note: string | null;
  tripTz: string;
}

/**
 * Stored walking minutes between two stations of the city described by `cf` (may exceed the walking cap: pairs within
 * cycling range are stored too, see walk.ts); undefined when they are too far apart.
 */
export function walkMinutesIn(cf: CityFile, from: number, to: number): number | undefined {
  let best = Infinity;
  for (const [a, b, m] of cf.transfers) {
    if ((a === from && b === to) || (a === to && b === from)) best = Math.min(best, m);
  }
  return Number.isFinite(best) ? best : undefined;
}

/** The change between two different stations of the city: minutes and how (walk / bike), undefined beyond range. */
export function changeIn(cf: CityFile, from: number, to: number, by: ChangeBy = "walk"): { min: number; by: ChangeBy } | undefined {
  const w = walkMinutesIn(cf, from, to);
  return w === undefined ? undefined : changeOf(w, by);
}

/**
 * Transfer minutes between two stations of the city described by `cf`: the same-station minimum, or the walk (or
 * bike ride) between them (at least that minimum); Infinity when they are beyond range (no transfer).
 */
export function transferMinutes(cf: CityFile, from: number, to: number, by: ChangeBy = "walk"): number {
  if (from === to) return cf.minTransfer;
  const c = changeIn(cf, from, to, by);
  return c === undefined ? Infinity : Math.max(c.min, cf.minTransfer);
}

export function connections(cf: CityFile, ctx: NetCtx, f: Filters, arrival: Arrival, windowMin = 180): Connection[] {
  const prep = prepare(cf, ctx);
  const out: Connection[] = [];
  const keys: string[] = [];
  const services = new ServiceDays();
  const limit = arrival.utc + windowMin * 60000;
  cf.patterns.forEach((p, pi) => {
    const route = cf.routes[p.route];
    if (!route || !routeAllowed(route, f)) return;
    const segs = prep.segments[pi]!;
    const tz = prep.tz[pi]!;
    const arrDate = localDate(arrival.utc, tz);
    segs.forEach((seg, si) => {
      if (seg.city !== cf.city || si === segs.length - 1) return;
      if (segs[si + 1]!.city === cf.city) return;
      // candidate boarding stops in this city segment, excluding a stop that is the trip's last
      for (const ti of prep.tripsByPattern[pi]!) {
        const [, start, cal, number] = cf.trips[ti]!;
        for (let i = seg.first; i <= seg.last; i++) {
          const off = start + p.dep[i]!;
          services.add(serviceKey(route, number, tz, [p.stations[i]!, off]), { calendar: cal, shift: Math.floor(off / 1440) });
        }
        const maxBack = Math.floor((start + p.dep[seg.last]!) / 1440) + 1;
        for (let k = -maxBack; k <= 1; k++) {
          const svc = addDays(arrDate, k);
          if (!runsOnDate(ctx.cal, cal, svc)) continue;
          let chosen: { stop: number; dep: number; transfer: number; through: boolean } | null = null;
          for (let i = seg.first; i <= seg.last; i++) {
            const dep = serviceTimeToUtc(svc, start + p.dep[i]!, tz);
            if (dep > limit) continue;
            const station = p.stations[i]!;
            if (arrival.onlyStation && station !== arrival.station) continue;
            const through =
              station === arrival.station &&
              arrival.number !== undefined &&
              arrival.number === number &&
              arrival.routeName === route.name &&
              dep >= arrival.utc &&
              dep - arrival.utc <= 120 * 60000;
            const transfer = through ? 0 : transferMinutes(cf, arrival.station, station, arrival.changeBy);
            if (dep < arrival.utc + transfer * 60000) continue;
            if (!chosen || (through && !chosen.through) || (!chosen.through && transfer < chosen.transfer) || (transfer === chosen.transfer && dep < chosen.dep)) {
              chosen = { stop: i, dep, transfer, through };
            }
          }
          if (!chosen) continue;
          const stops: OnwardStop[] = [];
          for (let sj = si + 1; sj < segs.length; sj++) {
            const s = segs[sj]!;
            if (s.city === cf.city) break;
            const i = bestStop(p, s, ctx);
            stops.push({
              stop: i,
              city: s.city,
              station: p.stations[i]!,
              arrUtc: serviceTimeToUtc(svc, start + p.arr[i]!, tz),
              corridors: p.corridors.slice(chosen.stop, i),
            });
          }
          if (!stops.length) continue;
          const first = p.stations[0]!;
          out.push({
            trip: ti,
            pattern: pi,
            serviceDate: svc,
            board: chosen.stop,
            depUtc: chosen.dep,
            depStation: p.stations[chosen.stop]!,
            transfer: chosen.transfer,
            ...(p.stations[chosen.stop] !== arrival.station && !chosen.through ? { changeBy: changeIn(cf, arrival.station, p.stations[chosen.stop]!, arrival.changeBy)?.by ?? "walk" } : {}),
            wait: Math.round((chosen.dep - arrival.utc) / 60000),
            through: chosen.through,
            route,
            ...(number !== undefined ? { number } : {}),
            headsign: p.headsign,
            startStation: ctx.stationCity[first] === cf.city ? null : first,
            stops,
            note: null, // set by mergeRows
            tripTz: tz,
          });
          keys.push(serviceKey(route, number, tz, [p.stations[chosen.stop]!, start + p.dep[chosen.stop]!]));
        }
      }
    });
  });
  // one row per service (split trips / duplicates): through services first, stops united
  const order = out.map((_, i) => i).sort((a, b) => out[a]!.depUtc - out[b]!.depUtc || Number(out[b]!.through) - Number(out[a]!.through) || a - b);
  return mergeRows(order.map((i) => out[i]!), order.map((i) => keys[i]!), ctx.cal, services, (keep, other) => {
    let added = false;
    for (const s of other.stops)
      if (!keep.stops.some((t) => t.city === s.city)) {
        keep.stops.push(s.via ? s : { ...s, via: { trip: other.trip, serviceDate: other.serviceDate, board: other.board } });
        added = true;
      }
    if (added) keep.stops.sort((a, b) => a.arrUtc - b.arrUtc);
  });
}

/**
 * The places a journey already covers, which onward connections need not offer: the origin, the cities ridden
 * through on the earlier legs (boarding to alighting) and every city of the current (last) vehicle's run – those
 * before the stop were passed, those after it are reached by staying on board.
 */
export function journeyCities(origin: number, scheds: readonly TripSchedule[]): Set<number> {
  const out = new Set<number>([origin]);
  scheds.forEach((sc, k) => {
    const last = k === scheds.length - 1;
    const from = last ? 0 : sc.board, to = last ? sc.stops.length - 1 : sc.alight;
    for (let i = from; i <= to; i++) {
      const c = sc.stops[i]!.city;
      if (c >= 0) out.add(c);
    }
  });
  return out;
}

/**
 * The onward connections that lead somewhere new: stops in `known` (see journeyCities) are left out of each row,
 * and a row with none left (another train along the same line, or back the way one came) is dropped.
 */
export function usefulConnections(conns: readonly Connection[], known: ReadonlySet<number>): Connection[] {
  const out: Connection[] = [];
  for (const c of conns) {
    const stops = c.stops.filter((s) => !known.has(s.city));
    if (stops.length === c.stops.length) out.push(c);
    else if (stops.length) out.push({ ...c, stops });
  }
  return out;
}
