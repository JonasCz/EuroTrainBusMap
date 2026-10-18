/**
 * Cities reachable from a city by a direct trip (no change), any day in the
 * calendar horizon, respecting filters.
 */
import type { CityFile } from "@etbm/shared";
import { canBoard } from "@etbm/shared";
import { addTraffic, boardSpan, firstAlight, patternTpd, prepare, stopAt, trafficCats, type CorridorTraffic, type NetCtx } from "./context.ts";
import { routeAllowed, type Filters } from "./filters.ts";
import type { TrackRun } from "./tracks.ts";

export interface ReachDest {
  city: number;
  /** Fastest scheduled in-vehicle time in minutes. */
  minutes: number;
  /** Union of Cat bits of the services going there. */
  cats: number;
}

export interface Reach {
  origin: number;
  dests: Map<number, ReachDest>;
  /** corridor id → Cat bits used on it */
  corridors: Map<number, number>;
  /** corridor id → Cat bit → trips/day of the reach's own services on it (selection line widths) */
  traffic: CorridorTraffic;
}

/**
 * Direct destinations of a city, or – with `originStation` – of that one station of the city only
 * (its trips board there; the other stations of the city are not used).
 */
export function computeReach(cf: CityFile, ctx: NetCtx, f: Filters, originStation?: number): Reach {
  const prep = prepare(cf, ctx);
  const dests = new Map<number, ReachDest>();
  const traffic: CorridorTraffic = new Map();
  cf.patterns.forEach((p, pi) => {
    const route = cf.routes[p.route];
    if (!route || !routeAllowed(route, f)) return;
    const runs = prep.tripsByPattern[pi]!.some((ti) => ctx.cal.anyDay[cf.trips[ti]![2]]);
    if (!runs) return;
    const segs = prep.segments[pi]!;
    const used = new Set<number>(); // corridors of this pattern used by its trips from the city (counted once)
    segs.forEach((sa, si) => {
      if (sa.city !== cf.city || si === segs.length - 1) return;
      // boarding stop: the station chosen, else any stop of the city's run where boarding is allowed (corridors from
      // its first one on; the fastest time from its last)
      let first: number, last: number;
      if (originStation !== undefined) {
        first = last = stopAt(p, sa, originStation);
        if (first < 0 || !canBoard(p, first)) return;
      } else {
        const span = boardSpan(p, sa);
        if (!span) return;
        [first, last] = span;
      }
      const depMin = p.dep[last]!;
      for (let sj = si + 1; sj < segs.length; sj++) {
        const sb = segs[sj]!;
        if (sb.city === cf.city) break; // pattern loops back: stop here
        // the first stop of the destination's run where passengers may get off (none: the vehicle only passes)
        const ai = firstAlight(p, sb);
        if (ai < 0) continue;
        const min = p.arr[ai]! - depMin;
        const d = dests.get(sb.city);
        if (!d) dests.set(sb.city, { city: sb.city, minutes: min, cats: route.cat });
        else {
          // a pattern with identical stop times (a feed without real times) gives 0 minutes: any real time beats it
          if (min > 0 && (d.minutes <= 0 || min < d.minutes)) d.minutes = min;
          d.cats |= route.cat;
        }
        // every hop from the boarding stop to the alighting stop in the destination city
        for (let k = first; k < ai; k++) {
          const c = p.corridors[k];
          if (c !== undefined && c >= 0) used.add(c);
        }
      }
    });
    if (used.size) addTraffic(traffic, used, route.cat, patternTpd(cf, ctx, pi));
  });
  return { origin: cf.city, dests, corridors: trafficCats(traffic), traffic };
}

/**
 * The services behind a reach, one run per pattern and boarding stop: the corridors ridden from the origin and
 * the places served (hoverable tracks, see tracks.ts). Same rules as computeReach.
 */
export function reachRuns(cf: CityFile, ctx: NetCtx, f: Filters, originStation?: number): TrackRun[] {
  const prep = prepare(cf, ctx);
  const runs: TrackRun[] = [];
  cf.patterns.forEach((p, pi) => {
    const route = cf.routes[p.route];
    if (!route || !routeAllowed(route, f)) return;
    if (!prep.tripsByPattern[pi]!.some((ti) => ctx.cal.anyDay[cf.trips[ti]![2]])) return;
    const segs = prep.segments[pi]!;
    let tpd = -1;
    segs.forEach((sa, si) => {
      if (sa.city !== cf.city || si === segs.length - 1) return;
      let first: number;
      if (originStation !== undefined) {
        first = stopAt(p, sa, originStation);
        if (first < 0 || !canBoard(p, first)) return;
      } else {
        const span = boardSpan(p, sa);
        if (!span) return;
        first = span[0];
      }
      const dests: TrackRun["dests"] = [];
      for (let sj = si + 1; sj < segs.length; sj++) {
        const sb = segs[sj]!;
        if (sb.city === cf.city) break;
        const ai = firstAlight(p, sb);
        if (ai >= 0) dests.push({ city: sb.city, hops: ai - first });
      }
      if (!dests.length) return;
      if (tpd < 0) tpd = patternTpd(cf, ctx, pi);
      const corridors: number[] = [];
      for (let k = first; k < first + dests[dests.length - 1]!.hops; k++) corridors.push(p.corridors[k] ?? -1);
      runs.push({ route, tpd, corridors, dests });
    });
  });
  return runs;
}
