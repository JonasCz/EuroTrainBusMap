import { describe, expect, it } from "vitest";
import { Cat, StopLimit } from "@etbm/shared";
import { PatternStore, localizeStart, processTripStops, repairTimes } from "../src/core/patterns.ts";
import { resolveDuplicates, type DupTrip } from "../src/core/dedup.ts";
import { sliceShape } from "../src/core/shapes.ts";

const base = { cityPop: (c: number) => (c === 9 ? 0 : 50_000), stationWeight: (s: number) => s };

describe("processTripStops", () => {
  it("collapses consecutive stops at the same station", () => {
    const t = processTripStops(
      [
        { station: 1, city: 1, arr: 600, dep: 600 },
        { station: 1, city: 1, arr: 602, dep: 605 },
        { station: 2, city: 2, arr: 660, dep: 662 },
      ],
      { ...base, cat: Cat.Regional },
    )!;
    expect(t.stations).toEqual([1, 2]);
    expect(t.start).toBe(605);
    expect(t.dep).toEqual([0, 57]);
    expect(t.arr).toEqual([0, 55]);
  });
  it("drops trips within one city", () => {
    expect(
      processTripStops([{ station: 1, city: 1, arr: 0, dep: 0 }, { station: 2, city: 1, arr: 5, dep: 5 }], { ...base, cat: Cat.Regional }),
    ).toBeNull();
  });
  it("bus: drops tiny places and collapses small-town runs", () => {
    const t = processTripStops(
      [
        { station: 1, city: 1, arr: 0, dep: 0 },
        { station: 5, city: 1, arr: 2, dep: 2 },
        { station: 7, city: 9, arr: 10, dep: 10 },
        { station: 3, city: 2, arr: 20, dep: 20 },
        { station: 8, city: 9, arr: 30, dep: 30 },
      ],
      { ...base, cat: Cat.Bus },
    )!;
    expect(t.stations).toEqual([5, 3]);
    expect(t.start).toBe(2);
    expect(t.arr).toEqual([0, 18]);
    // every left-out stop stays in the schedule: before the first pattern stop, and after the last one
    expect(t.via).toEqual([0, 1, -2, -2, 1, 7, 8, 8, 2, 8, 28, 28]);
    expect(t.at).toEqual([]);
  });
  it("bus: a village without inhabitants on record is a destination when it is a named place (busPlace)", () => {
    // Local Link 342 Flagmount – Scariff – Ennis: Flagmount and Scariff are villages (population 0 / 770 in GeoNames),
    // city 9 an unnamed stop cluster ("Digital Hub")
    const raw = [
      { station: 1, city: 4, arr: 0, dep: 0 },
      { station: 7, city: 9, arr: 16, dep: 16 },
      { station: 2, city: 5, arr: 30, dep: 30 },
      { station: 3, city: 2, arr: 90, dep: 90 },
    ];
    const t = processTripStops(raw, { ...base, cityPop: (c) => (c === 2 ? 27_923 : 0), busPlace: (c) => c !== 9, cat: Cat.Bus })!;
    expect(t.stations).toEqual([1, 2, 3]);
    expect(t.via).toEqual([1, 7, 16, 16]);
    // without busPlace only places with a population count: the trip reaches one city and is dropped
    expect(processTripStops(raw, { ...base, cityPop: (c) => (c === 2 ? 27_923 : 0), cat: Cat.Bus })).toBeNull();
  });
  it("bus: keeps a town's real stops behind its main stop, with their own times", () => {
    // stations 11 and 12 (city 1) are represented by the town's main stop 10; the vehicle serves 12 first
    const t = processTripStops(
      [
        { station: 10, real: 12, city: 1, arr: 0, dep: 1 },
        { station: 10, real: 11, city: 1, arr: 4, dep: 5 },
        { station: 7, city: 9, arr: 10, dep: 10 },
        { station: 3, city: 2, arr: 20, dep: 20 },
      ],
      { ...base, stationWeight: (s) => (s === 11 ? 100 : s), cat: Cat.Bus },
    )!;
    expect(t.stations).toEqual([10, 3]);
    // the main stop stands at its most important real stop (11), with its times
    expect(t.start).toBe(5);
    expect(t.at).toEqual([0, 11]);
    expect(t.via).toEqual([0, 12, -5, -4, 1, 7, 5, 5]);
  });
  it("bus: prefers the main stop itself where the vehicle serves it, also in a town with rail", () => {
    const t = processTripStops(
      [
        { station: 3, city: 2, arr: 0, dep: 0 },
        { station: 10, real: 12, city: 1, arr: 10, dep: 10 },
        { station: 10, city: 1, arr: 14, dep: 15 },
        { station: 10, real: 11, city: 1, arr: 20, dep: 20 },
      ],
      { ...base, stationWeight: (s) => (s === 11 ? 100 : s), cityHasRail: () => true, cat: Cat.Bus },
    )!;
    expect(t.stations).toEqual([3, 10]);
    expect(t.arr).toEqual([0, 14]);
    expect(t.at).toEqual([]);
    expect(t.via).toEqual([1, 12, 10, 10, 2, 11, 20, 20]);
  });
  it("bus: in big cities keeps entry/exit stops only", () => {
    const t = processTripStops(
      [
        { station: 1, city: 1, arr: 0, dep: 0 },
        { station: 2, city: 1, arr: 2, dep: 2 },
        { station: 3, city: 1, arr: 4, dep: 4 },
        { station: 4, city: 1, arr: 6, dep: 6 },
        { station: 5, city: 2, arr: 20, dep: 20 },
      ],
      { ...base, cityPop: () => 500_000, cat: Cat.Bus },
    )!;
    expect(t.stations).toEqual([1, 4, 5]);
  });
  it("keeps times after midnight", () => {
    const t = processTripStops([{ station: 1, city: 1, arr: 1430, dep: 1430 }, { station: 2, city: 2, arr: 1500, dep: 1500 }], { ...base, cat: Cat.LongDistance })!;
    expect(t.start).toBe(1430);
    expect(t.arr[1]).toBe(70);
  });
});

