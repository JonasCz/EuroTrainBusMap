import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { COVERAGE_BOXES, MAP_BBOX, inCoverage } from "@etbm/shared";
import { BBOX, EURO_COUNTRIES, GEONAMES_COVERAGE, parsePlaces, placesCoverage, serializePlaces } from "../src/geonames.ts";
import { coverageWhere, extractPrefix } from "../src/geometry/overture.ts";
import type { Place } from "../src/core/cities.ts";

describe("map coverage", () => {
  it("covers Europe, the Canary Islands, Madeira and Morocco, not the rest of Africa", () => {
    for (const [lon, lat] of [
      [2.35, 48.86], // Paris
      [-21.94, 64.15], // Reykjavík
      [-15.43, 28.12], // Las Palmas de Gran Canaria
      [-17.92, 27.81], // El Hierro, Valverde
      [-16.91, 32.65], // Funchal
      [-7.59, 33.59], // Casablanca
      [-15.94, 23.71], // Dakhla
      [-16.96, 21.36], // Guerguerat (Supratours)
      [-1.91, 34.68], // Oujda
    ]) expect(inCoverage(lon!, lat!), `${lon},${lat}`).toBe(true);
    for (const [lon, lat] of [
      [31.24, 30.04], // Cairo
      [3.06, 30.0], // Algerian Sahara
      [-17.45, 14.69], // Dakar
    ]) expect(inCoverage(lon!, lat!), `${lon},${lat}`).toBe(false);
  });

  it("the map box encloses every coverage box", () => {
    for (const b of COVERAGE_BOXES) {
      expect(b[0]).toBeGreaterThanOrEqual(MAP_BBOX[0]);
      expect(b[1]).toBeGreaterThanOrEqual(MAP_BBOX[1]);
      expect(b[2]).toBeLessThanOrEqual(MAP_BBOX[2]);
      expect(b[3]).toBeLessThanOrEqual(MAP_BBOX[3]);
    }
    expect(BBOX).toEqual({ minLon: MAP_BBOX[0], minLat: MAP_BBOX[1], maxLon: MAP_BBOX[2], maxLat: MAP_BBOX[3] });
  });

  it("Overture extracts are filtered by every coverage box and named after the coverage", () => {
    const w = coverageWhere();
    expect(w.split(" OR ")).toHaveLength(COVERAGE_BOXES.length);
    expect(w).toContain("bbox.ymin < 34 AND bbox.ymax > 20.5");
    expect(extractPrefix("rail")).toMatch(/^rail-eu-ma-$/);
  });

  it("GeoNames include Morocco and Western Sahara", () => {
    expect(EURO_COUNTRIES.has("MA")).toBe(true);
    expect(EURO_COUNTRIES.has("EH")).toBe(true);
  });

  it("places assets carry their coverage; older files without it are told apart", () => {
    const p: Place = { id: 2553604, name: "Casablanca", lat: 33.58831, lon: -7.61138, population: 3144909, fcode: "PPLA", admin: ["04", "", "", ""], country: "MA", tz: "Africa/Casablanca" };
    const buf = serializePlaces([p]);
    expect(placesCoverage(buf)).toBe(GEONAMES_COVERAGE);
    expect(parsePlaces(buf)).toEqual([p]);
    const old = gzipSync("2553604\tCasablanca\t33.58831\t-7.61138\tMA\t3144909\tAfrica/Casablanca\tPPLA\t04\t\t\t\t\n");
    expect(placesCoverage(old)).toBeNull();
    expect(parsePlaces(old)).toHaveLength(1);
  });
});
