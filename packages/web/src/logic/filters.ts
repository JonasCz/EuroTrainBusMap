import { Cat, Flag, type Route } from "@etbm/shared";

export interface Filters {
  /** Enabled Cat bits. */
  cats: number;
  /** Only services valid with the Deutschlandticket. */
  dticket: boolean;
}

export const ALL_CATS = Cat.LongDistance | Cat.Regional | Cat.Coach | Cat.Bus;
export const DEFAULT_FILTERS: Filters = { cats: ALL_CATS, dticket: false };

export const CAT_ORDER = [Cat.LongDistance, Cat.Regional, Cat.Coach, Cat.Bus] as const;
export const CAT_LETTER: Record<number, string> = { [Cat.LongDistance]: "l", [Cat.Regional]: "r", [Cat.Coach]: "c", [Cat.Bus]: "b" };
export const CAT_LABEL: Record<number, string> = {
  [Cat.LongDistance]: "Long-distance rail",
  [Cat.Regional]: "Regional rail",
  [Cat.Coach]: "Coach",
  [Cat.Bus]: "Regional bus",
};

export function routeAllowed(r: Route, f: Filters): boolean {
  if ((r.cat & f.cats) === 0) return false;
  if (f.dticket && (r.flags & Flag.DTicket) === 0) return false;
  return true;
}

/** Cat bits that may be shown at all under the filter (D-Ticket = regional modes only). */
export function effectiveCats(f: Filters): number {
  return f.dticket ? f.cats & (Cat.Regional | Cat.Bus) : f.cats;
}

export function encodeCats(cats: number): string {
  return CAT_ORDER.filter((c) => cats & c)
    .map((c) => CAT_LETTER[c])
    .join("");
}

export function decodeCats(s: string | null | undefined): number {
  if (s == null) return ALL_CATS;
  let m = 0;
  for (const c of CAT_ORDER) if (s.includes(CAT_LETTER[c]!)) m |= c;
  return m;
}

export function sameFilters(a: Filters, b: Filters): boolean {
  return a.cats === b.cats && a.dticket === b.dticket;
}
