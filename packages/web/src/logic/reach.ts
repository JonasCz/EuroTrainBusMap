/**
 * Cities reachable from a city by a direct trip (no change), any day in the
 * calendar horizon, respecting filters.
 */
import type { CityFile } from "@etbm/shared";
import { prepare, type NetCtx } from "./context.ts";
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

export function computeReach(cf: CityFile, ctx: NetCtx, f: Filters): Reach {
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
      const depMin = p.dep[sa.last]!;
      for (let sj = si + 1; sj < segs.length; sj++) {
        const sb = segs[sj]!;
        if (sb.city === cf.city) break; // pattern loops back: stop here
        const min = p.arr[sb.first]! - depMin;
        const d = dests.get(sb.city);
        if (!d) dests.set(sb.city, { city: sb.city, minutes: min, cats: route.cat });
        else {
          d.minutes = Math.min(d.minutes, min);
          d.cats |= route.cat;
        }
        const c = p.corridors[sj - 1];
        if (c !== undefined) corridors.set(c, (corridors.get(c) ?? 0) | route.cat);
      }
    });
  });
  return { origin: cf.city, dests, corridors };
}
