import { Cat, type Route } from "@etbm/shared";

export interface Filters {
  /** Enabled Cat bits. */
  cats: number;
  /** Local transport layer (metro / tram / local bus) shown; undefined = on. */
  local?: boolean;
}

export const localOn = (f: Filters): boolean => f.local !== false;

/** Letter in the URL `modes` parameter for local transport (metro / tram / local bus). */
export const LOCAL_LETTER = "t";

export const ALL_CATS = Cat.LongDistance | Cat.Regional | Cat.Coach | Cat.Bus;
export const DEFAULT_FILTERS: Filters = { cats: ALL_CATS };

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
  return true;
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
  return a.cats === b.cats && localOn(a) === localOn(b);
}
