import { describe, expect, it } from "vitest";
import { Cat, cityChunks, decodeTtChunk, decodeTtLines, type City, type CityFile, type TtIndex } from "@etbm/shared";
import { gunzipSync } from "node:zlib";
import { TransferCollector } from "../src/transfers.ts";

const city = (id: number, lon: number, stations: number[]): City => ({ id, name: `C${id}`, country: "XX", lon, lat: 50, population: 1000, importance: 0.5, cats: 15, stations, tz: 0 });
const cities = [city(0, 0, [0, 1]), city(1, 1, [2]), city(2, 2, [3])];
const routes = [
  { name: "IC", agency: "A", cat: Cat.LongDistance, flags: 0 },
  { name: "RB", agency: "A", cat: Cat.Regional, flags: 0 },
];
const ic = { route: 0, stations: [0, 2, 3], arr: [0, 30, 60], dep: [0, 31, 60], corridors: [10, 11], headsign: "C2" };
const rb = { route: 1, stations: [1, 2], arr: [0, 20], dep: [0, 20], corridors: [12], headsign: "C1" };
const cf = (c: number, patterns: CityFile["patterns"], trips: CityFile["trips"], transfers: CityFile["transfers"] = []): CityFile => ({
  city: c, routes, patterns, patternTz: patterns.map(() => 0), trips, transfers, minTransfer: 5,
});

describe("transfer timetable (ETL)", () => {
  it("deduplicates patterns and trips across city files and splits trunk / regions", async () => {
    const t = new TransferCollector();
    t.add(cf(0, [ic, rb], [[0, 480, 0, "1"], [1, 500, 0]], [[0, 1, 7], [1, 0, 7]]));
    t.add(cf(1, [rb, ic], [[1, 480, 0, "1"], [0, 500, 0], [0, 530, 1]]));
    expect(t.patterns).toBe(2);
    const files = new Map<string, Uint8Array | string>();
    const segs = [10, 11, 12].map((id) => ({ id, coords: [[0, 50], [1, 50.001], [2, 50]] as [number, number][], cats: 1, tpd: {}, snapped: true }));
    const segments = Object.assign([], { 10: segs[0], 11: segs[1], 12: segs[2] });
    const corridors = [
      { id: 10, a: 0, b: 2, segs: [10] },
      { id: 11, a: 2, b: 3, segs: [11] },
      { id: 12, a: 1, b: 2, segs: [-13] },
    ];
    const { index } = await t.write(cities, segments, corridors, async (rel, d) => void files.set(rel, d), () => undefined);
    const idx = JSON.parse(files.get("tt/index.json") as string) as TtIndex;
    expect(idx).toEqual(index);
    expect(cityChunks(idx).length).toBe(3);
    const trunk = decodeTtChunk(gunzipSync(files.get("tt/0.bin.gz") as Uint8Array));
    expect(Array.from(trunk.pCat)).toEqual([Cat.LongDistance]);
    expect(Array.from(trunk.trStart)).toEqual([480]); // the IC trip once
    const k = cityChunks(idx)[0]!;
    const region = decodeTtChunk(gunzipSync(files.get(`tt/${k}.bin.gz`) as Uint8Array));
    expect(Array.from(region.pCat)).toEqual([Cat.Regional]);
    expect(Array.from(region.trStart)).toEqual([500, 530]);
    expect(Array.from(region.trCal)).toEqual([0, 1]);
    expect(Array.from(region.walk)).toEqual([0, 1, 7]);
    const lines = decodeTtLines(gunzipSync(files.get(`tt/${k}.lines.gz`) as Uint8Array));
    expect(Array.from(lines.cId)).toEqual([12]);
    expect(Array.from(lines.cSegCodes)).toEqual([-13]);
  });
});
