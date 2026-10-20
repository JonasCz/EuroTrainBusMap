import { describe, expect, it } from "vitest";
import { buildUrban } from "../src/urban/model.ts";
import { buildRegion, lineOwner, MemorySpill, partitionFeed, regionOf, regionsOfBox, spillFeed, tileInRegion, worldX } from "../src/urban/regions.ts";
import { BUS_TILE, cutAllTiles, cutRegionTiles, routeFeatures, type RegionFeatures } from "../src/urban/tiles.ts";
import { URBAN_LAYERS } from "@etbm/shared";
import type { LonLat, UrbanFeed, UrbanLine, UrbanStop } from "../src/urban/types.ts";

// small regions (z8, ~100 km across) and a 20 km halo, so the synthetic lines cross seams
const RZ = 8, HALO = 20;
/** the seam between regions x = 134 and x = 135 at z8 */
const SEAM = (135 / 256) * 360 - 180; // 9.84375°
const LAT = 50.2;

function mkFeed(key: string, stops: UrbanStop[], lines: { name: string; ids: number[]; tpd: number; mode?: 0 | 1 }[]): UrbanFeed {
  const ls: UrbanLine[] = lines.map((l) => ({
    mode: l.mode ?? 0, name: l.name, desc: "", agency: "Op", color: "", tpd: l.tpd,
    patterns: [{ coords: l.ids.map((i) => [stops[i]!.lon, stops[i]!.lat] as LonLat), stops: l.ids, trips: l.tpd, geom: "shape" as const }],
  }));
  return { key, version: 1, stops, lines: ls, stats: { routes: ls.length, kept: ls.length, shaped: ls.length, dropped: {} } };
}
const st = (id: string, name: string, lon: number, lat = LAT): UrbanStop => ({ id, name, lon, lat, parent: "" });

function feeds(): UrbanFeed[] {
  // feed 1: line A crossing the seam (and on to a second stop on the seam), line B east of the seam, a far west line
  const f1 = mkFeed(
    "f1",
    [st("w2", "West Two", SEAM - 0.06), st("w1", "West One", SEAM - 0.02), st("s", "Seam Square", SEAM - 0.00005), st("e1", "East One", SEAM + 0.02), st("e2", "East Two", SEAM + 0.05), st("b1", "Bee Start", SEAM + 0.008, LAT + 0.01), st("b2", "Bee End", SEAM + 0.04, LAT + 0.01), st("x1", "Far West", SEAM - 0.5), st("x2", "Far West 2", SEAM - 0.47)],
    [
      { name: "A", ids: [0, 1, 2, 3, 4], tpd: 60 },
      { name: "B", ids: [5, 6], tpd: 30 },
      { name: "W", ids: [7, 8], tpd: 10 },
    ],
  );
  // feed 2: line A the other way (a duplicate), the seam stop on the other side of the seam (one station), and a longer
  // copy of B that starts west of the seam: its centre is in the west region, B's in the east; only the longer is drawn
  const f2 = mkFeed(
    "f2",
    [st("e2", "East Two", SEAM + 0.05), st("e1", "East One", SEAM + 0.02), st("s", "Seam Square", SEAM + 0.00005), st("w1", "West One", SEAM - 0.02), st("b0", "Bee West", SEAM - 0.05, LAT + 0.01), st("b2", "Bee End", SEAM + 0.04, LAT + 0.01)],
    [
      { name: "A", ids: [0, 1, 2, 3], tpd: 60 },
      { name: "B", ids: [4, 5], tpd: 30 },
    ],
  );
  return [f1, f2];
}

async function regional(fs: UrbanFeed[]) {
  const spill = new MemorySpill();
  for (let i = 0; i < fs.length; i++) await spillFeed(spill, i, structuredClone(fs[i]!), HALO, RZ);
  const regions = (await spill.groups("in")).map((g) => g.slice(3));
  const lines = [], stations = [];
  for (const rk of regions) {
    const out = await buildRegion(spill, rk, [], undefined, RZ);
    lines.push(...out.lines);
    stations.push(...out.stations);
    for (const [dest, f] of routeFeatures(out, RZ)) await spill.put(`out/${dest}`, rk, f);
  }
  return { regions, lines, stations, spill };
}

const lineKey = (l: { name: string; coords: LonLat[]; lz: number }) => `${l.name}|${JSON.stringify(l.coords)}|${l.lz}`;
const stKey = (s: { name: string; lon: number; lat: number; z: number; lines: string[] }) => `${s.name}|${s.lon.toFixed(6)}|${s.lat.toFixed(6)}|${s.z}|${s.lines.join(",")}`;

