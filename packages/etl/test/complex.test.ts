import { describe, expect, it } from "vitest";
import { Cat, cityComplexes, complexGeometry, convexHull, isLinkCandidate, isMember, type City, type Station } from "@etbm/shared";

const st = (id: number, lon: number, lat: number, cats: number = Cat.Regional, tpd = 50): Station => ({ id, city: 0, name: `S${id}`, lon, lat, cats, tpd });
const city = (stations: number[]): City => ({ id: 0, name: "X", country: "XX", lon: 0, lat: 0, population: 1, importance: 0.5, cats: 3, stations, tz: 0 });

describe("convexHull / complexGeometry", () => {
  it("drops interior and duplicate points", () => {
    const h = convexHull([[0, 0], [2, 0], [2, 2], [0, 2], [1, 1], [0, 0]]);
    expect(h).toHaveLength(4);
  });
  it("gives a line for two stations, a polygon for three, null for one", () => {
    expect(complexGeometry([[0, 0], [1, 0]])?.type).toBe("LineString");
    expect(complexGeometry([[0, 0], [1, 0], [0, 1]])?.type).toBe("Polygon");
    expect(complexGeometry([[0, 0]])).toBeNull();
    // collinear points degenerate to a line
    expect(complexGeometry([[0, 0], [1, 0], [2, 0]])?.type).toBe("LineString");
  });
});

describe("cityComplexes", () => {
  it("makes one complex of a compact city (Tipperary-like: 4 km apart)", () => {
    const stations = [st(0, -8.159, 52.4725, Cat.Bus, 22), st(1, -8.197, 52.5037, Cat.LongDistance | Cat.Regional), st(2, -8.162, 52.4701)];
    const cx = cityComplexes(city([0, 1, 2]), stations);
    expect(cx).toHaveLength(1);
    expect(cx[0]!.level).toBe(0);
    expect(cx[0]!.members).toEqual([0, 1, 2]);
  });
  it("ignores quiet bus stops and single stations", () => {
    const stations = [st(0, 0, 0, Cat.Regional), st(1, 0.001, 0, Cat.Bus, 3)];
    expect(isMember(stations[1]!, 1)).toBe(false);
    expect(cityComplexes(city([0, 1]), stations)).toHaveLength(0);
  });
  it("splits a sprawling city into small clusters instead of one blob", () => {
    // two pairs of stations ~300 m apart, 20 km from each other
    const stations = [st(0, 0, 50), st(1, 0.004, 50), st(2, 0.3, 50.05), st(3, 0.304, 50.05), st(4, 0.15, 50.2, Cat.LongDistance)];
    const cx = cityComplexes(city([0, 1, 2, 3, 4]), stations);
    expect(cx.map((c) => c.level)).toEqual([1, 1]);
    expect(cx.map((c) => c.members.sort())).toEqual([[0, 1], [2, 3]]);
    expect(cx.every((c) => c.zi >= 1)).toBe(true);
  });
});

describe("isLinkCandidate", () => {
  it("needs a hop between 150 m and 30 km", () => {
    expect(isLinkCandidate({ lon: 0, lat: 50 }, { lon: 0.0005, lat: 50 })).toBe(false); // 36 m
    expect(isLinkCandidate({ lon: 0, lat: 50 }, { lon: 0.06, lat: 50 })).toBe(true);
    expect(isLinkCandidate({ lon: 0, lat: 50 }, { lon: 1, lat: 50 })).toBe(false);
  });
});

import { complexFeatures, linkProps, type MapNet } from "@etbm/shared";

describe("complexFeatures / linkProps", () => {
  const stations = [st(0, 10, 50, Cat.LongDistance), st(1, 10.04, 50.02, Cat.Regional), st(2, 10.02, 50.0, Cat.Bus, 2)];
  const net: MapNet & { links: { id: number; city: number; a: number; b: number; cats: number; tpd: Record<number, number>; snapped: boolean; coords: [number, number][] }[] } = {
    cities: [city([0, 1, 2])],
    corridors: [],
    segments: [],
    stations,
    // the track between the two stations bows out to the south: the outline must cover it
    links: [{ id: 0, city: 0, a: 0, b: 1, cats: Cat.Regional, tpd: { 2: 12 }, snapped: true, coords: [[10, 50], [10.02, 49.99], [10.04, 50.02]] }],
  };
  it("outline covers the link geometry and skips quiet stops", () => {
    const f = complexFeatures(net);
    expect(f).toHaveLength(1);
    expect(f[0]!.properties).toMatchObject({ city: 0, lv: 0, zi: 1 });
    expect(JSON.stringify(f[0]!.geometry)).toContain("49.99");
  });
  it("link tile properties: dominant category, level of the later station", () => {
    expect(linkProps(net, net.links[0]!)).toMatchObject({ city: 0, c: Cat.Regional, zi: 1, u: 0 });
  });
});
