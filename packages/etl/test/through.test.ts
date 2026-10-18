import { describe, expect, it } from "vitest";
import { continues, findThroughRuns, type RunPiece } from "../src/core/through.ts";

const days = (...d: number[]) => {
  const m = new Uint8Array(2);
  for (const i of d) m[i >> 3]! |= 1 << (i & 7);
  return m;
};
const ALL = days(0, 1, 2, 3, 4, 5, 6);
const piece = (key: number, stations: number[], dep: number, arr: number, o: Partial<RunPiece> = {}): RunPiece => ({
  key, feed: 1, number: "17467", tz: "Europe/Paris", stations, dep, arr, mask: ALL, ...o,
});

describe("through runs", () => {
  it("joins pieces of one train continuing at the same station", () => {
    // Marseille (1) → Toulon (2) | Toulon → Les Arcs (3) | Les Arcs → Nice (4), 11–15 min at the junctions
    const r = findThroughRuns([piece(30, [3, 5, 4], 735, 800), piece(10, [1, 6, 2], 600, 660), piece(20, [2, 7, 3], 674, 720)]);
    expect(r.runs).toEqual([{ keys: [10, 20, 30], mask: ALL }]);
    expect(r.rest.size).toBe(0);
  });

  it("needs the same train number, feed and time zone and a short stop", () => {
    const a = piece(1, [1, 2], 600, 660);
    expect(continues(a, piece(2, [2, 3], 670, 700))).toBe(true);
    expect(continues(a, piece(2, [2, 3], 670, 700, { number: "17469" }))).toBe(false);
    expect(continues(a, piece(2, [2, 3], 670, 700, { number: "" }))).toBe(false);
    expect(continues(a, piece(2, [2, 3], 670, 700, { feed: 2 }))).toBe(false);
    expect(continues(a, piece(2, [2, 3], 670, 700, { tz: "Europe/Rome" }))).toBe(false);
    expect(continues(a, piece(2, [2, 3], 681, 700))).toBe(false); // 21 min
    expect(continues(a, piece(2, [2, 3], 655, 700))).toBe(false); // leaves before the arrival
    expect(continues(a, piece(2, [9, 3], 670, 700))).toBe(false); // starts elsewhere
  });

  it("does not join a turnback or a loop under the same number", () => {
    const a = piece(1, [1, 2, 3], 600, 660);
    expect(continues(a, piece(2, [3, 2, 1], 670, 730))).toBe(false);
    expect(continues(a, piece(2, [3, 4, 1], 670, 730))).toBe(false);
  });

  it("needs a common day", () => {
    expect(continues(piece(1, [1, 2], 600, 660, { mask: days(0) }), piece(2, [2, 3], 670, 700, { mask: days(1) }))).toBe(false);
  });

  it("leaves ambiguous continuations alone", () => {
    const r = findThroughRuns([piece(1, [1, 2], 600, 660), piece(2, [2, 3], 670, 700), piece(3, [2, 4], 665, 700)]);
    expect(r.runs).toEqual([]);
    const r2 = findThroughRuns([piece(1, [1, 2], 600, 660), piece(4, [5, 2], 600, 662), piece(2, [2, 3], 670, 700)]);
    expect(r2.runs).toEqual([]);
  });

  it("joins on the common days and keeps the other days of a piece as its own run", () => {
    const r = findThroughRuns([piece(1, [1, 2], 600, 660), piece(2, [2, 3], 670, 700, { mask: days(0, 1, 2, 3, 4) })]);
    expect(r.runs).toEqual([{ keys: [1, 2], mask: days(0, 1, 2, 3, 4) }]);
    expect([...r.rest.keys()]).toEqual([1]);
    expect(r.rest.get(1)).toEqual(days(5, 6));
  });

  it("ends the run where the next piece has no common day with the run so far", () => {
    const r = findThroughRuns([
      piece(1, [1, 2], 600, 660, { mask: days(0) }),
      piece(2, [2, 3], 670, 700, { mask: days(0, 1) }),
      piece(3, [3, 4], 705, 760, { mask: days(1) }),
    ]);
    expect(r.runs).toEqual([{ keys: [1, 2], mask: days(0) }]);
    expect(r.rest.get(2)).toEqual(days(1));
  });
});
