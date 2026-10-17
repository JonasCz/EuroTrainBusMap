import { describe, expect, it } from "vitest";
import { Cat, decodeTtChunk, encodeTtChunk, type TtPatternIn } from "@etbm/shared";
import { buildCalIndex, encodeMask } from "./calendar.ts";
import { TransferSearch, TtStore, type SearchParams, type TtNet } from "./transfer.ts";

// 2026-10-20 is a Tuesday; Europe/Berlin is on CEST (UTC+2)
const DATE = "2026-10-20";
const START = "2026-10-19";
const DAYS = 7;
const cal = buildCalIndex({
  startDate: START,
  days: DAYS,
  masks: [
    encodeMask(Array.from({ length: DAYS }, () => true)), // 0 daily
    encodeMask(Array.from({ length: DAYS }, (_, i) => i === 3)), // 1 Thursday only
  ],
});

// cities and their stations
const CITY: Record<string, number[]> = {
  A: [0, 1], // origin
  B: [2], // intermediate stop of the A → C train
  C: [3],
  D: [4],
  E: [5],
  F: [6], // reached late in the evening
  G: [7],
  W: [8, 9, 10, 16], // 8 – 9: 12 min walk; 10 and 16 beyond walking range (no walking transfer)
  X: [11],
  Y: [12],
  Z: [13],
  Q: [14],
  T: [15],
};
const names = Object.keys(CITY);
const cityId = (n: string) => names.indexOf(n);
const stationCity = new Int32Array(17).fill(-1);
names.forEach((n, i) => CITY[n]!.forEach((s) => (stationCity[s] = i)));
const net: TtNet = {
  stationCity,
  cityStations: (c) => CITY[names[c]!]!,
  cityTz: names.map(() => "Europe/Berlin"),
  timezones: ["Europe/Berlin"],
  cal,
};

let pid = 0;
/** A pattern through `stops` ([station, minutes after start]) with trips starting at `starts` (local service minutes). */
const pat = (cat: number, stops: [number, number][], starts: number[], calendar = 0): TtPatternIn => ({
  id: pid++,
  cat,
  tz: 0,
  stations: stops.map((s) => s[0]),
  arr: stops.map((s) => s[1]),
  dep: stops.map((s) => s[1]),
  trips: starts.map((s) => [s, calendar]),
});
const h = (hh: number, mm = 0) => hh * 60 + mm;

const patterns: TtPatternIn[] = [
  // A → B → C, 08:00, at B 09:00, at C 10:00
  pat(Cat.LongDistance, [[0, 0], [2, 60], [3, 120]], [h(8)]),
  // B → E 09:05 (5 min after arriving at B) and 09:20
  pat(Cat.Regional, [[2, 0], [5, 30]], [h(9, 5)]),
  pat(Cat.Regional, [[2, 0], [14, 30]], [h(9, 20)]),
  // C → D 18:00 (an 8 h wait) by bus
  pat(Cat.Bus, [[3, 0], [4, 45]], [h(18)]),
  // A → F 21:00 → 23:00; F → G 00:20 the next day (80 min wait across midnight)
  pat(Cat.Coach, [[1, 0], [6, 120]], [h(21)]),
  pat(Cat.Regional, [[6, 0], [7, 30]], [h(0, 20)]),
  // A → W(8) 10:00 → 12:00
  pat(Cat.Regional, [[0, 0], [8, 120]], [h(10)]),
  // A → W(16) 11:00 → 11:50: a later origin departure, but 16 is too far from 9 and 10 to walk
  pat(Cat.Regional, [[1, 0], [16, 50]], [h(11)]),
  // from W: station 9 (12 min walk) 12:15 and 12:08, station 10 (beyond walking range) 12:25 and 15:00
  pat(Cat.Bus, [[9, 0], [11, 20]], [h(12, 15)]),
  pat(Cat.Bus, [[9, 0], [12, 20]], [h(12, 8)]),
  pat(Cat.Bus, [[10, 0], [13, 20]], [h(12, 25), h(15)]),
  // E → T 11:00 (a second change after B → E)
  pat(Cat.Regional, [[5, 0], [15, 40]], [h(11)]),
  // A → Q only on Thursdays (not on the travel day)
  pat(Cat.Regional, [[0, 0], [14, 50]], [h(7)], 1),
];
const walk: [number, number, number][] = [[8, 9, 12]];

function store(): TtStore {
  const s = new TtStore(stationCity.length);
  // two chunks, the pattern list split (and one pattern in both: kept once)
  s.addChunk(decodeTtChunk(encodeTtChunk({ patterns: patterns.slice(0, 8), walk: [] })));
  s.addChunk(decodeTtChunk(encodeTtChunk({ patterns: patterns.slice(7), walk })));
  return s;
}

function reach(over: Partial<SearchParams> = {}) {
  const s = new TransferSearch(store(), net, { origin: cityId("A"), date: DATE, cats: 15, transfers: 1, minTransfer: 10, maxWait: null, ...over });
  while (!s.done) s.round();
  const lv = (n: string) => s.out.level[cityId(n)];
  return { s, lv };
}

describe("transfer timetable chunks", () => {
  it("round-trips patterns, trips and walking transfers", () => {
    const c = decodeTtChunk(encodeTtChunk({ patterns: patterns.slice(0, 2), walk }));
    expect(Array.from(c.pId)).toEqual([0, 1]);
    expect(Array.from(c.stStation)).toEqual([0, 2, 3, 2, 5]);
    expect(Array.from(c.stArr)).toEqual([0, 60, 120, 0, 30]);
    expect(Array.from(c.trStart)).toEqual([h(8), h(9, 5)]);
    expect(Array.from(c.walk)).toEqual([8, 9, 12]);
  });
  it("keeps a pattern found in two chunks once", () => {
    expect(store().patterns).toBe(patterns.length);
  });
});

