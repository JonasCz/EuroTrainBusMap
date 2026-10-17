import { Cat } from "@etbm/shared";
import { describe, expect, it } from "vitest";
import { connections, transferMinutes } from "./connections.ts";
import { ALL_CATS, decodeCats, encodeCats } from "./filters.ts";
import { decodeLegs, encodeLegs, resolveLeg } from "./journey.ts";
import { computeReach } from "./reach.ts";
import { nextServiceDates, pairCandidates, pairCorridors, serviceDates, timetable } from "./timetable.ts";
import { depCats, depsWith, stationDepartures } from "./stations.ts";
import { fmtTime, wallToUtc } from "./tz.ts";
import { START, alpha, cal, calendars, ctx, network } from "./testdata.ts";
import { addDays, buildCalIndex, encodeMask } from "./calendar.ts";
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
  it("ignores zero-minute hops from feeds without real times when a real time exists", () => {
    const flat: CityFile = { ...alpha, patterns: [...alpha.patterns, { route: 0, stations: [0, 2], arr: [0, 0], dep: [0, 0], corridors: [15], headsign: "Beta" }], patternTz: [...alpha.patternTz, 0], trips: [...alpha.trips, [5, 600, 0, "99"]] };
    expect(computeReach(flat, ctx, all).dests.get(1)!.minutes).toBe(110);
  });
  it("counts the city's own trips per day on each corridor", () => {
    const r = computeReach(alpha, ctx, all);
    // corridor 10 (Alpha Süd → Beta): ICE daily + Fri/Sun (8 of 28 days), coach on 3 of 28 days
    expect(r.traffic.get(10)![Cat.LongDistance]).toBeCloseTo(1 + 8 / 28);
    expect(r.traffic.get(10)![Cat.Coach]).toBeCloseTo(3 / 28);
    // corridor 13 (Alpha Hbf → Eps): RE p1 daily + p3 twice daily (one RE pattern each)
    expect(r.traffic.get(13)![Cat.Regional]).toBeCloseTo(3);
    expect(r.traffic.has(12)).toBe(false); // Delta → Alpha is upstream
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
  it("service dates: the dates the timetable has departures on", () => {
    const coach = { cats: Cat.Coach };
    expect([...serviceDates(alpha, ctx, coach, 1)].sort()).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(serviceDates(alpha, ctx, { cats: Cat.Bus }, 1).size).toBe(0);
    // every date of the horizon (and the day after): a dot exactly where the timetable lists departures
    for (const dest of [1, 2, 4]) {
      const days = serviceDates(alpha, ctx, all, dest);
      for (let i = -1; i <= cal.days; i++) {
        const d = addDays(START, i);
        expect(days.has(d), `${dest} ${d}`).toBe(timetable(alpha, ctx, all, dest, d).length > 0);
      }
    }
    // the RE at 24:20 of the last service day departs the day after the horizon
    expect(serviceDates(alpha, ctx, all, 4).has(addDays(START, cal.days))).toBe(true);
    // from one station only: the coach boards at Alpha Süd, not at Alpha Hbf
    expect(serviceDates(alpha, ctx, coach, 1, 0).size).toBe(0);
    expect(serviceDates(alpha, ctx, coach, 1, 1).size).toBe(3);
  });
  it("pair corridors", () => {
    // the ride from Alpha Hbf: its first hop is inside Alpha (Hbf → Süd), then Beta and Gamma
    expect([...pairCorridors(alpha, ctx, all, 2)]).toEqual([[9, Cat.LongDistance], [10, Cat.LongDistance], [11, Cat.LongDistance]]);
  });
  it("pair corridors start at the first stop in the origin city, not at the row's boarding station", () => {
    // RE Alpha Süd → Alpha Hbf → Beta: the rows board at Hbf (main station), the line is drawn from Süd
    const cf: CityFile = { ...alpha, patterns: [{ route: 1, stations: [1, 0, 2], arr: [0, 10, 60], dep: [0, 12, 60], corridors: [20, 21], headsign: "Beta" }], patternTz: [0], trips: [[0, 600, 0, "11"]] };
    expect(pairCandidates(cf, ctx, all, 1)[0]!.corridors).toEqual([21]);
    expect([...pairCorridors(cf, ctx, all, 1).keys()]).toEqual([20, 21]);
    expect([...pairCorridors(cf, ctx, all, 1, 0).keys()]).toEqual([21]); // from Hbf only
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

describe("station departures", () => {
  it("counts departures per day by mode at each station of the city", () => {
    const deps = stationDepartures(alpha, ctx);
    // Alpha Hbf: ICE daily + Fri/Sun (8 of 28 days), RE p1 daily, RE p3 twice daily; the never-running coach is absent
    expect(deps.get(0)![Cat.LongDistance]).toBeCloseTo(1 + 8 / 28);
    expect(deps.get(0)![Cat.Regional]).toBeCloseTo(3);
    expect(deps.get(0)![Cat.Coach]).toBeUndefined();
    // Alpha Süd: the same ICE trips (they call at both) + the coach on 3 of 28 days
    expect(deps.get(1)![Cat.LongDistance]).toBeCloseTo(1 + 8 / 28);
    expect(deps.get(1)![Cat.Coach]).toBeCloseTo(3 / 28);
    expect(deps.has(2)).toBe(false); // Beta is another city
    expect(depsWith(deps.get(0), { cats: Cat.Coach })).toBe(0);
    expect(depsWith(deps.get(1), { cats: Cat.Coach })).toBeCloseTo(3 / 28);
    expect(depsWith(undefined, all)).toBe(0);
    expect(depCats(deps.get(1))).toEqual([Cat.LongDistance, Cat.Coach]);
  });
  it("agrees with the reach of the station: no departures, no destinations", () => {
    const deps = stationDepartures(alpha, ctx);
    for (const cats of [Cat.LongDistance, Cat.Regional, Cat.Coach, Cat.Bus, ALL_CATS])
      for (const st of [0, 1]) expect(depsWith(deps.get(st), { cats }) > 0, `${cats} ${st}`).toBe(computeReach(alpha, ctx, { cats }, st).dests.size > 0);
  });
  it("ignores the last stop of a pattern ending in the city", () => {
    // RE Delta → Alpha Hbf (terminates): arrivals only
    const cf: CityFile = { ...alpha, patterns: [{ route: 1, stations: [4, 0], arr: [0, 60], dep: [0, 60], corridors: [12], headsign: "Alpha" }], patternTz: [3], trips: [[0, 600, 0, "1"]] };
    expect(stationDepartures(cf, ctx).size).toBe(0);
  });
});
