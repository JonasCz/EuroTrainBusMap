import { describe, expect, it } from "vitest";
import { journeyCover, usefulConnections, type Connection, type OnwardStop } from "./connections.ts";
import type { TripSchedule } from "./schedule.ts";

/** A schedule whose stops lie in `cities` (−1 = outside every city), boarding / alighting at stop indices; stop i arrives at i * 10. */
const sched = (cities: number[], board: number, alight: number, t0 = 0): TripSchedule =>
  ({ board, alight, stops: cities.map((city, i) => ({ city, arrUtc: t0 + i * 10, depUtc: t0 + i * 10 })) }) as unknown as TripSchedule;
const stop = (city: number, arrUtc = 1000): OnwardStop => ({ stop: city, city, station: city, arrUtc, corridors: [] });
const conn = (trip: number, cities: (number | [number, number])[], through = false): Connection =>
  ({ trip, through, stops: cities.map((c) => (Array.isArray(c) ? stop(c[0], c[1]) : stop(c))) }) as unknown as Connection;
const sorted = (s: Iterable<number>) => [...s].sort((a, b) => a - b);

describe("useful onward connections", () => {
  // Ventimiglia (0) – Breil (1) – Tende (2) – Vernante (3) – Cuneo (4), boarded at Ventimiglia
  const run = sched([0, 1, -1, 2, 3, 4], 0, 5);
  it("covers the origin and the ride; the rest of the run is ahead, with its arrival times", () => {
    expect(sorted(journeyCover(0, [run]).passed)).toEqual([0, 1, 2, 3, 4]);
    const at = journeyCover(0, [run], 3); // getting off at Tende
    expect(sorted(at.passed)).toEqual([0, 1, 2]);
    expect([...at.ahead]).toEqual([[3, 40], [4, 50]]);
  });
  it("covers only the ridden part of earlier legs, and not the current run before boarding", () => {
    // an earlier leg on 10 – 11 – 12 – 13 – 14, boarded at 11 and left at 13: 10 and 14 were never passed
    const first = sched([10, 11, 12, 13, 14], 1, 3);
    expect(sorted(journeyCover(11, [first, run]).passed)).toEqual([0, 1, 2, 3, 4, 11, 12, 13]);
    // boarded the run at Breil: Ventimiglia (before boarding) is not covered
    expect(sorted(journeyCover(1, [sched([0, 1, -1, 2, 3, 4], 1, 3)]).passed)).toEqual([1, 2]);
  });
  it("drops departures along the same line or back, keeps those to new places", () => {
    const cover = journeyCover(0, [run]);
    const conns = [
      conn(1, [4]), // another train on to Cuneo
      conn(2, [1, 0]), // back to Ventimiglia
      conn(3, [4, 20, 21]), // via Cuneo to Torino: Torino and beyond are new
      conn(4, [30]), // a bus off the line
    ];
    const u = usefulConnections(conns, cover);
    expect(u.map((c) => c.trip)).toEqual([3, 4]);
    expect(u[0]!.stops.map((s) => s.city)).toEqual([20, 21]);
    expect(u[1]).toBe(conns[3]); // untouched rows are kept as they are
    expect(conns[2]!.stops).toHaveLength(3); // the input is not changed
  });
  it("drops the same vehicle continuing along the run", () => {
    const cover = journeyCover(0, [run], 3);
    expect(usefulConnections([conn(9, [[3, 40], [4, 50]], true)], cover)).toEqual([]);
  });
  it("keeps a place ahead on the run when another departure gets there first (overtaking)", () => {
    // off at Tende (stop 3, t = 30); the run reaches Cuneo at 50
    const cover = journeyCover(0, [run], 3);
    const u = usefulConnections([conn(1, [[4, 70]]), conn(2, [[3, 38], [4, 45]])], cover);
    expect(u.map((c) => c.trip)).toEqual([2]);
    expect(u[0]!.stops.map((s) => s.city)).toEqual([3, 4]);
  });
  it("keeps places on a run that ends where one gets off (Bordeaux – Marmande, then on to Agen)", () => {
    // Sainte-Foy (1) → Bordeaux (2); Bordeaux (2) – Langon (3) – Marmande (4), the end of that train
    const cover = journeyCover(1, [sched([0, 1, 2], 1, 2), sched([2, 3, 4], 0, 2)]);
    const u = usefulConnections([conn(5, [6, 7]), conn(6, [3, 2])], cover); // on to Tonneins / Agen; back to Bordeaux
    expect(u.map((c) => c.trip)).toEqual([5]);
    expect(sorted(cover.passed)).toEqual([1, 2, 3, 4]);
    expect(cover.ahead.size).toBe(0);
  });
});