describe("reach with changes", () => {
  it("reaches the stops of direct trips in round 1, intermediate ones included", () => {
    const { lv, s } = reach({ transfers: 0 });
    expect(lv("B")).toBe(1);
    expect(lv("C")).toBe(1);
    expect(lv("E")).toBe(0);
    expect(s.out.minutes[cityId("C")]).toBe(120);
  });
  it("changes at an intermediate stop, respecting the minimum transfer time", () => {
    // B → E leaves 5 min after the arrival at B; B → Q 20 min after
    expect(reach({ minTransfer: 5 }).lv("E")).toBe(2);
    expect(reach({ minTransfer: 10 }).lv("E")).toBe(0);
    const r = reach({ minTransfer: 10 });
    expect(r.lv("Q")).toBe(2);
    expect(r.s.out.via[cityId("Q")]).toBe(cityId("B"));
    expect(r.s.out.minutes[cityId("Q")]).toBe(h(9, 50) - h(8)); // origin 08:00 → Q 09:50
  });
  it("limits the wait: hours or until local midnight", () => {
    expect(reach({ maxWait: null }).lv("D")).toBe(2); // 10:00 → 18:00, same day
    expect(reach({ maxWait: 180 }).lv("D")).toBe(0); // 8 h > 3 h
    // 23:00 → 00:20 the next day: not the same day, but within 2 hours
    expect(reach({ maxWait: null }).lv("G")).toBe(0);
    expect(reach({ maxWait: 120 }).lv("G")).toBe(2);
  });
  it("walks between the stations of a city (at least the walk, no transfer beyond walking range)", () => {
    const r = reach({ minTransfer: 5 });
    expect(r.lv("X")).toBe(2); // 15 min ≥ 12 min walk
    // from the 10:00 train (the 11:00 one arrives at station 16, too far from 9 to walk)
    expect(r.s.out.minutes[cityId("X")]).toBe(h(12, 35) - h(10));
    expect(r.lv("Y")).toBe(0); // 8 min < 12 min walk
    expect(r.lv("Z")).toBe(0); // station 10 is beyond walking range: not even after 3 h
    expect(reach({ minTransfer: 13 }).lv("X")).toBe(2); // 15 ≥ max(13, 12)
    expect(reach({ minTransfer: 16 }).lv("X")).toBe(0);
  });
  it("applies the mode filter to every leg", () => {
    expect(reach({ cats: Cat.LongDistance | Cat.Regional }).lv("D")).toBe(0); // C → D is a bus
    expect(reach({ cats: Cat.Regional | Cat.Bus }).lv("C")).toBe(0); // A → C is long-distance
    expect(reach({ cats: Cat.Regional | Cat.Bus }).lv("X")).toBe(2);
  });
  it("uses only trips running on the travel day", () => {
    const r = reach({ transfers: 0 });
    expect(r.lv("Q")).toBe(0); // the Thursday train
    const thu = reach({ transfers: 0, date: "2026-10-22" });
    expect(thu.lv("Q")).toBe(1);
  });
  it("counts further changes as further levels", () => {
    expect(reach({ minTransfer: 5, transfers: 1 }).lv("T")).toBe(0);
    expect(reach({ minTransfer: 5, transfers: 2 }).lv("T")).toBe(3);
  });
  it("records the ridden hops per round", () => {
    const { s } = reach({ minTransfer: 5 });
    const hops = (r: number) => Array.from(s.out.hops[r]!).filter((_, i) => i % 3 !== 2);
    expect(hops(0)).toEqual(expect.arrayContaining([0, 2, 2, 3]));
    expect(hops(1)).toEqual(expect.arrayContaining([2, 5]));
  });
});

describe("journeys with changes", () => {
  it("lists the legs with stations, times and service dates", () => {
    const s = new TransferSearch(store(), net, { origin: cityId("A"), target: cityId("E"), date: DATE, cats: 15, transfers: 1, minTransfer: 5, maxWait: null });
    while (!s.done) s.round();
    const js = s.journeys();
    expect(js).toHaveLength(1);
    const [l1, l2] = js[0]!.legs;
    expect([l1!.stations[l1!.board], l1!.stations[l1!.alight]]).toEqual([0, 2]);
    expect([l2!.stations[l2!.board], l2!.stations[l2!.alight]]).toEqual([2, 5]);
    expect(l1!.serviceDate).toBe(DATE);
    // 08:00 CEST = 06:00 UTC, arrival 09:35 CEST
    expect(new Date(js[0]!.depUtc).toISOString()).toBe("2026-10-20T06:00:00.000Z");
    expect(new Date(js[0]!.arrUtc).toISOString()).toBe("2026-10-20T07:35:00.000Z");
  });
  it("crosses midnight with an hour limit, on the next service day", () => {
    const s = new TransferSearch(store(), net, { origin: cityId("A"), target: cityId("G"), date: DATE, cats: 15, transfers: 1, minTransfer: 5, maxWait: 120 });
    while (!s.done) s.round();
    const [j] = s.journeys();
    expect(j!.legs[1]!.serviceDate).toBe("2026-10-21");
    expect(new Date(j!.arrUtc).toISOString()).toBe("2026-10-20T22:50:00.000Z");
  });
});
