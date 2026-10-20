import { describe, expect, it } from "vitest";
import { LOCAL_BUS_MAX_KM, busExclusion, readableColor, stopSpanKm, stripCityName, urbanModeOf, type MainBusRule } from "../src/urban/classify.ts";
import { mainBusRule } from "../src/urban/feeds.ts";
import type { FeedDef, FeedsConfig } from "../src/feeds.ts";
import { alignFeed } from "../src/urban/align.ts";
import { BUS_LINE_LEVELS, buildUrban, busLineZooms, dedupeLines, lineZoom, metresPerPixel, samplePath, thinZooms } from "../src/urban/model.ts";
import { lineFeature, stationFeature } from "../src/urban/tiles.ts";
import { UMode, type LonLat, type UrbanFeed } from "../src/urban/types.ts";

describe("urbanModeOf", () => {
  it("maps GTFS route types to local modes and leaves heavy rail / coaches to the intercity network", () => {
    expect(urbanModeOf(0)).toBe(UMode.Tram);
    expect(urbanModeOf(900)).toBe(UMode.Tram);
    expect(urbanModeOf(1)).toBe(UMode.Metro);
    expect(urbanModeOf(401)).toBe(UMode.Metro);
    expect(urbanModeOf(7)).toBe(UMode.Cable);
    expect(urbanModeOf(3)).toBe(UMode.Bus);
    expect(urbanModeOf(11)).toBe(UMode.Bus);
    expect(urbanModeOf(715)).toBeNull(); // demand responsive
    for (const t of [2, 4, 102, 200, 1000]) expect(urbanModeOf(t)).toBeNull();
  });
});

describe("local buses", () => {
  const main: MainBusRule = { minKm: 15, dropAgency: /\bbvg\b/i, onlyAgency: null };
  it("measures the span like the intercity loader", () => {
    expect(stopSpanKm([{ lon: 10, lat: 50 }, { lon: 10, lat: 50.1 }])).toBeCloseTo(11.12, 1);
    expect(stopSpanKm([{ lon: 10, lat: 50 }])).toBe(0);
  });
  it("leaves to the intercity network exactly the routes it draws, keeps every other local route", () => {
    expect(busExclusion(5, "Stadtbus Hof", main)).toBeNull(); // town bus, below minBusKm: dropped by the intercity loader
    expect(busExclusion(14.9, "TITSA", main)).toBeNull();
    expect(busExclusion(15, "Regionalbus", main)).toBe("main-network"); // drawn by the intercity network
    expect(busExclusion(25, "BVG", main)).toBeNull(); // a city operator the intercity network rejects
    expect(busExclusion(LOCAL_BUS_MAX_KM + 1, "BVG", main)).toBe("long");
    expect(busExclusion(25, "Any", null)).toBeNull(); // extra local feed
    expect(busExclusion(LOCAL_BUS_MAX_KM + 1, "Any", null)).toBe("long");
    expect(busExclusion(20, "Other", { ...main, onlyAgency: /^Regio/ })).toBeNull(); // not in the intercity network
  });
  it("derives the rule from the feed definition", () => {
    const cfg = { minBusKm: 15, urbanAgencies: "\\bbvg\\b" } as FeedsConfig;
    const def = (keep: FeedDef["keep"], options = {}) => ({ id: "x", country: "ES", name: "x", tier: "bus", keep, sources: [], options }) as FeedDef;
    expect(mainBusRule(def(["rail"]), cfg)).toBeNull();
    const titsa = mainBusRule(def(["coach", "bus"], { minBusKm: 8, dropAgencies: "^Taxi" }), cfg)!;
    expect(titsa.minKm).toBe(8);
    expect(titsa.dropAgency!.test("BVG")).toBe(true);
    expect(titsa.dropAgency!.test("Taxi Sur")).toBe(true);
    expect(titsa.dropAgency!.test("TITSA")).toBe(false);
  });
});

