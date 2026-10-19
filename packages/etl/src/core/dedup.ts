import { overlaps } from "./calendar.ts";

export interface DupTrip {
  key: number;
  /** Number of distinct cities served. */
  cities: number;
  /** Duration in minutes (first dep → last arr). */
  duration: number;
  priority: number;
  /** From a stale feed (its last pattern projected onto the build window, gtfs/validity.ts): loses to any current copy. */
  stale?: boolean;
  mask: Uint8Array;
  number?: string | null;
}

export interface DupPair {
  a: number;
  b: number;
  /** Number of shared (city, time) matches. */
  shared: number;
}

/** Whether trip x is a better representative than y. */
export function better(x: DupTrip, y: DupTrip): boolean {
  if (!!x.stale !== !!y.stale) return !x.stale;
  if (x.cities !== y.cities) return x.cities > y.cities;
  if (x.duration !== y.duration) return x.duration > y.duration;
  if (x.priority !== y.priority) return x.priority > y.priority;
  return x.key < y.key;
}

function digits(s: string | null | undefined): string | null {
  const m = s ? /(\d{2,6})/.exec(s) : null;
  return m ? m[1]! : null;
}

/**
 * Decide which trips to drop. Pairs must share ≥ 2 cities at matching times,
 * overlap in service days and (when both carry one) have the same train number.
 * The kept trip absorbs the dropped trip's service days – except a current trip, which keeps its own calendar when
 * the dropped copy comes from a stale feed (a projected calendar adds no real days). `keptFor` maps every dropped trip to the
 * trip that represents it.
 */
export function resolveDuplicates(
  pairs: DupPair[],
  trips: Map<number, DupTrip>,
): { dropped: Set<number>; extraMask: Map<number, Uint8Array>; keptFor: Map<number, number> } {
  const dropped = new Set<number>();
  const redirect = new Map<number, number>();
  const extraMask = new Map<number, Uint8Array>();
  const root = (k: number) => {
    while (redirect.has(k)) k = redirect.get(k)!;
    return k;
  };
  const sorted = [...pairs].sort((p, q) => q.shared - p.shared || p.a - q.a || p.b - q.b);
  for (const p of sorted) {
    if (p.shared < 2) continue;
    const ka = root(p.a), kb = root(p.b);
    if (ka === kb) continue;
    const a = trips.get(ka), b = trips.get(kb);
    if (!a || !b) continue;
    const na = digits(a.number), nb = digits(b.number);
    if (na && nb && na !== nb) continue;
    if (!overlaps(a.mask, b.mask)) continue;
    const [keep, drop] = better(a, b) ? [a, b] : [b, a];
    dropped.add(drop.key);
    redirect.set(drop.key, keep.key);
    if (drop.stale && !keep.stale) continue;
    const m = extraMask.get(keep.key) ?? Uint8Array.from(keep.mask);
    const dm = extraMask.get(drop.key) ?? drop.mask;
    for (let i = 0; i < m.length; i++) m[i]! |= dm[i]!;
    extraMask.set(keep.key, m);
    keep.mask = m;
  }
  for (const k of dropped) extraMask.delete(k);
  const keptFor = new Map<number, number>();
  for (const k of dropped) keptFor.set(k, root(k));
  return { dropped, extraMask, keptFor };
}
