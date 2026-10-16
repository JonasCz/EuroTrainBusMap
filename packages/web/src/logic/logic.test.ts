import { Cat } from "@etbm/shared";
import { describe, expect, it } from "vitest";
import { connections, transferMinutes } from "./connections.ts";
import { ALL_CATS, decodeCats, encodeCats } from "./filters.ts";
import { decodeLegs, encodeLegs, resolveLeg } from "./journey.ts";
import { computeReach } from "./reach.ts";
import { nextServiceDates, pairCandidates, pairCorridors, timetable } from "./timetable.ts";
import { fmtTime, wallToUtc } from "./tz.ts";
import { alpha, calendars, ctx, network } from "./testdata.ts";
import { buildCalIndex, encodeMask } from "./calendar.ts";
import { buildNetCtx } from "./context.ts";
import type { CityFile } from "@etbm/shared";

const all = { cats: ALL_CATS };
const BER = "Europe/Berlin";

describe("filters", () => {
  it("encodes categories", () => {
    expect(encodeCats(ALL_CATS)).toBe("lrcb");
    expect(decodeCats("rc")).toBe(Cat.Regional | Cat.Coach);
    expect(decodeCats(null)).toBe(ALL_CATS);
  });
});

describe("reach", () => {
  it("finds downstream cities with fastest time", () => {
    const r = computeReach(alpha, ctx, all);
    expect([...r.dests.keys()].sort()).toEqual([1, 2, 4]);
    expect(r.dests.get(1)!.minutes).toBe(110); // from Alpha Süd (last stop in city)
    expect(r.dests.get(1)!.cats).toBe(Cat.LongDistance | Cat.Coach);
    expect(r.dests.get(2)!.minutes).toBe(590);
    expect(r.dests.get(4)!.minutes).toBe(30);
    expect(r.dests.has(3)).toBe(false); // Delta is upstream only
    expect([...r.corridors.keys()].sort()).toEqual([10, 11, 13, 9]); // 9 = Alpha Hbf → Alpha Süd inside the city; never-running coach (14) excluded
  });
  it("respects filters", () => {
    const r = computeReach(alpha, ctx, { cats: Cat.Regional });
    expect([...r.dests.keys()]).toEqual([4]);
    expect([...r.corridors]).toEqual([[13, Cat.Regional]]);
    const c = computeReach(alpha, ctx, { cats: Cat.Coach });
    expect([...c.dests.keys()]).toEqual([1]);
  });
});

describe("reach from one station", () => {
  it("only uses trips that board at the station", () => {
    const sued = computeReach(alpha, ctx, all, 1); // Alpha Süd
    expect([...sued.dests.keys()].sort()).toEqual([1, 2]);
    expect(sued.dests.get(1)!.minutes).toBe(110);
    expect([...sued.corridors.keys()].sort()).toEqual([10, 11]);
    const hbf = computeReach(alpha, ctx, all, 0); // Alpha Hbf: ICE (not the coach from Süd), both REs
    expect([...hbf.dests.keys()].sort()).toEqual([1, 2, 4]);
    expect(hbf.dests.get(1)!.minutes).toBe(120);
    expect(hbf.dests.get(1)!.cats).toBe(Cat.LongDistance);
    expect([...hbf.corridors.keys()].sort()).toEqual([10, 13, 9, 11].sort());
    expect(computeReach(alpha, ctx, all, 4).dests.size).toBe(0); // a station of another city
  });
  it("lists the departures of that station only", () => {
    const hbf = timetable(alpha, ctx, all, 1, "2026-10-09", pairCandidates(alpha, ctx, all, 1, 0));
    expect(hbf.map((d) => fmtTime(d.depUtc, BER))).toEqual(["10:00", "23:50"]);
    expect(hbf[0]!.altBoard).toEqual([]); // no "also from Alpha Süd"
    const sued = timetable(alpha, ctx, all, 1, "2026-10-09", pairCandidates(alpha, ctx, all, 1, 1));
    expect(sued.map((d) => fmtTime(d.depUtc, BER))).toEqual(["10:10"]);
    expect(sued[0]!.depStation).toBe(1);
    expect([...pairCorridors(alpha, ctx, all, 1, 1).keys()]).toEqual([10]);
    expect([...pairCorridors(alpha, ctx, all, 1, 0).keys()].sort((a, b) => a - b)).toEqual([9, 10]);
  });
});

