import { describe, expect, it } from "vitest";
import { nameSimilarity, normalizeStopName, prettifyName } from "../src/core/names.ts";
import { cleanStationName, describeStation, mergeStations, walkMinutes, type StopIn } from "../src/core/stations.ts";

describe("name normalization", () => {
  it("removes generic words, platforms and diacritics", () => {
    expect(normalizeStopName("Berlin Hbf (Washingtonplatz)")).toBe("berlin");
    expect(normalizeStopName("Berlin Hauptbahnhof")).toBe("berlin");
    expect(normalizeStopName("München Hbf Gleis 27")).toBe("munchen");
    expect(normalizeStopName("Kraków Główny")).toBe("krakow");
    expect(normalizeStopName("Gare de Lyon")).toBe("de lyon");
  });
  it("similarity", () => {
    expect(nameSimilarity("Berlin Hbf (Washingtonplatz)", "Berlin Hbf")).toBe(1);
    expect(nameSimilarity("Praha hl.n.", "Praha hlavní nádraží")).toBeGreaterThanOrEqual(0.9);
    expect(nameSimilarity("Frankfurt(Main)Hbf", "Frankfurt (Main) Hbf")).toBe(1);
    expect(nameSimilarity("Hauptstraße", "Kirche")).toBe(0);
  });
  it("prettifies names", () => {
    expect(prettifyName("LONDON KINGS CROSS")).toBe("London Kings Cross");
    expect(cleanStationName("S+U Gesundbrunnen Bhf", "Berlin", true)).toBe("Berlin Gesundbrunnen");
    expect(cleanStationName("Wien Hbf", "Wien", true)).toBe("Wien Hbf");
  });
});

const stop = (name: string, lon: number, lat: number, o: Partial<StopIn> = {}): StopIn => ({
  name, lon, lat, rail: false, parent: null, feed: 0, city: 0, weight: 1, ...o,
});

describe("station merging", () => {
  it("merges a bus stop into the nearby rail station with a similar name", () => {
    const stops = [
      stop("Berlin Hbf", 13.3695, 52.5251, { rail: true, weight: 100 }),
      stop("Berlin Hbf (Washingtonplatz)", 13.3699, 52.5243),
      stop("Berlin Hauptbahnhof", 13.3690, 52.5250, { rail: true, feed: 1 }),
      stop("Berlin Ostbahnhof", 13.4347, 52.5108, { rail: true }),
    ];
    const { stationOf, count } = mergeStations(stops);
    expect(count).toBe(2);
    expect(stationOf[0]).toBe(stationOf[1]);
    expect(stationOf[0]).toBe(stationOf[2]);
    expect(stationOf[3]).not.toBe(stationOf[0]);
  });
  it("keeps differently named bus stops and different cities apart; merges by parent", () => {
    const stops = [
      stop("Hauptstraße", 10, 50),
      stop("Kirche", 10.001, 50),
      stop("Hauptstraße", 10.0005, 50, { city: 1 }),
      stop("Gleis 1", 11, 51, { parent: "7", rail: true }),
      stop("Gleis 2", 11.002, 51, { parent: "7", rail: true }),
    ];
    const { stationOf } = mergeStations(stops);
    expect(stationOf[0]).not.toBe(stationOf[1]);
    expect(stationOf[0]).not.toBe(stationOf[2]);
    expect(stationOf[3]).toBe(stationOf[4]);
  });
  it("prefers the rail name for the station", () => {
    const d = describeStation([stop("Berlin Hbf (Washingtonplatz)", 13.37, 52.52, { weight: 1000 }), stop("Berlin Hbf", 13.37, 52.525, { rail: true })], "Berlin");
    expect(d.name).toBe("Berlin Hbf");
  });
  it("walking time", () => {
    expect(walkMinutes(0)).toBe(3);
    expect(walkMinutes(750)).toBe(16);
  });
});
