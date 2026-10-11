/**
 * Display-side merging of timetable rows. Some feeds split one train into many GTFS trips
 * with disjoint calendars and slightly different stop patterns (SNCF: TGV 5440 at 08:54 is
 * ~22 trips). All trips of the same service — same route, number, and times at the board /
 * alight station — are one service: its rows on the viewed date become one row, and the day
 * note describes the union of the days of all its trips (also those not running that date).
 * Exact duplicates on the same date disappear the same way.
 */
import { daysNote, departureMask, orMask, type CalIndex, type DayMask } from "./calendar.ts";

export interface TripDays {
  /** Calendar of the trip (service days) … */
  calendar: number;
  /** … and departure day − service day (e.g. 1 for a departure at 24:30). */
  shift: number;
}

/** service key → days of every trip of that service (see serviceKey). */
export class ServiceDays {
  private m = new Map<string, Map<string, TripDays>>();
  add(key: string, d: TripDays): void {
    let s = this.m.get(key);
    if (!s) this.m.set(key, (s = new Map()));
    s.set(`${d.calendar}:${d.shift}`, d);
  }
  /** Day note of a service: union of its trips' departure days. */
  note(cal: CalIndex, key: string, cache: Map<string, DayMask>): string | null {
    const mask = new Uint8Array(Math.ceil(cal.days / 8));
    for (const [k, d] of this.m.get(key) ?? []) {
      let dm = cache.get(k);
      if (!dm) cache.set(k, (dm = departureMask(cal, d.calendar, d.shift)));
      orMask(mask, dm);
    }
    return daysNote(cal, mask);
  }
}

/** Key of a service: route, number and service-day minute offsets at the board / alight stops. */
export function serviceKey(route: { name: string; agency: string; cat: number }, number: string | undefined, tz: string, board: [number, number], alight?: [number, number]): string {
  return `${route.name}|${route.agency}|${route.cat}|${number ?? ""}|${tz}|${board[0]}@${board[1]}${alight ? `|${alight[0]}@${alight[1]}` : ""}`;
}

/**
 * Keep the first row of each key (input order) and set its note from `services`;
 * `merge` sees every dropped row with the row it merges into.
 */
export function mergeRows<T extends { note: string | null }>(rows: T[], keys: string[], cal: CalIndex, services: ServiceDays, merge?: (keep: T, other: T) => void): T[] {
  const cache = new Map<string, DayMask>();
  const kept = new Map<string, T>();
  const out: T[] = [];
  rows.forEach((row, i) => {
    const k = keys[i]!;
    const g = kept.get(k);
    if (g) {
      merge?.(g, row);
      return;
    }
    kept.set(k, row);
    row.note = services.note(cal, k, cache);
    out.push(row);
  });
  return out;
}
