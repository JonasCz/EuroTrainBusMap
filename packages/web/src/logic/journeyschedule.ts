/**
 * The schedule of a whole journey with changes: the trip schedules of its legs in one list. The very first leg
 * shows its stops before boarding and the last leg those after alighting (greyed, as a single trip's schedule);
 * at the changes in between, the stops a vehicle makes before boarding / after alighting are folded away
 * ("show previous / next stops"), and the change itself (same station, walk between stations or staying on
 * board) sits between the legs with the other departures one could change to.
 */
import type { ChangeBy } from "@etbm/shared";
import type { Departure } from "./timetable.ts";
import type { TripSchedule } from "./schedule.ts";

export interface JourneyLegPart {
  sched: TripSchedule;
  /** Range of `sched.stops` listed (inclusive). */
  from: number;
  to: number;
  /** Stops before `from` / after `to`, folded behind a toggle (0: none, the stop is the run's first / last, or shown). */
  foldBefore: number;
  foldAfter: number;
}

export interface JourneyChange {
  /** Where the previous leg ends and the next one starts (the same station unless walking). */
  arrStation: number;
  depStation: number;
  arrUtc: number;
  depUtc: number;
  /** Minutes between the arrival and the departure. */
  wait: number;
  /** Minutes of the walk (or bike ride, `by`) between the two stations (when they differ and it is known). */
  walk?: number;
  /** How the change between the two stations is made; set with `walk` ("walk", "bike" or "transit"). */
  by?: ChangeBy;
  /** TransitMode bits of a change by transit */
  modes?: number;
  /** Same vehicle continues (same station, route and number): stay on board. */
  through: boolean;
}

export interface JourneySchedule {
  legs: JourneyLegPart[];
  /** changes[i] lies between legs[i] and legs[i + 1] */
  changes: JourneyChange[];
  depUtc: number;
  arrUtc: number;
  minutes: number;
  /** Changes (staying on board does not count). */
  changeCount: number;
}

/**
 * One schedule per leg (in order); `walk(i, arrUtc)` gives the change between stations before leg i (i ≥ 1), the
 * previous leg arriving at `arrUtc`: its minutes and how it is made, or just walking minutes.
 */
export function journeySchedule(
  scheds: TripSchedule[],
  walk: (i: number, arrUtc: number) => { min: number; by: ChangeBy; modes?: number } | number | undefined = () => undefined,
): JourneySchedule | null {
  if (!scheds.length) return null;
  const k = scheds.length;
  const legs: JourneyLegPart[] = scheds.map((s, i) => {
    const n = s.stops.length;
    const first = i === 0, last = i === k - 1;
    return { sched: s, from: first ? 0 : s.board, to: last ? n - 1 : s.alight, foldBefore: first ? 0 : s.board, foldAfter: last ? 0 : n - 1 - s.alight };
  });
  const changes: JourneyChange[] = [];
  for (let i = 1; i < k; i++) {
    const p = scheds[i - 1]!, l = scheds[i]!;
    const a = p.stops[p.alight]!, b = l.stops[l.board]!;
    const arrUtc = a.arrUtc!, depUtc = b.depUtc!;
    const through = a.station === b.station && p.route.name === l.route.name && p.number !== undefined && p.number === l.number;
    const x = a.station !== b.station ? walk(i, arrUtc) : undefined;
    const w: { min: number; by: ChangeBy; modes?: number } | undefined = typeof x === "number" ? { min: x, by: "walk" } : x;
    changes.push({ arrStation: a.station, depStation: b.station, arrUtc, depUtc, wait: Math.round((depUtc - arrUtc) / 60000), ...(w ? { walk: w.min, by: w.by } : {}), ...(w?.modes !== undefined ? { modes: w.modes } : {}), through });
  }
  const s0 = scheds[0]!, sl = scheds[k - 1]!;
  const depUtc = s0.stops[s0.board]!.depUtc!, arrUtc = sl.stops[sl.alight]!.arrUtc!;
  return { legs, changes, depUtc, arrUtc, minutes: Math.round((arrUtc - depUtc) / 60000), changeCount: changes.filter((c) => !c.through).length };
}

/** A departure one could change to instead of the one taken. */
export interface ChangeOption {
  trip: number;
  serviceDate: string;
  board: number;
  alight: number;
  depUtc: number;
  arrUtc: number;
  depStation: number;
  arrStation: number;
  number?: string;
  /** Minutes from the arrival of the previous leg to this departure. */
  wait: number;
  /** The departure the journey takes. */
  taken: boolean;
}

export interface ChangeOptionsIn {
  /** Arrival of the previous leg. */
  arrUtc: number;
  arrStation: number;
  /** The leg taken after the change (its trip and service date). */
  taken: { trip: number; date: string; depUtc: number };
  /** Departures count when this key (e.g. the brand) equals the taken one's. */
  key: (d: Departure) => string;
  takenKey: string;
  /** Minimum minutes from the arrival station to a departure station (Infinity: out of walking / cycling range). */
  transfer: (depStation: number) => number;
  /** Departures up to this many minutes after the arrival (at least an hour past the one taken). */
  windowMin?: number;
  limit?: number;
}

/**
 * Departures of the same kind (brand) from the change city towards the next leg's destination that can be
 * reached after the arrival – the taken one included and marked – in departure order, at most `limit` (the taken
 * one always kept).
 */
export function changeOptions(deps: Departure[], o: ChangeOptionsIn): ChangeOption[] {
  const takenWait = (o.taken.depUtc - o.arrUtc) / 60000;
  const end = o.arrUtc + Math.max(o.windowMin ?? 180, takenWait + 60) * 60000;
  const seen = new Set<string>();
  const out: ChangeOption[] = [];
  const isTaken = (d: Departure) => d.trip === o.taken.trip && d.serviceDate === o.taken.date;
  // the taken one first among departures at the same time (it wins the de-duplication below)
  for (const d of [...deps].sort((a, b) => a.depUtc - b.depUtc || Number(isTaken(b)) - Number(isTaken(a)) || a.arrUtc - b.arrUtc)) {
    const taken = isTaken(d);
    if (!taken) {
      if (d.depUtc > end || o.key(d) !== o.takenKey) continue;
      const t = o.transfer(d.depStation);
      if (!Number.isFinite(t) || d.depUtc < o.arrUtc + t * 60000) continue;
    }
    // one row per departure time and station (the same train in two runs of the data, coupled trains)
    const k = `${d.depUtc}|${d.depStation}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      trip: d.trip,
      serviceDate: d.serviceDate,
      board: d.board,
      alight: d.alight,
      depUtc: d.depUtc,
      arrUtc: d.arrUtc,
      depStation: d.depStation,
      arrStation: d.arrStation,
      ...(d.number !== undefined ? { number: d.number } : {}),
      wait: Math.round((d.depUtc - o.arrUtc) / 60000),
      taken,
    });
  }
  const limit = o.limit ?? 6;
  if (out.length <= limit) return out;
  // keep the taken one and its neighbours, earlier ones first
  const ti = Math.max(0, out.findIndex((x) => x.taken));
  const start = Math.max(0, Math.min(ti - Math.min(2, limit - 1), out.length - limit));
  return out.slice(start, start + limit);
}