describe("regions", () => {
  it("puts a point in one region and a box in every region its halo touches", () => {
    expect(regionOf(SEAM - 1e-6, LAT, RZ)).not.toBe(regionOf(SEAM + 1e-6, LAT, RZ));
    expect(worldX(SEAM) * 256).toBeCloseTo(135, 9);
    const r = regionsOfBox({ minLon: SEAM + 0.1, minLat: LAT, maxLon: SEAM + 0.1, maxLat: LAT }, HALO, RZ);
    expect(r).toContain(regionOf(SEAM - 0.01, LAT, RZ)); // 7 km from the seam: also in the west region's halo
    expect(regionsOfBox({ minLon: SEAM + 0.5, minLat: LAT, maxLon: SEAM + 0.5, maxLat: LAT }, HALO, RZ)).not.toContain(regionOf(SEAM - 0.01, LAT, RZ));
    expect(tileInRegion(11, 135 * 8, 0, `135-0`, RZ)).toBe(true);
    expect(tileInRegion(11, 135 * 8 - 1, 0, `135-0`, RZ)).toBe(false);
  });

  it("gives a line crossing the seam to both regions, whole, with its stops", () => {
    const parts = partitionFeed(feeds()[0]!, HALO, RZ);
    const west = regionOf(SEAM - 0.01, LAT, RZ), east = regionOf(SEAM + 0.01, LAT, RZ);
    for (const rk of [west, east]) {
      const a = parts.get(rk)!.lines.find((l) => l.name === "A")!;
      expect(a.patterns[0]!.stops.map((i) => parts.get(rk)!.stops[i]!.name)).toEqual(["West Two", "West One", "Seam Square", "East One", "East Two"]);
    }
    // the far west line is not in the east region (more than the halo away)
    expect(parts.get(east)!.lines.some((l) => l.name === "W")).toBe(false);
    expect(parts.get(east)!.stops.some((s) => s.name === "Far West")).toBe(false);
  });

  it("builds the same lines and stations as one global build: no seam duplicates, nothing cut or dropped", async () => {
    const global = buildUrban(feeds());
    const r = await regional(feeds());
    expect(r.regions.length).toBeGreaterThanOrEqual(2);
    expect(r.lines.map(lineKey).sort()).toEqual(global.lines.map(lineKey).sort());
    expect(r.stations.map(stKey).sort()).toEqual(global.stations.map(stKey).sort());
    // one A (the other direction is a duplicate), one B (the longer copy), the seam stop is one station
    expect(r.lines.filter((l) => l.name === "A")).toHaveLength(1);
    expect(r.lines.filter((l) => l.name === "B")).toHaveLength(1);
    expect(r.lines.find((l) => l.name === "B")!.coords[0]![0]).toBeCloseTo(SEAM - 0.05);
    expect(lineOwner(r.lines.find((l) => l.name === "B")!, RZ)).toBe(regionOf(SEAM - 0.01, LAT, RZ)); // the copy owned by the east region was dropped there too
    expect(r.stations.filter((s) => s.name === "Seam Square")).toHaveLength(1);
    expect(r.stations.find((s) => s.name === "Seam Square")!.lines.sort()).toEqual(["A"]);
    // the A line is owned by one region, its full length
    const a = r.lines.find((l) => l.name === "A")!;
    expect(a.coords).toHaveLength(5);
    expect(lineOwner(a, RZ)).toBe(regionOf(SEAM - 0.01, LAT, RZ)); // centre of its box just west of the seam
  });

  it("tiles at the seam hold the features of both sides, each once", async () => {
    const r = await regional(feeds());
    const tiles: Record<string, { name: string; layer: string }[]> = {};
    for (const g of await r.spill.groups("out")) {
      const region = g.slice(4);
      const f: RegionFeatures = { rail: { lines: [], stops: [] }, bus: { lines: [], stops: [] } };
      for (const n of await r.spill.names(g)) {
        const p = await r.spill.get<RegionFeatures>(g, n);
        f.bus.lines.push(...p.bus.lines);
        f.bus.stops.push(...p.bus.stops);
      }
      for (const t of cutRegionTiles(region, BUS_TILE, f.bus, RZ)) {
        const k = `${t.x}/${t.y}`;
        expect(tiles[k]).toBeUndefined(); // every tile comes from one region
        tiles[k] = Object.entries(t.layers).flatMap(([layer, l]) => (l.features as { tags: { n: string } }[]).map((x) => ({ name: x.tags.n, layer })));
      }
    }
    const xw = 135 * 8 - 1, xe = 135 * 8; // the z11 columns either side of the seam
    const yOf = Object.keys(tiles).map((k) => k.split("/").map(Number)).find(([x]) => x === xe)![1];
    const west = tiles[`${xw}/${yOf}`]!, east = tiles[`${xe}/${yOf}`]!;
    for (const t of [west, east]) {
      expect(t.filter((f) => f.layer === URBAN_LAYERS.line && f.name === "A")).toHaveLength(1);
      expect(t.filter((f) => f.layer === URBAN_LAYERS.line && f.name === "B")).toHaveLength(1);
      // the seam station sits in the buffer of both tiles
      expect(t.filter((f) => f.layer === URBAN_LAYERS.stop && f.name === "Seam Square")).toHaveLength(1);
    }
    expect(west.some((f) => f.name === "West One")).toBe(true);
    expect(east.some((f) => f.name === "East One")).toBe(true);
    // encoded the same way
    const all = await cutAllTiles(r.spill, RZ);
    expect(all.bus.length).toBe(Object.keys(tiles).length);
  });
});
