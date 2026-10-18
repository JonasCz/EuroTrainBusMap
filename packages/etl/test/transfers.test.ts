import { describe, expect, it } from "vitest";
import { Cat, StopLimit, cityChunks, decodeTtChunk, decodeTtLines, endpointsName, routeBrand, type City, type CityFile, type TtIndex } from "@etbm/shared";
import { gunzipSync } from "node:zlib";
import { TransferCollector } from "../src/transfers.ts";

const city = (id: number, lon: number, stations: number[]): City => ({ id, name: `C${id}`, country: "XX", lon, lat: 50, population: 1000, importance: 0.5, cats: 15, stations, tz: 0 });
const cities = [city(0, 0, [0, 1]), city(1, 1, [2]), city(2, 2, [3])];
const routes = [
  { name: "IC", agency: "A", cat: Cat.LongDistance, flags: 0 },
  { name: "RB 21", agency: "A", cat: Cat.Regional, flags: 0 },
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
    // brands: the route names without line numbers, per pattern
    expect(idx.brands).toEqual(["IC", "RB"]);
    expect(Array.from(trunk.pBrand)).toEqual([0]);
    expect(Array.from(region.pBrand)).toEqual([1]);
    const lines = decodeTtLines(gunzipSync(files.get(`tt/${k}.lines.gz`) as Uint8Array));
    expect(Array.from(lines.cId)).toEqual([12]);
    expect(Array.from(lines.cSegCodes)).toEqual([-13]);
  });
});

describe("transfer timetable restrictions", () => {
  it("keeps the restrictions per pattern and boards regional patterns only in cities where boarding is allowed", async () => {
    const t = new TransferCollector();
    // RB 1 → 2 (city 0 → 1) with no boarding at station 1: city 0 has no boarding stop
    const rbNo = { ...rb, limits: [0, StopLimit.NoBoarding] };
    t.add(cf(0, [ic, rb, rbNo], [[0, 480, 0], [1, 500, 0], [2, 520, 0]]));
    expect(t.patterns).toBe(3); // rb and rbNo stay apart
    const files = new Map<string, Uint8Array | string>();
    const corridors = [{ id: 10, a: 0, b: 2 }, { id: 11, a: 2, b: 3 }, { id: 12, a: 1, b: 2 }];
    await t.write(cities, [], corridors, async (rel, d) => void files.set(rel, d), () => undefined);
    const idx = JSON.parse(files.get("tt/index.json") as string) as TtIndex;
    const k = cityChunks(idx)[0]!;
    const region = decodeTtChunk(gunzipSync(files.get(`tt/${k}.bin.gz`) as Uint8Array));
    expect(Array.from(region.trStart)).toEqual([500]); // only the RB that boards in city 0
    expect(Array.from(region.stLimit)).toEqual([0, 0]);
  });
});

describe("routeBrand", () => {
  it("drops line and train numbers, a bare line code gives the agency", () => {
    expect(routeBrand("TGV INOUI")).toBe("TGV INOUI");
    expect(routeBrand("FlixBus N1138")).toBe("FlixBus");
    expect(routeBrand("RE 7")).toBe("RE");
    expect(routeBrand("EC 35")).toBe("EC");
    expect(routeBrand("IC 850 TÓPART")).toBe("IC");
    expect(routeBrand("ALSA - Irun-Tuy")).toBe("ALSA");
    expect(routeBrand("S-Bahn S3")).toBe("S-Bahn");
    expect(routeBrand("Marseille-St-Charles/Paris-Gare-de-Lyon")).toBe("Marseille-St-Charles/Paris-Gare-de-Lyon");
    expect(routeBrand("Intercités de Nuit")).toBe("Intercités de Nuit");
    expect(routeBrand("S1", "S-Bahn Berlin")).toBe("S-Bahn Berlin");
    expect(routeBrand("7", "Stagecoach")).toBe("Stagecoach");
    expect(routeBrand("QIWI", "RER", Cat.Regional)).toBe("RER");
    expect(routeBrand("AVLO", "Renfe", Cat.LongDistance)).toBe("AVLO");
  });
  it("gives the operator (or its brand) for a route named only by where it runs", () => {
    expect(routeBrand("Paris-Gare-de-Lyon/Marseille-St-Charles", "Trenitalia", Cat.LongDistance)).toBe("Frecciarossa");
    expect(routeBrand("Milano Centrale/Paris-Gare-de-Lyon", "Trenitalia France", Cat.LongDistance)).toBe("Frecciarossa");
    expect(routeBrand("Belfast Great Central - Portrush", "Translink Northern Ireland Rail", Cat.Regional)).toBe("Translink Northern Ireland Rail");
    expect(routeBrand("ANKARA GAR - KARS (ANAHAT)", "TCDD Taşımacılık A.Ş.", Cat.LongDistance)).toBe("TCDD Taşımacılık A.Ş.");
    // a brand before the route description stays; names with numbers are not "where it runs"
    expect(routeBrand("ALSA - Irun-Tuy", "ALSA", Cat.Coach)).toBe("ALSA");
    expect(routeBrand("FlixBus N1138", "FlixBus-eu", Cat.Coach)).toBe("FlixBus");
    expect(routeBrand("NMBS/SNCB", "NMBS/SNCB", Cat.Regional)).toBe("NMBS/SNCB");
  });
  it("tells names that only say where a route runs", () => {
    expect(endpointsName("Paris-Gare-de-Lyon/Milano Centrale")).toEqual(["Paris-Gare-de-Lyon", "Milano Centrale"]);
    expect(endpointsName("Coleraine - Portrush")).toEqual(["Coleraine", "Portrush"]);
    expect(endpointsName("Iarnród Éireann / Irish Rail")).toBeNull(); // spaces around the slash: a name
    expect(endpointsName("IC 850 TÓPART")).toBeNull();
    expect(endpointsName("TGV INOUI")).toBeNull();
    expect(endpointsName("A/B")).toBeNull();
  });
});
