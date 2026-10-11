import { describe, expect, it } from "vitest";
import { Cat } from "@etbm/shared";
import { PatternStore, localizeStart, processTripStops } from "../src/core/patterns.ts";
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
