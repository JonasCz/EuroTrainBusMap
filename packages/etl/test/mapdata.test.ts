import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  Cat,
  LEVELS,
  buildNetIndex,
  cityProps,
  packCore,
  packGeo,
  packStationsFile,
  segmentProps,
  tileSet,
  unpackCore,
  unpackGeo,
  unpackStationsFile,
  type CoreFile,
  type MapNet,
  type NetworkFile,
} from "@etbm/shared";
import { levelIndex, mergeLines, TILE_MAXZOOM } from "@etbm/shared";
import { forZoom, tileProps, writeMapData } from "../src/mapdata.ts";

const net: NetworkFile = {
  schema: 1,
  build: "t",
  timezones: ["Europe/Berlin"],
  cities: [
    { id: 0, name: "Berlin", country: "DE", lon: 13.4105, lat: 52.5244, population: 3e6, importance: 0.9, cats: 3, stations: [0, 1], tz: 0, shard: 0 },
    { id: 1, name: "Potsdam", country: "DE", lon: 13.0657, lat: 52.3989, population: 2e5, importance: 0.5, cats: 2, stations: [2], tz: 0, shard: 0 },
    { id: 2, name: "Brandenburg", country: "DE", lon: 12.56, lat: 52.41, population: 7e4, importance: 0.4, cats: 3, stations: [3], tz: 0, shard: 0 },
  ],
  stations: [
    { id: 0, city: 0, name: "Berlin Hbf", lon: 13.36955, lat: 52.52508, cats: 3, tpd: 800 },
    { id: 1, city: 0, name: "Berlin Zoo", lon: 13.33295, lat: 52.50675, cats: 2 },
    { id: 2, city: 1, name: "Potsdam Hbf", lon: 13.06664, lat: 52.39176, cats: 2 },
    { id: 3, city: 2, name: "Brandenburg Hbf", lon: 12.5664, lat: 52.4006, cats: 3 },
  ],
  corridors: [
    { id: 0, a: 0, b: 1, coords: [], cats: Cat.Regional, tpd: { 2: 60 }, snapped: true, sa: 1, sb: 2, segs: [0, 1] },
    { id: 1, a: 1, b: 2, coords: [], cats: Cat.Regional, tpd: { 2: 40 }, snapped: true, sa: 2, sb: 3, segs: [2] },
    { id: 2, a: 0, b: 2, coords: [], cats: Cat.LongDistance, tpd: { 1: 10 }, snapped: true, sa: 0, sb: 3, segs: [0, 1, 2] },
  ],
  segments: [
    { id: 0, coords: [[13.4105, 52.5244], [13.37, 52.525], [13.33, 52.507]], cats: 3, tpd: { 1: 10, 2: 60 }, snapped: true },
    { id: 1, coords: [[13.33, 52.507], [13.2, 52.45], [13.0657, 52.3989]], cats: 3, tpd: { 1: 10, 2: 60 }, snapped: true },
    { id: 2, coords: [[13.0657, 52.3989], [12.8, 52.41], [12.56, 52.41]], cats: 3, tpd: { 1: 10, 2: 40 }, snapped: true },
  ],
};
const mnet: MapNet = { cities: net.cities, corridors: net.corridors, segments: net.segments!, stations: net.stations };

