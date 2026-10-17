import { Cat, type CityFile, type ScheduleFile } from "@etbm/shared";
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

// a regional bus Alpha → Beta: a village before Alpha (no city), Alpha served at its stop "Alpha Nord" behind the
// main stop 0, a village (no city) and a stop of Beta between, a stop of Beta after the pattern's last stop
const bus: CityFile = {
  city: 0,
  routes: [{ name: "Bus 1", agency: "X", cat: Cat.Bus, flags: 0 }],
  patterns: [{ route: 0, stations: [0, 2], arr: [0, 60], dep: [0, 60], corridors: [30], headsign: "Beta Hamlet", run: 1 }],
  patternTz: [0],
  trips: [[0, 600, 0]],
  transfers: [],
  minTransfer: 3,
};
const sf: ScheduleFile = {
  stops: [
    ["Village A", 1, 1, -1],
    ["Village B", 1, 1, -1],
    ["Beta Hamlet", 2, 2, 1],
    ["Alpha Nord", 0, 0, 0],
    ["Beta West", 2, 2, 1],
  ],
  runs: [{ via: [0, 0, 0, 0] }, { via: [0, 0, -10, -10, 1, 1, 20, 22, 1, 4, 50, 50, 2, 2, 70, 70], at: [0, 3] }],
};

describe("trip schedule with stops only listed (ScheduleRun.via)", () => {
  const s = tripSchedule(bus, ctx, { from: 0, trip: 0, date: "2026-10-06", board: 0, alight: 1 }, sf)!;

  it("lists every stop of the run in travel order", () => {
    expect(s.stops.map((x) => x.minorName ?? x.station)).toEqual(["Village A", "Alpha Nord", "Village B", "Beta West", 2, "Beta Hamlet"]);
    expect(s.stops.map((x) => x.stop)).toEqual([-1, 0, -1, -1, 1, -1]);
    expect(s.stops.map((x) => x.city)).toEqual([-1, 0, -1, 1, 1, 1]);
    expect([s.board, s.alight]).toEqual([1, 4]);
    expect(s.stops[1]!.station).toBe(0); // connections stay at the pattern's station
  });

  it("gives them their own times and parts, without connections", () => {
    expect(fmtTime(s.stops[0]!.depUtc!, "Europe/Berlin")).toBe("09:50");
    expect(fmtTime(s.stops[2]!.arrUtc!, "Europe/Berlin")).toBe("10:20");
    expect(s.stops[2]!.dwell).toBe(2);
    expect(s.stops.map((x) => x.part)).toEqual(["before", "ride", "ride", "ride", "ride", "after"]);
    expect(s.stops.map((x) => x.rideIn)).toEqual([false, false, true, true, true, false]);
    expect(s.stops.map((x) => x.onward)).toEqual([false, false, false, false, true, false]);
    expect(s.stops.map((x) => x.cityRep)).toEqual([false, true, false, false, true, false]);
    expect(s.stops[0]!.tz).toBe("Europe/Berlin"); // no city: the trip's zone
    expect(s.stops[5]!.tz).toBe("Europe/Prague");
  });

  it("falls back to the pattern's stops without the schedule file", () => {
    const p = tripSchedule(bus, ctx, { from: 0, trip: 0, date: "2026-10-06", board: 0, alight: 1 })!;
    expect(p.stops.map((x) => x.station)).toEqual([0, 2]);
    expect([p.board, p.alight]).toEqual([0, 1]);
  });
});
