import { describe, expect, it } from "vitest";
import { buildSegments, corridorCoords, type SegInput } from "../src/core/segments.ts";

const P = (x: number, y = 50): [number, number] => [10 + x * 0.01, y];
const inp = (coords: [number, number][], tpd: Record<number, number>, extra: Partial<SegInput> = {}): SegInput => ({
  coords, cats: Object.keys(tpd).reduce((a, k) => a | +k, 0), tpd, snapped: true, tol: 1, ...extra,
});

describe("buildSegments", () => {
  it("merges an express A–C into the local A–B + B–C track", () => {
    const A = P(0), m1 = P(5), B = P(10), m2 = P(15), C = P(20);
    const r = buildSegments([inp([A, m1, B], { 2: 10 }), inp([B, m2, C], { 2: 8 }), inp([A, m1, B, m2, C], { 1: 3 })]);
    expect(r.segments).toHaveLength(2);
    const ab = r.segments.find((s) => s.users.includes(0))!;
    const bc = r.segments.find((s) => s.users.includes(1))!;
    expect(ab.users).toEqual([0, 2]);
    expect(bc.users).toEqual([1, 2]);
    expect(ab.tpd).toEqual({ 1: 3, 2: 10 });
    expect(ab.cats).toBe(3);
    // corridor lists reconstruct the geometry (straight line → simplified to endpoints)
    for (const [c, ends] of [[0, [A, B]], [1, [B, C]], [2, [A, C]]] as const) {
      const co = corridorCoords(r.corrSegs[c]!, r.segments);
      expect(co[0]).toEqual(ends[0]);
      expect(co[co.length - 1]).toEqual(ends[1]);
    }
    expect(r.corrSegs[2]).toHaveLength(2);
  });

  it("handles opposite travel directions and branches", () => {
    const A = P(0), B = P(10), C = P(20), D = P(20, 50.1);
    // B–A runs backwards over A–B; A–D branches off at B
    const r = buildSegments([inp([A, P(5), B, P(15), C], { 1: 1 }), inp([B, P(5), A], { 2: 4 }), inp([A, P(5), B, [10.15, 50.05], D], { 4: 2 })]);
    // A..B shared by all three; B..C and B..D separate
    expect(r.segments).toHaveLength(3);
    const ab = r.segments.find((s) => s.users.length === 3)!;
    expect(ab.tpd).toEqual({ 1: 1, 2: 4, 4: 2 });
    const back = corridorCoords(r.corrSegs[1]!, r.segments);
    expect(back[0]).toEqual(B);
    expect(back[back.length - 1]).toEqual(A);
    const ad = corridorCoords(r.corrSegs[2]!, r.segments);
    expect(ad[ad.length - 1]).toEqual(D);
  });

  it("snaps nearly identical vertices and keeps unrelated lines apart", () => {
    const a = [P(0), P(5), P(10)] as [number, number][];
    const b = a.map(([x, y]) => [x + 0.00005, y + 0.00005] as [number, number]); // ~5 m off
    const far = a.map(([x, y]) => [x, y + 0.05] as [number, number]);
    const r = buildSegments([inp(a, { 2: 1 }), inp(b, { 2: 1 }), inp(far, { 2: 1 })]);
    expect(r.segments).toHaveLength(2);
  });
});

describe("parallel tracks", () => {
  it("merges two tracks between the same junctions", () => {
    const A = P(0), B = P(10);
    const t1 = [A, P(3), P(6), B] as [number, number][];
    const t2 = [A, [10.04, 50.0003], [10.07, 50.0003], B] as [number, number][]; // ~30 m beside
    const r = buildSegments([inp(t1, { 1: 5 }), inp(t2, { 2: 7 })]);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.tpd).toEqual({ 1: 5, 2: 7 });
  });
});