describe("map data (netmap)", () => {
  const idx = buildNetIndex(mnet);
  it("derives per-category tile properties from the corridors", () => {
    const p = segmentProps(mnet, idx, net.segments![0]!)!;
    expect(p.w1).toBeGreaterThan(0);
    expect(p.w2).toBeGreaterThan(p.w1!);
    expect(p.l1).toBe(0); // long distance ≥ 4 trips/day: overview
    expect(LEVELS[p.l2!]).toBeGreaterThan(0);
    // the express runs through the middle segment: it is not a lead-in
    expect(idx.segTerm[1]).toBe(0);
  });
  it("gives cities the earliest zoom of their lines per category", () => {
    const sp = net.segments!.map((s) => segmentProps(mnet, idx, s));
    const cp = cityProps(mnet, idx, sp);
    expect(cp[0]!.m1).toBe(0);
    expect(cp[1]!.m2).toBeDefined();
    expect(cp[2]!.tz).toBeGreaterThan(0);
  });
  it("round-trips core, stations and geo files", () => {
    const core = packCore({ schema: 1, build: "t", timezones: net.timezones, cityList: net.cities, nStations: 4, counts: { stations: 4, corridors: 3, segments: 3 }, tiles: { minzoom: 2, maxzoom: 7, tiles: { 2: [1, 2] }, url: "x" } });
    const cities = unpackCore(JSON.parse(JSON.stringify(core)) as CoreFile);
    expect(cities.map((c) => c.name)).toEqual(net.cities.map((c) => c.name));
    expect(cities[0]!.lon).toBeCloseTo(13.4105, 4);
    expect(cities[0]!.shard).toBe(0);
    expect(cities[1]!.stations).toEqual([2]);
    expect(tileSet(core.tiles).has("2/1/2")).toBe(true);
    const st = unpackStationsFile(cities, JSON.parse(JSON.stringify(packStationsFile(net.cities, net.stations))));
    expect(st.map((s) => s.name)).toEqual(net.stations.map((s) => s.name));
    expect(st[0]!.lat).toBeCloseTo(52.52508, 4);
    const g = unpackGeo(JSON.parse(JSON.stringify(packGeo(mnet, idx, [2, 0], [3, 0, 1]))), (sid) => net.cities[net.stations[sid]!.city]);
    expect(g.stations.map((s) => s.name)).toEqual(["Berlin Hbf", "Berlin Zoo", "Brandenburg Hbf"]);
    expect(g.stations[2]!.lon).toBeCloseTo(12.5664, 5);
    expect(g.stations[0]!.tpd).toBe(800);
    expect(g.stations[1]!.city).toBe(0);
    expect(g.corridors.map((c) => c.id)).toEqual([0, 2]);
    expect(g.corridors[1]!.segs).toEqual([0, 1, 2]);
    expect(g.corridors[0]!.tpd).toEqual({ 2: 60 });
    expect(g.cut.get(0)).toEqual([idx.cutA[0], idx.cutB[0]]);
    expect([...g.segments.keys()]).toEqual([0, 1, 2]);
    expect(g.segments.get(1)!.coords).toEqual(net.segments![1]!.coords);
  });
  it("merges equal neighbouring lines and coarsens properties by zoom", () => {
    const f = (x0: number, x1: number, p: Record<string, number>) => ({ type: "Feature" as const, properties: p, geometry: { type: "LineString" as const, coordinates: [[x0, 0], [x1, 0]] } });
    const merged = mergeLines([f(0, 1, { w1: 1 }), f(1, 2, { w1: 1 }), f(2, 3, { w1: 2 })]);
    expect(merged).toHaveLength(2);
    expect((merged[0]!.geometry as { coordinates: number[][] }).coordinates).toHaveLength(3);
    const p = tileProps({ sid: 4, k: 10, u: 0, term: 0, hop: 0, l1: 0, w1: 2.33, l2: 7, w2: 1.2 });
    expect(p.sid).toBeUndefined();
    expect(p.w1).toBe(2.25);
    const z2 = forZoom(f(0, 1, p), 2).properties as Record<string, number>;
    expect(z2.l1).toBe(0);
    expect(z2.w2).toBeUndefined(); // regional (level 6.5) not yet fading in (from 5.8) below zoom 4
    // a level that fades in before the next zoom is already in the tile (one tile zoom earlier), at its true level
    const z5 = forZoom(f(0, 1, p), 5).properties as Record<string, number>;
    expect(z5.l2).toBe(7);
    expect(z5.l1).toBe(levelIndex(5)); // finished fading in: clamped
  });
  it("writes tiles, core, stations and geo files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mapdata-"));
    try {
      await mkdir(join(dir, "shard"));
      const cf = { city: 0, routes: [], patterns: [{ route: 0, stations: [0, 3], arr: [0, 60], dep: [0, 60], corridors: [2], headsign: "x" }], patternTz: [0], trips: [], transfers: [], minTransfer: 3 };
      await writeFile(join(dir, "shard", "0.json"), JSON.stringify({ cities: { 0: cf } }));
      const r = await writeMapData(structuredClone(net), dir, () => undefined);
      expect(r.mapdata.tiles.maxzoom).toBe(TILE_MAXZOOM);
      const zm = r.mapdata.tiles.tiles[String(TILE_MAXZOOM)]!;
      expect(zm.length).toBeGreaterThan(0);
      const tile = gunzipSync(await readFile(join(dir, "tiles", String(TILE_MAXZOOM), String(zm[0]), `${zm[1]}.pbf.gz`)));
      expect(tile.length).toBeGreaterThan(100);
      const geo = unpackGeo(JSON.parse(await readFile(join(dir, "geo", "0.json"), "utf8")));
      expect(geo.corridors.map((c) => c.id)).toEqual([2]);
      expect(geo.stations.map((s) => s.id)).toEqual([0, 1, 3]);
      expect((await readdir(dir)).sort()).toEqual(["core.json", "geo", "shard", "tiles"]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
