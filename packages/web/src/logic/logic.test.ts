import { Cat } from "@etbm/shared";
import { describe, expect, it } from "vitest";
import { connections, transferMinutes } from "./connections.ts";
import { ALL_CATS, decodeCats, encodeCats } from "./filters.ts";
import { decodeLegs, encodeLegs, resolveLeg } from "./journey.ts";
import { computeReach } from "./reach.ts";
import { nextServiceDates, pairCorridors, timetable } from "./timetable.ts";
import { fmtTime, wallToUtc } from "./tz.ts";
import { alpha, ctx } from "./testdata.ts";

const all = { cats: ALL_CATS, dticket: false };
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
    expect([...r.corridors.keys()].sort()).toEqual([10, 11, 13]); // never-running coach (14) excluded
  });
  it("respects filters", () => {
    const r = computeReach(alpha, ctx, { cats: Cat.Regional, dticket: false });
    expect([...r.dests.keys()]).toEqual([4]);
    expect([...r.corridors]).toEqual([[13, Cat.Regional]]);
    const d = computeReach(alpha, ctx, { cats: ALL_CATS, dticket: true });
    expect([...d.dests.keys()]).toEqual([4]);
    const c = computeReach(alpha, ctx, { cats: Cat.Coach, dticket: false });
    expect([...c.dests.keys()]).toEqual([1]);
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
    expect(t[1]!.note).toBe("Fri, Sun only");
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
    const coach = { cats: Cat.Coach, dticket: false };
    expect(timetable(alpha, ctx, coach, 1, "2026-10-08")).toHaveLength(0);
    expect(nextServiceDates(alpha, ctx, coach, 1, "2026-10-04")).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(nextServiceDates(alpha, ctx, coach, 1, "2026-10-08")).toEqual([]);
    expect(nextServiceDates(alpha, ctx, all, 1, "2026-10-10", 2)).toEqual(["2026-10-11", "2026-10-12"]);
  });
  it("pair corridors", () => {
    expect([...pairCorridors(alpha, ctx, all, 2)]).toEqual([[10, Cat.LongDistance], [11, Cat.LongDistance]]);
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
    expect(info.corridors).toEqual([10]);
    expect(fmtTime(info.arrUtc, "Europe/Prague")).toBe("12:00");
    const s = encodeLegs([leg]);
    expect(s).toBe("0.20261010.0.2");
    expect(decodeLegs(s, 0)).toEqual([leg]);
    expect(resolveLeg(alpha, ctx, { ...leg, from: 3 })).toBeNull();
  });
});