describe("timetable", () => {
  it("lists departures on a Friday incl. weekday-limited trip", () => {
    const t = timetable(alpha, ctx, all, 1, "2026-10-09");
    expect(t.map((d) => fmtTime(d.depUtc, BER))).toEqual(["10:00", "23:50"]);
    expect(t[0]!.depStation).toBe(0);
    expect(t[0]!.arrStation).toBe(2);
    expect(fmtTime(t[0]!.arrUtc, "Europe/Prague")).toBe("12:00");
    expect(t[0]!.minutes).toBe(120);
    expect(t[0]!.altBoard.map((s) => s.station)).toEqual([1]);
    expect(t[0]!.note).toBeNull();
    expect(t[1]!.note).toBe("Fri, Sun");
    expect(t[1]!.number).toBe("3");
    expect(timetable(alpha, ctx, all, 1, "2026-10-10")).toHaveLength(1);
  });
  it("includes previous-service-day and cross-timezone trips", () => {
    const t = timetable(alpha, ctx, all, 4, "2026-10-10");
    expect(t.map((d) => fmtTime(d.depUtc, BER))).toEqual(["00:20", "02:05", "11:40"]);
    expect(t[0]!.serviceDate).toBe("2026-10-09");
    expect(t[1]!.serviceDate).toBe("2026-10-09");
    expect(t[1]!.startStation).toBe(4); // from Delta
    expect(t[1]!.minutes).toBe(55);
    expect(t[2]!.startStation).toBeNull();
  });
  it("next service dates", () => {
    const coach = { cats: Cat.Coach };
    expect(timetable(alpha, ctx, coach, 1, "2026-10-08")).toHaveLength(0);
    expect(nextServiceDates(alpha, ctx, coach, 1, "2026-10-04")).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(nextServiceDates(alpha, ctx, coach, 1, "2026-10-08")).toEqual([]);
    expect(nextServiceDates(alpha, ctx, all, 1, "2026-10-10", 2)).toEqual(["2026-10-11", "2026-10-12"]);
  });
  it("pair corridors", () => {
    // the ride from Alpha Hbf: its first hop is inside Alpha (Hbf → Süd), then Beta and Gamma
    expect([...pairCorridors(alpha, ctx, all, 2)]).toEqual([[9, Cat.LongDistance], [10, Cat.LongDistance], [11, Cat.LongDistance]]);
  });
});

describe("connections", () => {
  it("transfer minutes", () => {
    expect(transferMinutes(alpha, 0, 0)).toBe(5);
    expect(transferMinutes(alpha, 1, 0)).toBe(15);
  });
  it("respects walking transfer between stations", () => {
    const arr = { city: 0, station: 1, utc: wallToUtc("2026-10-10", 11 * 60, BER) };
    const c = connections(alpha, ctx, all, arr);
    expect(c.map((x) => fmtTime(x.depUtc, BER))).toEqual(["11:40"]);
    expect(c[0]!.transfer).toBe(15);
    expect(c[0]!.wait).toBe(40);
    expect(c[0]!.stops.map((s) => s.city)).toEqual([4]);
  });
  it("crosses midnight and detects through service", () => {
    const arr = { city: 0, station: 0, utc: wallToUtc("2026-10-09", 23 * 60 + 45, BER), routeName: "ICE", number: "3" };
    const c = connections(alpha, ctx, all, arr);
    expect(c.map((x) => fmtTime(x.depUtc, BER))).toEqual(["23:50", "00:20", "02:05"]);
    expect(c[0]!.through).toBe(true);
    expect(c[0]!.stops.map((s) => s.city)).toEqual([1, 2]);
    expect(c[1]!.serviceDate).toBe("2026-10-09");
    expect(c[2]!.startStation).toBe(4);
  });
});

describe("journey", () => {
  it("resolves and encodes legs", () => {
    const leg = { from: 0, trip: 0, date: "2026-10-10", board: 0, alight: 2 };
    const info = resolveLeg(alpha, ctx, leg)!;
    expect(info.to).toBe(1);
    expect(info.corridors).toEqual([9, 10]);
    expect(fmtTime(info.arrUtc, "Europe/Prague")).toBe("12:00");
    const s = encodeLegs([leg]);
    expect(s).toBe("0.20261010.0.2");
    expect(decodeLegs(s, 0)).toEqual([leg]);
    expect(resolveLeg(alpha, ctx, { ...leg, from: 3 })).toBeNull();
  });
});

describe("split trips", () => {
  // ICE 77 at 08:00 is two GTFS trips with disjoint calendars (Mon–Wed / Thu–Sun) and
  // different stop patterns; ICE 1 at 10:00 is listed twice (duplicate trip).
  const days = (pred: (wd: number) => boolean) => encodeMask(Array.from({ length: calendars.days }, (_, i) => pred((1 + i) % 7)));
  const cal2 = buildCalIndex({ ...calendars, masks: [...calendars.masks, days((wd) => wd >= 1 && wd <= 3), days((wd) => wd === 0 || wd >= 4)] });
  const ctx2 = buildNetCtx(network, cal2);
  const a2: CityFile = {
    ...alpha,
    patterns: [...alpha.patterns, { route: 0, stations: [0, 2], arr: [0, 120], dep: [0, 125], corridors: [10], headsign: "Beta" }],
    patternTz: [...alpha.patternTz, 0],
    trips: [...alpha.trips, [0, 480, 5, "77"], [5, 480, 6, "77"], [0, 600, 0, "1"]],
  };
  it("merges them into one row labelled with the union of their days", () => {
    for (const date of ["2026-10-05", "2026-10-09"]) {
      const t = timetable(a2, ctx2, { cats: Cat.LongDistance }, 1, date);
      expect(t.map((d) => `${fmtTime(d.depUtc, BER)} ${d.number}`)).toEqual(["08:00 77", "10:00 1", ...(date === "2026-10-09" ? ["23:50 3"] : [])]);
      expect(t[0]!.note).toBeNull(); // daily: Mon–Wed ∪ Thu–Sun
    }
  });
  it("merges onward connections too", () => {
    const arr = { city: 0, station: 0, utc: wallToUtc("2026-10-09", 7 * 60, BER) };
    const c = connections(a2, ctx2, all, arr).filter((x) => x.route.name === "ICE");
    expect(c.map((x) => `${fmtTime(x.depUtc, BER)} ${x.number}`)).toEqual(["08:00 77", "10:00 1"]);
    expect(c[0]!.note).toBeNull();
    expect(c[1]!.stops.map((s) => s.city)).toEqual([1, 2]);
  });
});
