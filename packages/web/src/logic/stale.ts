/**
 * Out-of-date timetables (Route.expired, attribution `expired`, local line tile property `e`): a feed whose service
 * ran out – or a generated feed whose source page is stale – is kept by the ETL with its last weekly pattern repeated
 * over the build window (packages/etl/src/gtfs/validity.ts). The texts of the warning shown wherever such data appears:
 * "Timetables out of date — expired 15 Jul 2025". Pure functions (no DOM), so they can be tested.
 */
import type { Route } from "@etbm/shared";

/** "2025-07-15" → "15 Jul 2025"; null for anything else. */
export function expiredDate(ymd: string | undefined): string | null {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const d = new Date(ymd + "T00:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== ymd) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export interface StaleWarning {
  /** Short label for badges ("Out of date"). */
  label: string;
  /** The warning line: "Timetables out of date — expired 15 Jul 2025". */
  text: string;
  /** Longer explanation for tooltips. */
  title: string;
}

/** The warning for a route from an out-of-date feed, or null for current data. */
export function staleWarning(r: Pick<Route, "expired">): StaleWarning | null {
  const day = expiredDate(r.expired);
  if (!day) return null;
  return {
    label: "Out of date",
    text: `Timetables out of date — expired ${day}`,
    title: `The operator's timetable data ran out on ${day} and has not been renewed. The times shown repeat its last weekly pattern and may no longer be right: check with the operator before travelling.`,
  };
}

/**
 * The expiry date shown for a group of routes (a journey group whose rows ride different services on one leg): the
 * earliest one, or undefined when all are current.
 */
export function earliestExpired(routes: readonly (Pick<Route, "expired"> | undefined)[]): string | undefined {
  let out: string | undefined;
  for (const r of routes) if (r?.expired && expiredDate(r.expired) && (!out || r.expired < out)) out = r.expired;
  return out;
}

/** The data sources dialog's warning after a source: "Timetables out of date — expired 31 Dec 2025 (Autobús-interurbano-de-Navarra)". */
export function staleSourceText(s: { expired?: string; expiredParts?: string[] }): string | null {
  const day = expiredDate(s.expired);
  if (!day) return null;
  return `Timetables out of date — expired ${day}${s.expiredParts?.length ? ` (${s.expiredParts.join(", ")})` : ""}`;
}
