import { Cat, type CityFile } from "@etbm/shared";
import { describe, expect, it } from "vitest";
import { cityReps, stopPart, stopShow, tripSchedule } from "./schedule.ts";
import { ctx } from "./testdata.ts";
import { fmtTime } from "./tz.ts";

// one EC from Delta (London) through Alpha Hbf (10 min dwell), Alpha Süd, Beta (Prague) to Gamma (Istanbul)
const cf: CityFile = {
  city: 0,
  routes: [{ name: "EC", agency: "X", cat: Cat.LongDistance, flags: 0 }],
  patterns: [{ route: 0, stations: [4, 0, 1, 2, 3], arr: [0, 100, 108, 220, 600], dep: [0, 110, 110, 223, 600], corridors: [20, 21, 22, 23], headsign: "Gamma" }],
  patternTz: [0],
  trips: [[0, 1300, 0, "171"]], // 21:40 Berlin time, daily
  transfers: [],
  minTransfer: 5,
};

describe("trip schedule", () => {
  const s = tripSchedule(cf, ctx, { from: 0, trip: 0, date: "2026-10-06", board: 1, alight: 3 })!;

  it("splits the run into before / ride / after", () => {
    expect(s.stops.map((x) => x.part)).toEqual(["before", "ride", "ride", "ride", "after"]);
    expect(s.stops.map((x) => x.rideIn)).toEqual([false, false, true, true, false]);
    expect(s.stops.map((x) => x.rideOut)).toEqual([false, true, true, false, false]);
    expect(s.ride).toEqual([21, 22]);
    expect(s.outside).toEqual([20, 23]);
  });

  it("shows departures, arrivals at the ends and both on a dwell over 5 minutes", () => {
    expect(s.stops.map((x) => x.show)).toEqual(["dep", "both", "dep", "arr", "arr"]);
    expect(s.stops[0]!.arrUtc).toBeNull();
    expect(s.stops[4]!.depUtc).toBeNull();
    expect(s.stops[1]!.dwell).toBe(10);
    expect(s.stops[3]!.dwell).toBe(3); // alighting stop: arrival only
    expect(stopShow(2, 5, 6, 4)).toBe("both");
    expect(stopShow(2, 5, 5, 4)).toBe("dep");
    expect(stopPart(0, 0, 2)).toBe("ride");
  });

  it("gives local times per stop and day shifts relative to the boarding date", () => {
    expect(s.refDate).toBe("2026-10-06");
    expect(fmtTime(s.stops[0]!.depUtc!, "Europe/London")).toBe("20:40");
    expect(fmtTime(s.stops[1]!.depUtc!, "Europe/Berlin")).toBe("23:30");
    expect(fmtTime(s.stops[3]!.arrUtc!, "Europe/Prague")).toBe("01:20");
    expect(fmtTime(s.stops[4]!.arrUtc!, "Europe/Istanbul")).toBe("08:40");
    expect(s.stops.map((x) => x.dayShift)).toEqual([0, 0, 0, 1, 1]);
  });

  it("offers onward connections only after boarding and outside the boarding city", () => {
    expect(s.stops.map((x) => x.onward)).toEqual([false, false, false, true, true]);
  });

  it("offers the whole city once per run of stops in one city", () => {
    expect(s.stops.map((x) => x.cityRep)).toEqual([true, true, false, true, true]);
    // runs [0], [1 2 3], [4 5]: the preferred stop wins inside its run, else the best rank
    const ranks = [0, 2, 0, 1, 3, 1];
    expect(cityReps([7, 8, 8, 8, 9, 9], 1, (i) => ranks[i]!)).toEqual([0, 1, 5]);
    expect(cityReps([7, 8, 8, 8, 9, 9], -1, (i) => ranks[i]!)).toEqual([0, 2, 5]);
  });

  it("rejects invalid legs", () => {
    expect(tripSchedule(cf, ctx, { from: 0, trip: 0, date: "2026-10-06", board: 3, alight: 1 })).toBeNull();
    expect(tripSchedule(cf, ctx, { from: 0, trip: 5, date: "2026-10-06", board: 1, alight: 3 })).toBeNull();
  });
});
