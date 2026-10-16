import { describe, expect, it } from "vitest";
import { Cat, type Corridor, type Station } from "@etbm/shared";
import type { GeoStore } from "../data/load.ts";
import { highlightData, pack } from "./features.ts";

// local A–B, B–C and an express A–C running over both segments
const seg = (x0: number, x1: number) => ({ coords: [[x0, 50], [(x0 + x1) / 2, 50.02], [x1, 50]] as [number, number][], snapped: true, hop: false });
const corr = (id: number, a: number, b: number, segs: number[], cats: number, tpd: Corridor["tpd"]): Corridor => ({ id, a, b, segs, cats, tpd, snapped: true, coords: [], sa: a, sb: b });
const geo: GeoStore = {
  stations: [],
  corridors: new Map([corr(0, 0, 1, [0], Cat.Regional, { 2: 40 }), corr(1, 1, 2, [1], Cat.Regional, { 2: 30 }), corr(2, 0, 2, [0, 1], Cat.LongDistance, { 1: 10 })].map((c) => [c.id, c])),
  cut: new Map([[0, [0, 0]], [1, [0, 0]], [2, [0, 1]]]),
  segments: new Map([[0, seg(10, 10.5)], [1, seg(10.5, 11)]]),
};
const stations: Station[] = [0, 1, 2].map((i) => ({ id: i, city: i, name: `S${i}`, lon: 10 + i * 0.5 + 0.01, lat: 50.001, cats: 3 }));

describe("selection highlight", () => {
  it("draws the selected corridors' segments with their traffic only", () => {
    const hl = highlightData(geo, stations, new Map([[2, Cat.LongDistance]]));
    const g0 = hl.lines.features.filter((x) => (x.properties as { g: number }).g !== 1);
    // both segments carry the same line: merged into one feature from 10° to 11°
    expect(g0).toHaveLength(1);
    expect((g0[0]!.properties as { cat: number }).cat).toBe(Cat.LongDistance);
    const co = (g0[0]!.geometry as { coordinates: number[][] }).coordinates;
    expect([co[0]![0], co[co.length - 1]![0]]).toEqual([10, 11]);
  });
  it("bundles categories side by side and draws end pieces to the stations", () => {
    const hl = highlightData(geo, stations, new Map([[0, Cat.Regional], [2, Cat.LongDistance]]));
    const s0 = hl.lines.features.filter((x) => (x.properties as { g: number }).g !== 1 && (x.geometry as { coordinates: number[][] }).coordinates[0]![0] === 10);
    const offs = s0.map((x) => (x.properties as { o: number }).o);
    expect(offs).toHaveLength(2);
    expect(Math.sign(offs[0]!)).toBe(-Math.sign(offs[1]!));
    const g1 = hl.lines.features.filter((x) => (x.properties as { g: number }).g === 1);
    expect(g1.some((x) => (x.geometry as { coordinates: number[][] }).coordinates[0]![0] === stations[0]!.lon)).toBe(true);
  });
  it("packs bundles symmetrically", () => {
    const p = pack([2, 2]);
    expect(p.offsets[0]).toBe(-p.offsets[1]!);
    expect(p.total).toBeCloseTo(4.3);
  });
});