describe("PatternStore", () => {
  it("dedups identical patterns", () => {
    const s = new PatternStore();
    const p = { route: 0, stations: [1, 2], cities: [1, 2], arr: [0, 10], dep: [0, 10], headsign: "X", tz: 0, shapeTrip: -1 };
    expect(s.add({ ...p })).toBe(0);
    expect(s.add({ ...p, shapeTrip: 5 })).toBe(0);
    expect(s.patterns[0]!.shapeTrip).toBe(5);
    expect(s.add({ ...p, arr: [0, 11], dep: [0, 11] })).toBe(1);
  });
});

describe("localizeStart", () => {
  it("splits UTC trips by DST offset and shifts days", () => {
    const g = localizeStart(23 * 60, [0, 1, 2], (d) => (d < 2 ? 120 : 60));
    expect(g).toEqual([
      { start: 60, shift: 1, days: [0, 1] },
      { start: 0, shift: 1, days: [2] },
    ]);
  });
});

describe("cross-feed dedup", () => {
  const mk = (key: number, cities: number, days: number[], extra: Partial<DupTrip> = {}): DupTrip => {
    const mask = new Uint8Array(8);
    for (const d of days) mask[d >> 3]! |= 1 << (d & 7);
    return { key, cities, duration: 100, priority: 0, mask, ...extra };
  };
  it("keeps the longer version and merges calendars", () => {
    const trips = new Map([
      [1, mk(1, 5, [0, 1, 2])],
      [2, mk(2, 3, [2, 3])],
    ]);
    const { dropped, extraMask } = resolveDuplicates([{ a: 1, b: 2, shared: 3 }], trips);
    expect([...dropped]).toEqual([2]);
    expect(extraMask.get(1)![0]).toBe(0b1111);
  });
  it("does not merge trips on disjoint days or with different numbers", () => {
    const trips = new Map([
      [1, mk(1, 5, [0])],
      [2, mk(2, 3, [3])],
      [3, mk(3, 3, [0], { number: "ICE 123" })],
      [4, mk(4, 3, [0], { number: "ICE 125" })],
    ]);
    expect(resolveDuplicates([{ a: 1, b: 2, shared: 3 }, { a: 3, b: 4, shared: 3 }], trips).dropped.size).toBe(0);
  });
  it("maps every dropped trip to the trip that represents it, through chains", () => {
    const trips = new Map([
      [1, mk(1, 6, [0])],
      [2, mk(2, 4, [0])],
      [3, mk(3, 3, [0])],
    ]);
    // 2 absorbs 3 first (more shared cities), then 1 absorbs 2
    const { dropped, keptFor } = resolveDuplicates([{ a: 1, b: 2, shared: 2 }, { a: 2, b: 3, shared: 3 }], trips);
    expect([...dropped].sort()).toEqual([2, 3]);
    expect(keptFor.get(2)).toBe(1);
    expect(keptFor.get(3)).toBe(1);
    expect(keptFor.has(1)).toBe(false);
  });
});

describe("sliceShape", () => {
  it("slices between projected stops", () => {
    const pts: [number, number][] = Array.from({ length: 11 }, (_, i) => [10 + i * 0.01, 50]);
    const s = sliceShape(pts, [10.02, 50.001], [10.07, 50])!;
    expect(s[0]).toEqual([10.02, 50]);
    expect(s[s.length - 1]).toEqual([10.07, 50]);
    const r = sliceShape(pts, [10.07, 50], [10.02, 50])!;
    expect(r[0]).toEqual([10.07, 50]);
    expect(sliceShape(pts, [11, 51], [10.07, 50])).toBeNull();
  });
});

