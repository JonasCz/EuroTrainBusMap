import { describe, expect, it } from "vitest";
import { journeyCities, usefulConnections, type Connection, type OnwardStop } from "./connections.ts";
import type { TripSchedule } from "./schedule.ts";

/** A schedule whose stops lie in `cities` (−1 = outside every city), boarding / alighting at stop indices. */
const sched = (cities: number[], board: number, alight: number): TripSchedule =>
  ({ board, alight, stops: cities.map((city) => ({ city })) }) as unknown as TripSchedule;
const stop = (city: number): OnwardStop => ({ stop: city, city, station: city, arrUtc: city, corridors: [] });
const conn = (trip: number, cities: number[], through = false): Connection => ({ trip, through, stops: cities.map(stop) }) as unknown as Connection;

describe("useful onward connections", () => {
  // Ventimiglia (0) – Breil (1) – Tende (2) – Vernante (3) – Cuneo (4), boarded at Ventimiglia
  const run = sched([0, 1, -1, 2, 3, 4], 0, 5);
  it("covers the origin and the whole run of the current vehicle", () => {
    expect([...journeyCities(0, [run])].sort()).toEqual([0, 1, 2, 3, 4]);
  });
  it("covers only the ridden part of earlier legs", () => {
    // an earlier leg on 10 – 11 – 12 – 13 – 14, boarded at 11 and left at 13: 10 and 14 were never passed
    const first = sched([10, 11, 12, 13, 14], 1, 3);
    expect([...journeyCities(11, [first, run])].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 11, 12, 13]);
  });
  it("drops departures along the same line or back, keeps those to new places", () => {
    const known = journeyCities(0, [run]);
    const conns = [
      conn(1, [4]), // another train on to Cuneo
      conn(2, [1, 0]), // back to Ventimiglia
      conn(3, [4, 20, 21]), // via Cuneo to Torino: Torino and beyond are new
      conn(4, [30]), // a bus off the line
    ];
    const u = usefulConnections(conns, known);
    expect(u.map((c) => c.trip)).toEqual([3, 4]);
    expect(u[0]!.stops.map((s) => s.city)).toEqual([20, 21]);
    expect(u[1]).toBe(conns[3]); // untouched rows are kept as they are
    expect(conns[2]!.stops).toHaveLength(3); // the input is not changed
  });
  it("drops the same vehicle continuing along the run", () => {
    expect(usefulConnections([conn(9, [4], true)], journeyCities(0, [run]))).toEqual([]);
  });
});
