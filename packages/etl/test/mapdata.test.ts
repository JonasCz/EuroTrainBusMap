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
import { CAT_BITS, cityMinZoom, levelIndex, mergeLines, packScenario, scenarioDigit, scenarioMask, segmentMinZoom, SCEN_DIGITS, TILE_MAXZOOM, unpackScenario, TT_VERSION, type TtIndex } from "@etbm/shared";
import { forZoom, tileProps, writeMapData } from "../src/mapdata.ts";

const net: NetworkFile = {
  schema: 3,
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
    { id: 0, a: 1, b: 2, coords: [], cats: Cat.Regional, tpd: { 2: 60 }, snapped: true, segs: [0, 1] },
    { id: 1, a: 2, b: 3, coords: [], cats: Cat.Regional, tpd: { 2: 40 }, snapped: true, segs: [2] },
    { id: 2, a: 0, b: 3, coords: [], cats: Cat.LongDistance, tpd: { 1: 10 }, snapped: true, segs: [0, 1, 2] },
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
    expect(p.term).toBeUndefined(); // corridors end at their own stations: no lead-in pieces any more
  });
  it("gives cities the earliest zoom of their lines per category", () => {
    const sp = net.segments!.map((s) => segmentProps(mnet, idx, s));
    const cp = cityProps(mnet, idx, sp);
    expect(cp[0]!.m1).toBe(0);
    expect(cp[1]!.m2).toBeDefined();
    expect(cp[2]!.tz).toBeGreaterThan(0);
  });
  it("round-trips core, stations and geo files", () => {
    const core = packCore({ schema: 3, build: "t", timezones: net.timezones, cityList: net.cities, nStations: 4, counts: { stations: 4, corridors: 3, segments: 3 }, tiles: { minzoom: 2, maxzoom: 7, tiles: { 2: [1, 2] }, url: "x" } });
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
    expect([...g.segments.keys()]).toEqual([0, 1, 2]);
    expect(g.segments.get(1)!.coords).toEqual(net.segments![1]!.coords);
  });
  it("merges equal neighbouring lines and coarsens properties by zoom", () => {
    const f = (x0: number, x1: number, p: Record<string, number>) => ({ type: "Feature" as const, properties: p, geometry: { type: "LineString" as const, coordinates: [[x0, 0], [x1, 0]] } });
    const merged = mergeLines([f(0, 1, { w1: 1 }), f(1, 2, { w1: 1 }), f(2, 3, { w1: 2 })]);
    expect(merged).toHaveLength(2);
    expect((merged[0]!.geometry as { coordinates: number[][] }).coordinates).toHaveLength(3);
    const p = tileProps({ sid: 4, k: 10, u: 0, hop: 0, l1: 0, w1: 2.33, l2: 7, w2: 1.2 });
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
  it("packs per mode-scenario levels", () => {
    for (let ki = 0; ki < CAT_BITS.length; ki++)
      for (let d = 0; d <= SCEN_DIGITS; d++) {
        const m = scenarioMask(ki, d);
        expect(m & (1 << ki)).toBeTruthy();
        expect(scenarioDigit(ki, m)).toBe(d);
      }
    // all categories on = the plain level
    expect(scenarioDigit(1, 15)).toBe(SCEN_DIGITS);
    // coach alone (Cat bits = masks over CAT_BITS indices)
    expect(scenarioDigit(CAT_BITS.indexOf(Cat.Coach), Cat.Coach)).toBe(0);
    const ds = [1, 2, 3, 4, 5, 6, 12];
    expect(unpackScenario(packScenario(ds))).toEqual(ds);
  });
  it("stores levels with other modes hidden where they differ", () => {
    // regional alone may appear earlier than beside the long-distance line on the same track
    const d = buildNetIndex(mnet, { density: { budget: 300 } });
    expect(d.segLevelBy?.size).toBe(14);
    const p = segmentProps(mnet, d, net.segments![0]!)!;
    const ri = CAT_BITS.indexOf(Cat.Regional);
    const alone = p.s2 !== undefined ? unpackScenario(p.s2)[scenarioDigit(ri, Cat.Regional)]! : p.l2!;
    expect(alone).toBeLessThanOrEqual(p.l2!);
    expect(segmentMinZoom(p)).toBe(0);
    // hand-made: regional alone at level 2, with others at 8
    const q = { l2: 8, w2: 1, s2: packScenario([2, 8, 8, 8, 8, 8, 8]), u: 0 };
    expect(segmentMinZoom(q)).toBe(LEVELS[2]);
    expect(cityMinZoom({ tz: 0, m2: LEVELS[8]!, n2: packScenario([2, 8, 8, 8, 8, 8, 8]) })).toBe(LEVELS[2]);
    expect(cityMinZoom({ tz: 5, m2: LEVELS[8]! })).toBe(LEVELS[8]);
  });
  it("keeps a category in low-zoom tiles when a mode scenario shows it there", () => {
    const f = (p: Record<string, number>) => ({ type: "Feature" as const, properties: p, geometry: { type: "LineString" as const, coordinates: [[0, 0], [1, 0]] } });
    // regional: level 10 (z8) with everything on, level 2 (z4) alone
    const p = { u: 0, l2: 10, w2: 1, s2: packScenario([2, 10, 10, 10, 10, 10, 10]) };
    const z3 = forZoom(f(p), 3).properties as Record<string, number>;
    const hi = levelIndex(3 + 1 + 0.7 - 0.001);
    expect(z3.l2).toBe(hi + 1); // not before z4 + fade with all modes: "later"
    expect(unpackScenario(z3.s2!)).toEqual([2, hi + 1, hi + 1, hi + 1, hi + 1, hi + 1, hi + 1]);
    // from z8 on every scenario has it: the packed value collapses into l2
    const z8 = forZoom(f(p), 8).properties as Record<string, number>;
    expect(z8.s2).toBeUndefined();
    expect(z8.l2).toBe(levelIndex(8));
    // the every-mode-on tiles leave it out until it shows with every mode on
    expect((forZoom(f(p), 3, false).properties as Record<string, number>).w2).toBeUndefined();
    expect((forZoom(f(p), 7, false).properties as Record<string, number>).s2).toBeUndefined();
    // nowhere before z5.7: not in the z2 tile
    expect((forZoom(f({ u: 0, l2: 10, w2: 1, s2: packScenario([6, 10, 10, 10, 10, 10, 10]) }), 2).properties as Record<string, number>).w2).toBeUndefined();
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
      expect(tile.length).toBeGreaterThan(50);
      const geo = unpackGeo(JSON.parse(await readFile(join(dir, "geo", "0.json"), "utf8")));
      expect(geo.corridors.map((c) => c.id)).toEqual([2]);
      expect(geo.stations.map((s) => s.id)).toEqual([0, 1, 3]);
      expect((await readdir(dir)).sort()).toEqual(["core.json", "geo", "shard", "tiles", "tiles-m", "tt"]);
      // transfer timetable: index + trunk and region chunks with their line files
      expect(r.transfers).toEqual({ version: TT_VERSION, index: "tt/index.json" });
      const tt = JSON.parse(await readFile(join(dir, "tt", "index.json"), "utf8")) as TtIndex;
      expect(tt.chunks[0]!.file).toBe("tt/0.bin.gz");
      expect((await readdir(join(dir, "tt"))).length).toBe(1 + 2 * tt.chunks.length);
      // mode-filter tiles up to their max zoom, beyond it the plain tiles serve every filter
      const modes = r.mapdata.tiles.modes!;
      expect(modes.url).toBe("tiles-m/{z}/{x}/{y}.pbf.gz");
      expect(Object.keys(modes.tiles).map(Number).every((z) => z <= modes.maxzoom)).toBe(true);
      expect(modes.tiles["2"]!.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