describe("repairTimes (zero-duration hops between distant stations)", () => {
  // Milano 08:00 -> Dijon 13:00 -> Paris GdL 15:00 -> Lyon 15:00 (bogus copy) -> Marseille 18:00
  const pos: [number, number][] = [[9.2, 45.5], [5.0, 47.3], [2.37, 48.84], [4.86, 45.76], [5.37, 43.3]];
  it("interpolates the bogus times by distance", () => {
    const arr = [480, 780, 900, 900, 1080], dep = [480, 785, 900, 900, 1080];
    const n = repairTimes(arr, dep, pos, Cat.LongDistance);
    expect(n).toBe(1);
    expect(arr[3]).toBeGreaterThan(900 + 60);
    expect(arr[3]).toBeLessThan(1080);
    expect(dep[3]).toBe(arr[3]);
    expect(arr[2]).toBe(900); // the first stop of the run keeps its time
  });
  it("leaves plausible times and short zero hops alone", () => {
    const arr = [480, 780, 900, 1010, 1080], dep = [480, 785, 905, 1010, 1080];
    expect(repairTimes(arr, dep, pos, Cat.LongDistance)).toBe(0);
    const a2 = [0, 0], d2 = [0, 0];
    expect(repairTimes(a2, d2, [[2.37, 48.84], [2.38, 48.85]], Cat.Regional)).toBe(0); // 1 km apart
  });
  it("extrapolates at a typical speed when the run reaches the end of the trip", () => {
    const arr = [600, 700, 700], dep = [600, 700, 700];
    expect(repairTimes(arr, dep, [[2.0, 48.0], [3.0, 48.0], [4.5, 48.0]], Cat.Regional)).toBe(1);
    expect(arr[2]).toBeGreaterThan(700);
  });
  it("is applied by processTripStops when positions are known", () => {
    const stationPos = (s: number) => pos[s]!;
    const t = processTripStops(
      pos.map((_, i) => ({ station: i, city: i, arr: [480, 780, 900, 900, 1080][i]!, dep: [480, 785, 900, 900, 1080][i]! })),
      { ...base, cat: Cat.LongDistance, stationPos },
    )!;
    expect(t.arr[3]! - t.dep[2]!).toBeGreaterThan(30);
  });
});

describe("stop restrictions (pickup / drop-off type 1)", () => {
  const { NoBoarding: NB, NoAlighting: NA } = StopLimit;
  it("keeps the restrictions of pattern stops, not the meaningless ones at the ends", () => {
    const t = processTripStops(
      [
        { station: 1, city: 1, arr: 0, dep: 0, pd: NA }, // first stop: no drop off (meaningless)
        { station: 2, city: 2, arr: 60, dep: 62, pd: NB },
        { station: 3, city: 3, arr: 120, dep: 122, pd: NA },
        { station: 4, city: 4, arr: 180, dep: 180, pd: NB }, // last stop: no pickup (meaningless)
      ],
      { ...base, cat: Cat.LongDistance },
    )!;
    expect(t.limits).toEqual([1, NB, 2, NA]);
    expect(processTripStops([{ station: 1, city: 1, arr: 0, dep: 0, pd: NA }, { station: 2, city: 2, arr: 9, dep: 9, pd: NB }], { ...base, cat: Cat.Regional })!.limits).toEqual([]);
  });
  it("a stop standing for several allows what one of them allows (through-run joint, small town)", () => {
    // a through run joined at station 2: the first piece ends there (no pickup), the second starts there (no drop off)
    const t = processTripStops(
      [
        { station: 1, city: 1, arr: 0, dep: 0 },
        { station: 2, city: 2, arr: 60, dep: 60, pd: NB },
        { station: 2, city: 2, arr: 65, dep: 65, pd: NA },
        { station: 3, city: 3, arr: 120, dep: 120 },
      ],
      { ...base, cat: Cat.Regional },
    )!;
    expect(t.stations).toEqual([1, 2, 3]);
    expect(t.limits).toEqual([]);
    // bus: two stops in a small town, one drop-off only, the other both: the town's stop allows both
    const b = processTripStops(
      [
        { station: 1, city: 1, arr: 0, dep: 0 },
        { station: 5, city: 2, arr: 20, dep: 20, pd: NB },
        { station: 6, city: 2, arr: 22, dep: 22 },
        { station: 7, city: 3, arr: 40, dep: 40 },
      ],
      { ...base, cat: Cat.Bus, cityPop: () => 5000 },
    )!;
    expect(b.stations).toEqual([1, 6, 7]);
    expect(b.limits).toEqual([]);
    const both = processTripStops(
      [
        { station: 1, city: 1, arr: 0, dep: 0 },
        { station: 5, city: 2, arr: 20, dep: 20, pd: NB },
        { station: 6, city: 2, arr: 22, dep: 22, pd: NB },
        { station: 7, city: 3, arr: 40, dep: 40 },
      ],
      { ...base, cat: Cat.Bus, cityPop: () => 5000 },
    )!;
    expect(both.limits).toEqual([1, NB]);
  });
  it("patterns that differ only in restrictions stay apart", () => {
    const s = new PatternStore();
    const p = { route: 0, stations: [1, 2, 3], cities: [1, 2, 3], arr: [0, 10, 20], dep: [0, 11, 20], headsign: "x", tz: 0, shapeTrip: -1 };
    expect(s.add({ ...p })).toBe(0);
    expect(s.add({ ...p, limits: [1, NB] })).toBe(1);
    expect(s.add({ ...p, limits: [1, NB] })).toBe(1);
  });
});