describe("busLineZooms", () => {
  const ln = (x: number, y: number, tpd: number): { tpd: number; coords: LonLat[] } => ({ tpd, coords: [[x, y], [x + 0.03, y + 0.005]] });
  it("shows a town's rare lines from the first level, but makes a crowded centre wait for the frequency zoom", () => {
    expect(busLineZooms([ln(10, 50, 8), ln(10.001, 50, 4)])).toEqual([BUS_LINE_LEVELS[0], BUS_LINE_LEVELS[0]]);
    const crowd = Array.from({ length: 20 }, (_, i) => ln(13.4, 52.5 + i * 1e-4, 100 - i * 4));
    const z = busLineZooms(crowd);
    expect(z[0]).toBe(BUS_LINE_LEVELS[0]);
    expect(z[19]).toBe(lineZoom(UMode.Bus, crowd[19]!.tpd)); // never later than its frequency zoom
    expect(z[19]!).toBeGreaterThan(BUS_LINE_LEVELS[0]!);
    for (let i = 0; i < 20; i++) expect(z[i]!).toBeLessThanOrEqual(lineZoom(UMode.Bus, crowd[i]!.tpd));
  });
});

describe("dedupeLines", () => {
  const line = (name: string, coords: LonLat[], geom: "shape" | "stops" = "shape") => ({ mode: UMode.Tram, name, coords, geom });
  const a: LonLat[] = [[0, 50], [0.01, 50], [0.02, 50], [0.03, 50]];
  it("drops the opposite direction and copies of the same line, keeps other lines and far-away namesakes", () => {
    const out = dedupeLines([line("T1", a), line("T1", [...a].reverse()), line("T1", a, "stops"), line("T2", a), line("T1", a.map(([x, y]) => [x + 1, y] as LonLat))]);
    expect(out.map((l) => l.name)).toEqual(["T1", "T2", "T1"]);
    expect(out[2]!.coords[0]![0]).toBeCloseTo(1);
  });
  it("prefers the better geometry", () => {
    const out = dedupeLines([line("T1", a, "stops"), line("T1", a, "shape")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.geom).toBe("shape");
  });
  it("samples a path about every step", () => {
    expect(samplePath([[0, 50], [0.01, 50]], 100).length).toBeGreaterThan(5);
  });
});

describe("thinZooms", () => {
  it("shows the most important point first and the crowded neighbour only when zoomed in", () => {
    const pts = [
      { lon: 2.3522, lat: 48.8566, imp: 10 },
      { lon: 2.3532, lat: 48.8566, imp: 3 }, // 75 m away
      { lon: 2.4, lat: 48.9, imp: 1 }, // alone
    ];
    const z = thinZooms(pts, [10.5, 11.5, 12.5, 13.5, 14.5], 15);
    expect(z[0]).toBe(10.5);
    expect(z[2]).toBe(10.5);
    expect(z[1]!).toBeGreaterThan(12.5);
    // never later than the last level
    expect(Math.max(...z)).toBeLessThanOrEqual(14.5);
    expect(metresPerPixel(0, 10)).toBeCloseTo(76.4, 0);
  });
  it("a pair 170 m apart separates at the zoom where it is 15 px apart", () => {
    const pts = [{ lon: 0, lat: 0, imp: 2 }, { lon: 0.0015, lat: 0, imp: 1 }];
    expect(thinZooms(pts, [10, 12, 14], 15)[1]).toBe(14);
  });
});

describe("lineZoom", () => {
  it("metro first, buses by frequency", () => {
    expect(lineZoom(UMode.Metro, 200)).toBeLessThan(lineZoom(UMode.Tram, 200));
    expect(lineZoom(UMode.Tram, 200)).toBeLessThan(lineZoom(UMode.Tram, 20));
    expect(lineZoom(UMode.Tram, 200)).toBeLessThan(lineZoom(UMode.Bus, 200));
    expect(lineZoom(UMode.Bus, 120)).toBeLessThan(lineZoom(UMode.Bus, 30));
    expect(lineZoom(UMode.Bus, 30)).toBeLessThan(lineZoom(UMode.Bus, 3));
  });
});

function feed(): UrbanFeed {
  const stops = [
    { id: "a", name: "Alpha", lon: 10, lat: 50, parent: "" },
    { id: "b", name: "Beta", lon: 10.01, lat: 50, parent: "" },
    { id: "b2", name: "Beta", lon: 10.0102, lat: 50.0001, parent: "" }, // other platform of Beta
    { id: "c", name: "Gamma", lon: 10.02, lat: 50, parent: "" },
  ];
  const mk = (mode: 1 | 0, name: string, ids: number[], tpd: number) => ({
    mode, name, desc: "", agency: "Op", color: "", tpd,
    patterns: [{ coords: ids.map((i) => [stops[i]!.lon, stops[i]!.lat] as LonLat), stops: ids, trips: tpd, geom: "shape" as const }],
  });
  return { key: "f", version: 1, stops, lines: [mk(1, "T1", [0, 1, 3], 100), mk(1, "T2", [0, 2, 3], 20), mk(0, "42", [0, 1], 60)], stats: { routes: 3, kept: 3, shaped: 3, dropped: {} } };
}

describe("buildUrban", () => {
  it("merges stops into stations, lists their lines and attaches stations at intercity stations", () => {
    const b = buildUrban([feed()], [{ lon: 10, lat: 50 }]);
    expect(b.stations.map((s) => s.name).sort()).toEqual(["Alpha", "Beta", "Gamma"]);
    const beta = b.stations.find((s) => s.name === "Beta")!;
    expect(beta.lines.sort()).toEqual(["42", "T1", "T2"]);
    expect(b.stations.find((s) => s.name === "Alpha")!.ix).toBe(true);
    expect(beta.ix).toBe(false);
    // the interchange is more important than the terminus
    expect(beta.imp).toBeGreaterThan(b.stations.find((s) => s.name === "Gamma")!.imp - 1e-9);
    expect(b.lines).toHaveLength(3);
    // no stop before its first line
    for (const s of b.stations) expect(s.z).toBeGreaterThanOrEqual(Math.min(s.lz, 99) - 1e-9);
    expect(b.lines.find((l) => l.name === "T1")!.stops.length).toBe(3);
  });
  it("makes tile features with compact properties", () => {
    const b = buildUrban([feed()]);
    const lf = lineFeature(b.lines.find((l) => l.name === "T1")!);
    expect(lf.properties).toMatchObject({ m: UMode.Tram, n: "T1", z: lineZoom(UMode.Tram, 100) });
    expect(lf.properties!.g).toBeUndefined(); // feed shape
    const sf = stationFeature(b.stations.find((s) => s.name === "Beta")!);
    expect(sf.properties).toMatchObject({ n: "Beta", t: UMode.Tram, k: 3 });
    expect(String(sf.properties!.l)).toContain("T1");
  });
});

describe("alignFeed", () => {
  it("leaves stop-to-stop patterns alone when no graph is available", () => {
    const f = feed();
    for (const l of f.lines) for (const p of l.patterns) p.geom = "stops";
    const stats = { patterns: {} as Record<string, { shape: number; routed: number; partial: number; stops: number }> };
    alignFeed(f, { rail: null, road: null }, stats);
    expect(f.lines[0]!.patterns[0]!.geom).toBe("stops");
    expect(stats.patterns.rail!.stops).toBe(2);
    expect(stats.patterns.bus!.stops).toBe(1);
  });
});

describe("names and colours", () => {
  it("strips the city from stop names only in comma / parenthesis forms", () => {
    expect(stripCityName("Freiburg, Hauptstraße", "Freiburg")).toBe("Hauptstraße");
    expect(stripCityName("Hauptstraße (Freiburg)", "Freiburg")).toBe("Hauptstraße");
    expect(stripCityName("Hauptstraße, Freiburg", "freiburg")).toBe("Hauptstraße");
    expect(stripCityName("Wien, Karlsplatz", "Wien")).toBe("Karlsplatz");
    expect(stripCityName("Berlin Hauptbahnhof", "Berlin")).toBe("Berlin Hauptbahnhof");
    expect(stripCityName("Berlin, ", "Berlin")).toBe("Berlin,");
    expect(stripCityName("Marktplatz", "")).toBe("Marktplatz");
  });
  it("clamps line colours to what is readable on both maps", () => {
    expect(readableColor("#ffffff")).not.toBe("ffffff");
    expect(readableColor("000000")).not.toBe("000000");
    expect(readableColor("e1000f")).toBe("e1000f");
    expect(readableColor("nonsense")).toBe("");
  });
  it("attaches a tram stop that carries the station's name", () => {
    const f = feed();
    const b = buildUrban([f], [{ lon: 10.0112, lat: 50.0005, name: "Beta Hbf" }]);
    expect(b.stations.find((s) => s.name === "Beta")!.ix).toBe(true); // ~100 m away but same name
    expect(b.stations.find((s) => s.name === "Gamma")!.ix).toBe(false);
  });
});
