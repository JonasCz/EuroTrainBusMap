/**
 * Onward connections from a city after arriving there at a given instant.
 */
import type { CityFile, Route } from "@etbm/shared";
import { addDays, runsOnDate } from "./calendar.ts";
import { ServiceDays, mergeRows, serviceKey } from "./merge.ts";
import { bestStop, prepare, type NetCtx } from "./context.ts";
import { routeAllowed, type Filters } from "./filters.ts";
import { localDate, serviceTimeToUtc } from "./tz.ts";

export interface Arrival {
  city: number;
  station: number;
  utc: number;
  /** Route name + trip number of the arriving vehicle, to detect through services. */
  routeName?: string;
  number?: string;
}

export interface OnwardStop {
  stop: number;
  city: number;
  station: number;
  arrUtc: number;
  /** corridors from the boarding city to this stop */
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
  /** Required transfer minutes (walk / min transfer); 0 for a through service. */
  transfer: number;
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

/** Transfer minutes between two stations of the city described by `cf`. */
export function transferMinutes(cf: CityFile, from: number, to: number): number {
  if (from === to) return cf.minTransfer;
  let best = Infinity;
  for (const [a, b, m] of cf.transfers) {
    if ((a === from && b === to) || (a === to && b === from)) best = Math.min(best, m);
  }
  return Number.isFinite(best) ? Math.max(best, cf.minTransfer) : Math.max(cf.minTransfer, 30);
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
            const through =
              station === arrival.station &&
              arrival.number !== undefined &&
              arrival.number === number &&
              arrival.routeName === route.name &&
              dep >= arrival.utc &&
              dep - arrival.utc <= 120 * 60000;
            const transfer = through ? 0 : transferMinutes(cf, arrival.station, station);
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
              corridors: p.corridors.slice(si, sj),
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
