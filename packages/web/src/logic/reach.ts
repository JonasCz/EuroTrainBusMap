/**
 * Cities reachable from a city by a direct trip (no change), any day in the
 * calendar horizon, respecting filters.
 */
import type { CityFile } from "@etbm/shared";
import { prepare, stopAt, type NetCtx } from "./context.ts";
import { routeAllowed, type Filters } from "./filters.ts";

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
}

/**
 * Direct destinations of a city, or – with `originStation` – of that one station of the city only
 * (its trips board there; the other stations of the city are not used).
 */
export function computeReach(cf: CityFile, ctx: NetCtx, f: Filters, originStation?: number): Reach {
  const prep = prepare(cf, ctx);
  const dests = new Map<number, ReachDest>();
  const corridors = new Map<number, number>();
  cf.patterns.forEach((p, pi) => {
    const route = cf.routes[p.route];
    if (!route || !routeAllowed(route, f)) return;
    const runs = prep.tripsByPattern[pi]!.some((ti) => ctx.cal.anyDay[cf.trips[ti]![2]]);
    if (!runs) return;
    const segs = prep.segments[pi]!;
    segs.forEach((sa, si) => {
      if (sa.city !== cf.city || si === segs.length - 1) return;
      // boarding stop: the station chosen, else any stop of the city's run (corridors from its first stop on; the fastest time from its last)
      let first = sa.first, last = sa.last;
      if (originStation !== undefined) {
        first = last = stopAt(p, sa, originStation);
        if (first < 0) return;
      }
      const depMin = p.dep[last]!;
      for (let sj = si + 1; sj < segs.length; sj++) {
        const sb = segs[sj]!;
        if (sb.city === cf.city) break; // pattern loops back: stop here
        const min = p.arr[sb.first]! - depMin;
        const d = dests.get(sb.city);
        if (!d) dests.set(sb.city, { city: sb.city, minutes: min, cats: route.cat });
        else {
          // a pattern with identical stop times (a feed without real times) gives 0 minutes: any real time beats it
          if (min > 0 && (d.minutes <= 0 || min < d.minutes)) d.minutes = min;
          d.cats |= route.cat;
        }
        // every hop from the boarding stop to the first stop in the destination city
        for (let k = first; k < sb.first; k++) {
          const c = p.corridors[k];
          if (c !== undefined && c >= 0) corridors.set(c, (corridors.get(c) ?? 0) | route.cat);
        }
      }
    });
  });
  return { origin: cf.city, dests, corridors };
}
