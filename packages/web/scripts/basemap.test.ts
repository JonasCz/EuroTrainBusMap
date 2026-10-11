import { describe, expect, it } from "vitest";
import { clipLine, clipRing } from "./basemap.ts";

describe("basemap clipping", () => {
  const box: [number, number, number, number] = [0, 0, 10, 10];
  it("clips a ring to the box", () => {
    const r = clipRing(
      [
        [-5, 5],
        [5, -5],
        [15, 5],
        [5, 15],
        [-5, 5],
      ],
      box,
    );
    expect(r[0]).toEqual(r[r.length - 1]);
    for (const [x, y] of r) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(10);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(10);
    }
    expect(r.length).toBe(9); // octagon
  });
  it("drops rings outside", () => {
    expect(clipRing([[20, 20], [30, 20], [30, 30], [20, 20]], box)).toEqual([]);
  });
  it("splits lines leaving and re-entering", () => {
    const pieces = clipLine([[1, 1], [5, 20], [9, 1]], box);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]![0]).toEqual([1, 1]);
    expect(pieces[0]![1]![1]).toBeCloseTo(10);
    expect(pieces[1]![pieces[1]!.length - 1]).toEqual([9, 1]);
  });
});
