/**
 * Hoverable tracks: which of the items a view shows (route options of a journey search, the services from a
 * city, the legs of a journey) ride a segment drawn on the map. Items list the corridors they ride in travel
 * order; a corridor is drawn as segments, and one segment can carry many corridors (a trunk line).
 */
import type { Route } from "@etbm/shared";
import { addTraffic, type CorridorTraffic } from "./context.ts";

export interface TrackItem {
  /** corridors ridden, in travel order (−1: none) */
  corridors: readonly number[];
}

export interface TrackIndex {
  /** segment → corridors (of the items) drawn on it */
  segCorridors: Map<number, number[]>;
  /** corridor → item index → first position of the corridor in the item's list */
  corridorItems: Map<number, Map<number, number>>;
}

/** Index the items' corridors and the segments they are drawn on (`segsOf`: a corridor's segment ids). */
export function buildTrackIndex(items: readonly TrackItem[], segsOf: (corridor: number) => Iterable<number> | undefined): TrackIndex {
  const corridorItems = new Map<number, Map<number, number>>();
  items.forEach((it, i) => {
    it.corridors.forEach((c, pos) => {
      if (c < 0) return;
      let m = corridorItems.get(c);
      if (!m) corridorItems.set(c, (m = new Map()));
      if (!m.has(i)) m.set(i, pos);
    });
  });
  const segCorridors = new Map<number, number[]>();
  for (const c of corridorItems.keys()) {
    for (const s of new Set(segsOf(c) ?? [])) {
      const l = segCorridors.get(s);
      if (l) l.push(c);
      else segCorridors.set(s, [c]);
    }
  }
  return { segCorridors, corridorItems };
}

/**
 * The items riding any of `segs`: item index → the first position (in its corridor list) of a corridor drawn
 * on one of them; sorted by item index.
 */
export function itemsAt(index: TrackIndex, segs: Iterable<number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of segs) {
    for (const c of index.segCorridors.get(s) ?? []) {
      for (const [i, pos] of index.corridorItems.get(c) ?? []) {
        const o = out.get(i);
        if (o === undefined || pos < o) out.set(i, pos);
      }
    }
  }
  return new Map([...out].sort((a, b) => a[0] - b[0]));
}

/** A service pattern from the selected city: its route, trips/day, the corridors ridden and the places it serves. */
export interface TrackRun extends TrackItem {
  route: Route;
  tpd: number;
  /** destination cities, each with the number of corridors ridden to get there (in travel order) */
  dests: { city: number; hops: number }[];
}

export interface RunsSummary {
  /** brands (or route names) with their trips/day, the busiest first */
  brands: { name: string; tpd: number }[];
  /** trips/day over the track (all runs) */
  tpd: number;
  /** places served via the track, the most important first */
  dests: number[];
  /** the place most trips reach first after the track (where a click goes) */
  next: number | undefined;
  /** the runs' corridors from the origin to their last place beyond the track, with their trips/day */
  traffic: CorridorTraffic;
}

/**
 * What the runs riding a track (`hits`: run index → position of the track's corridor, see itemsAt) have in
 * common: brands, trips/day, the places beyond the track and their corridors.
 */
export function summarizeRuns(runs: readonly TrackRun[], hits: Map<number, number>, brandOf: (r: Route) => string, importance: (city: number) => number): RunsSummary {
  const brands = new Map<string, number>();
  const dests = new Set<number>();
  const nextTpd = new Map<number, number>();
  const traffic: CorridorTraffic = new Map();
  let tpd = 0;
  for (const [i, pos] of hits) {
    const r = runs[i];
    if (!r) continue;
    const beyond = r.dests.filter((d) => d.hops > pos);
    if (!beyond.length) continue;
    tpd += r.tpd;
    const b = brandOf(r.route);
    brands.set(b, (brands.get(b) ?? 0) + r.tpd);
    for (const d of beyond) dests.add(d.city);
    const first = beyond.reduce((a, d) => (d.hops < a.hops ? d : a));
    nextTpd.set(first.city, (nextTpd.get(first.city) ?? 0) + r.tpd);
    const last = Math.max(...beyond.map((d) => d.hops));
    addTraffic(traffic, r.corridors.slice(0, last), r.route.cat, r.tpd);
  }
  let next: number | undefined;
  for (const [c, t] of nextTpd) if (next === undefined || t > nextTpd.get(next)! || (t === nextTpd.get(next)! && importance(c) > importance(next))) next = c;
  return {
    brands: [...brands].map(([name, t]) => ({ name, tpd: t })).sort((a, b) => b.tpd - a.tpd || (a.name < b.name ? -1 : 1)),
    tpd,
    dests: [...dests].sort((a, b) => importance(b) - importance(a) || a - b),
    next,
    traffic,
  };
}

/** "about 23 trips a day" style count (trips/day averaged over the timetable period). */
export function fmtTpd(tpd: number): string {
  if (tpd >= 1.5) return `${Math.round(tpd)} trips a day`;
  if (tpd >= 0.75) return "1 trip a day";
  const week = Math.round(tpd * 7);
  return week >= 1 ? `${week} trip${week === 1 ? "" : "s"} a week` : "occasional trips";
}

/** A short list of names: "Lyon, Marseille, Avignon +12". */
export function nameList(names: string[], max = 3): string {
  return names.length > max ? `${names.slice(0, max).join(", ")} +${names.length - max}` : names.join(", ");
}
