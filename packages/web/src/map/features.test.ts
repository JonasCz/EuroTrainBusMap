import { describe, expect, it } from "vitest";
import { Cat, type City, type Segment } from "@etbm/shared";
import type { CorridorExt } from "../data/net.ts";
import { baseCorridorData, buildNetIndex, highlightData, netSegments, terminalGeometry, type MapNet } from "./features.ts";

const city = (id: number, lon: number): City => ({ id, name: `C${id}`, country: "DE", lon, lat: 50, population: 1e5, importance: 0.9, cats: 3, stations: [id], tz: 0 });
const cities = [city(0, 10), city(1, 10.5), city(2, 11)];
const stations = cities.map((c) => ({ id: c.id, city: c.id, name: c.name, lon: c.lon + 0.01, lat: 50.001, cats: 3 }));
const seg = (id: number, x0: number, x1: number, tpd: Segment["tpd"], cats: number): Segment => ({ id, coords: [[x0, 50], [(x0 + x1) / 2, 50.02], [x1, 50]], cats, tpd, snapped: true });
// local A–B, B–C and an express A–C running over both segments
const segments = [seg(0, 10, 10.5, { 1: 10, 2: 40 }, 3), seg(1, 10.5, 11, { 1: 10, 2: 30 }, 3)];
const corr = (id: number, a: number, b: number, segs: number[], cats: number, tpd: CorridorExt["tpd"]): CorridorExt => ({
  id, a, b, segs, cats, tpd, snapped: true, coords: [[cities[a]!.lon, 50], [cities[b]!.lon, 50]], sa: a, sb: b,
});
const corridors = [corr(0, 0, 1, [0], Cat.Regional, { 2: 40 }), corr(1, 1, 2, [1], Cat.Regional, { 2: 30 }), corr(2, 0, 2, [0, 1], Cat.LongDistance, { 1: 10 })];
const net: MapNet = { cities, corridors, segments, hasDtCats: false, file: { stations } };
const idx = buildNetIndex(net);
const f = { cats: 15, dticket: false };

describe("segment-based network", () => {
  it("draws each segment once with all its categories (no duplicate express line)", () => {
    const bd = baseCorridorData(net, idx, f);
    const lines = bd.lines.features.map((x) => x.properties as Record<string, number>);
    expect(lines).toHaveLength(4); // 2 segments × (LD + regional)
    expect(new Set(lines.map((l) => `${l.sid}:${l.cat}`)).size).toBe(4);
    expect(bd.casing.features).toHaveLength(2);
    // the two lines of a bundle sit side by side (opposite sides of the centre line)
    const s0 = lines.filter((l) => l.sid === 0).map((l) => l.o!);
    expect(Math.sign(s0[0]!)).toBe(-Math.sign(s0[1]!));
    expect(Number.isFinite(bd.cityMinZoom[1]!)).toBe(true);
  });
  it("highlights the segments of the selected corridors with their traffic only", () => {
    const hl = highlightData(net, idx, new Map([[2, Cat.LongDistance]]));
    const g0 = hl.lines.features.filter((x) => (x.properties as { g: number }).g === 0);
    expect(g0.map((x) => (x.properties as { sid: number }).sid).sort()).toEqual([0, 1]);
    expect(g0.every((x) => (x.properties as { k: number }).k === 10)).toBe(true);
  });
  it("cuts terminal segments at the station", () => {
    const t = terminalGeometry(net, idx, corridors[0]!, "a")!;
    expect(t.sid).toBe(0);
    // single-segment corridor: one piece from station a to station b
    expect(t.coords[0]).toEqual([stations[0]!.lon, stations[0]!.lat]);
    expect(t.coords[t.coords.length - 1]).toEqual([stations[1]!.lon, stations[1]!.lat]);
    expect(terminalGeometry(net, idx, corridors[0]!, "b")).toBeNull();
  });
  it("synthesises one segment per corridor for data without a line graph", () => {
    const cs = [corr(0, 0, 1, [], Cat.Regional, { 2: 1 })];
    delete cs[0]!.segs;
    const s = netSegments({ corridors: cs });
    expect(s).toHaveLength(1);
    expect(cs[0]!.segs).toEqual([0]);
  });
});
