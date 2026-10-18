/**
 * Departures per station of a city, by mode: which stations of a city can be chosen as the origin
 * under the current mode filter (the panel's station list greys out the others).
 */
import { canBoard, type CityFile } from "@etbm/shared";
import { serviceDayCount } from "./calendar.ts";
import { prepare, type NetCtx } from "./context.ts";
import { CAT_ORDER, type Filters } from "./filters.ts";

/** Cat bit → departures per day (average over the calendar horizon) from one station. */
export type StationDeps = Partial<Record<number, number>>;

const cache = new WeakMap<CityFile, Map<number, StationDeps>>();

/**
 * station id → Cat bit → departures/day of trips boarding there towards another city (the same trips
 * the reach view uses: a stop of the city's run of a pattern that continues to another city, boarding allowed).
 * Unfiltered, so the caller can tell which modes serve a station; cached per city file.
 */
export function stationDepartures(cf: CityFile, ctx: NetCtx): Map<number, StationDeps> {
  const hit = cache.get(cf);
  if (hit) return hit;
  const prep = prepare(cf, ctx);
  const out = new Map<number, StationDeps>();
  const days = Math.max(1, ctx.cal.days);
  cf.patterns.forEach((p, pi) => {
    const route = cf.routes[p.route];
    if (!route) return;
    let tpd = 0;
    for (const ti of prep.tripsByPattern[pi]!) tpd += serviceDayCount(ctx.cal, cf.trips[ti]![2]) / days;
    if (tpd <= 0) return;
    const segs = prep.segments[pi]!;
    const seen = new Set<number>(); // a pattern calling twice at a station counts once
    segs.forEach((sa, si) => {
      if (sa.city !== cf.city || si === segs.length - 1) return;
      for (let i = sa.first; i <= sa.last; i++) {
        const st = p.stations[i]!;
        if (seen.has(st) || !canBoard(p, i)) continue;
        seen.add(st);
        const r = out.get(st) ?? {};
        r[route.cat] = (r[route.cat] ?? 0) + tpd;
        out.set(st, r);
      }
    });
  });
  cache.set(cf, out);
  return out;
}

/** Departures/day of the modes enabled in `f`. */
export function depsWith(d: StationDeps | undefined, f: Filters): number {
  let n = 0;
  if (d) for (const [k, v] of Object.entries(d)) if (+k & f.cats) n += v ?? 0;
  return n;
}

/** Cat bits with departures at a station (any mode), in display order. */
export function depCats(d: StationDeps | undefined): number[] {
  return d ? CAT_ORDER.filter((c) => (d[c] ?? 0) > 0) : [];
}
