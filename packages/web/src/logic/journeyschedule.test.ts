import { Cat, type CityFile, type Route } from "@etbm/shared";
import { describe, expect, it } from "vitest";
import { changeOptions, journeySchedule } from "./journeyschedule.ts";
import { tripSchedule } from "./schedule.ts";
import { ctx } from "./testdata.ts";
import type { Departure } from "./timetable.ts";

// leg 1: EC Delta → Alpha Hbf, continuing to Beta and Gamma; walk to Alpha Süd; leg 2: RE from Eps through
// Alpha Süd to Beta (its terminus); a third leg stays on board of the RE's next run
const cf: CityFile = {
  city: 0,
  routes: [
    { name: "EC", agency: "X", cat: Cat.LongDistance, flags: 0 },
    { name: "RE", agency: "X", cat: Cat.Regional, flags: 0 },
  ],
  patterns: [
    { route: 0, stations: [4, 0, 2, 3], arr: [0, 100, 220, 600], dep: [0, 110, 223, 600], corridors: [1, 2, 3], headsign: "Gamma" },
    { route: 1, stations: [5, 1, 2], arr: [0, 30, 90], dep: [0, 32, 90], corridors: [4, 5], headsign: "Beta" },
    { route: 1, stations: [2, 3], arr: [0, 60], dep: [0, 60], corridors: [6], headsign: "Gamma" },
  ],
  patternTz: [0, 0, 0],
  trips: [
    [0, 600, 0, "171"], // 10:00 Berlin from Delta (London 09:00), Alpha Hbf 11:40
    [1, 720, 0, "5"], // 12:00 from Eps, Alpha Süd 12:30 → 12:32, Beta 13:30
    [2, 815, 0, "5"], // 13:35 Beta → Gamma, same number
  ],
  transfers: [[0, 1, 15]],
  minTransfer: 5,
};
const date = "2026-10-06";
const s1 = tripSchedule(cf, ctx, { from: 3, trip: 0, date, board: 0, alight: 1 })!;
const s2 = tripSchedule(cf, ctx, { from: 0, trip: 1, date, board: 1, alight: 2 })!;
const s3 = tripSchedule(cf, ctx, { from: 1, trip: 2, date, board: 0, alight: 1 })!;

describe("journey schedule", () => {
  const j = journeySchedule([s1, s2], (i) => (i === 1 ? 15 : undefined))!;

  it("lists the first leg from its first stop and folds the stops after the change", () => {
    const [a, b] = j.legs;
    expect([a!.from, a!.to, a!.foldBefore, a!.foldAfter]).toEqual([0, 1, 0, 2]);
    // the last leg starts at boarding (one stop folded before) and runs to its terminus
    expect([b!.from, b!.to, b!.foldBefore, b!.foldAfter]).toEqual([1, 2, 1, 0]);
  });

  it("describes the change: walk between stations and the time between the trains", () => {
    expect(j.changes).toHaveLength(1);
    const c = j.changes[0]!;
    expect([c.arrStation, c.depStation, c.walk, c.by, c.through]).toEqual([0, 1, 15, "walk", false]);
    // a bike ride between the stations
    const r = journeySchedule([s1, s2], () => ({ min: 9, by: "bike" }))!.changes[0]!;
    expect([r.walk, r.by]).toEqual([9, "bike"]);
    expect(c.wait).toBe(52); // 11:40 → 12:32
    expect(j.changeCount).toBe(1);
    expect(j.minutes).toBe(210); // 10:00 → 13:30
  });

  it("stays on board when the same train continues", () => {
    const t = journeySchedule([s2, s3])!;
    expect(t.changes[0]!.through).toBe(true);
    expect(t.changes[0]!.walk).toBeUndefined();
    expect(t.changeCount).toBe(0);
    // terminus at the change, start of the run at the change: nothing to fold
    expect([t.legs[0]!.foldAfter, t.legs[1]!.foldBefore]).toEqual([0, 0]);
  });

  it("shows a single trip as its schedule", () => {
    const one = journeySchedule([s1])!;
    expect([one.legs[0]!.from, one.legs[0]!.to, one.legs[0]!.foldAfter]).toEqual([0, 3, 0]);
    expect(journeySchedule([])).toBeNull();
  });
});

describe("change options", () => {
  const route: Route = { name: "TER", agency: "SNCF", cat: Cat.Regional, flags: 0 };
  const min = 60000;
  const dep = (trip: number, depMin: number, depStation: number, name = "TER"): Departure => ({
    trip, pattern: 0, serviceDate: date, board: 0, alight: 1, depUtc: depMin * min, arrUtc: (depMin + 100) * min, depStation, arrStation: 9,
    route: { ...route, name }, number: String(trip), headsign: "Nice", startStation: null, endStation: 9, minutes: 100, note: null, corridors: [],
    altBoard: [], altAlight: [], tripTz: "Europe/Paris",
  });
  const deps = [dep(1, 590, 7), dep(2, 615, 7), dep(3, 640, 8), dep(4, 650, 7, "TGV INOUI"), dep(5, 700, 7), dep(6, 760, 7), dep(7, 900, 7), dep(8, 1000, 7)];
  const opts = (taken: number, extra = {}) =>
    changeOptions(deps, {
      arrUtc: 600 * min,
      arrStation: 7,
      taken: { trip: taken, date, depUtc: deps.find((d) => d.trip === taken)!.depUtc },
      key: (d) => d.route.name,
      takenKey: "TER",
      // station 8 is a 45 min walk away
      transfer: (s) => (s === 7 ? 8 : s === 8 ? 45 : Infinity),
      ...extra,
    });

  it("lists the reachable departures of the same kind, with the wait from the arrival", () => {
    const o = opts(2);
    // 590 left before the arrival, 640 not reachable on foot, the TGV is another brand, 900+ beyond 3 h
    expect(o.map((x) => [x.trip, x.wait, x.taken])).toEqual([
      [2, 15, true],
      [5, 100, false],
      [6, 160, false],
    ]);
  });

  it("lists a departure once when the same train appears twice, as the taken one", () => {
    const twin = { ...dep(9, 615, 7), number: "9" };
    const o = changeOptions([twin, ...deps], {
      arrUtc: 600 * min,
      arrStation: 7,
      taken: { trip: 2, date, depUtc: 615 * min },
      key: (d) => d.route.name,
      takenKey: "TER",
      transfer: () => 8,
    });
    expect(o.filter((x) => x.depUtc === 615 * min).map((x) => [x.trip, x.taken])).toEqual([[2, true]]);
  });

  it("widens the window to an hour past a late connection and keeps the taken one when limiting", () => {
    expect(opts(7).map((x) => x.trip)).toEqual([2, 5, 6, 7]);
    expect(opts(7, { limit: 2 }).map((x) => x.trip)).toEqual([6, 7]);
    expect(opts(2, { limit: 2 }).map((x) => x.trip)).toEqual([2, 5]);
  });
});
