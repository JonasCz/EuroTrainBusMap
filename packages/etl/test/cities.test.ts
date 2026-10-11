import { describe, expect, it } from "vitest";
import { assignStops, chooseCityName, placeRadius, resolveSatellites, townFromStopName, type Place } from "../src/core/cities.ts";

const P = (id: number, name: string, lat: number, lon: number, population: number, fcode = "PPL", admin: [string, string, string, string] = ["", "", "", String(id)], country = "DE"): Place => ({
  id, name, lat, lon, population, fcode, admin, country, tz: "Europe/Berlin",
});

// Real GeoNames coordinates
const places: Place[] = [
  P(1, "Berlin", 52.52437, 13.41053, 3426354, "PPLC", ["16", "00", "11000", "11000000"]),
  P(2, "Spandau", 52.5511, 13.19921, 39653, "PPLX", ["16", "00", "11000", "11000000"]),
  P(3, "Potsdam", 52.39886, 13.06566, 184754, "PPLA", ["11", "00", "12054", "12054000"]),
  P(4, "Falkensee", 52.56014, 13.0927, 37468, "PPL", ["11", "00", "12063", "12063080"]),
  P(5, "Frankfurt am Main", 50.11552, 8.68417, 650000, "PPLA2", ["05", "064", "06412", "06412000"]),
  P(6, "Offenbach", 50.10061, 8.76647, 119192, "PPLA3", ["05", "064", "06413", "06413000"]),
  P(7, "Nürnberg", 49.45421, 11.07752, 515543, "PPLA2", ["02", "095", "09564", "09564000"]),
  P(8, "Fürth", 49.47593, 10.98856, 128497, "PPLA2", ["02", "095", "09563", "09563000"]),
  P(9, "München", 48.13743, 11.57549, 1505005, "PPLA", ["02", "091", "09162", "09162000"]),
  P(10, "Kleinmachnow", 52.40786, 13.22514, 20000, "PPL", ["11", "00", "12069", "12069304"]),
];
resolveSatellites(places);
const city = (lon: number, lat: number) => {
  const i = assignStops(places, [{ lon, lat }])[0]!;
  return i >= 0 ? places[i]!.name : null;
};

describe("city assignment", () => {
  it("radius grows with population", () => {
    expect(placeRadius(1000)).toBe(1500);
    expect(placeRadius(100_000)).toBeCloseTo(6500);
    expect(placeRadius(1e9)).toBe(16_500);
    expect(placeRadius(1e12)).toBe(18_000);
  });
  it("captures Berlin's main stations incl. Spandau", () => {
    expect(city(13.3695, 52.5251)).toBe("Berlin"); // Hbf
    expect(city(13.4347, 52.5108)).toBe("Berlin"); // Ostbahnhof
    expect(city(13.3884, 52.5487)).toBe("Berlin"); // Gesundbrunnen
    expect(city(13.3655, 52.4757)).toBe("Berlin"); // Südkreuz
    expect(city(13.1977, 52.5344)).toBe("Berlin"); // Spandau
  });
  it("keeps neighbouring towns separate", () => {
    expect(city(13.0667, 52.3917)).toBe("Potsdam"); // Potsdam Hbf
    expect(city(8.7616, 50.0995)).toBe("Offenbach"); // Offenbach Hbf
    expect(city(8.6631, 50.1071)).toBe("Frankfurt am Main"); // Frankfurt Hbf
    expect(city(10.9896, 49.4697)).toBe("Fürth"); // Fürth Hbf
    expect(city(11.0826, 49.4459)).toBe("Nürnberg"); // Nürnberg Hbf
  });
  it("München Hbf and München Ost belong to München", () => {
    expect(city(11.5584, 48.1402)).toBe("München");
    expect(city(11.6047, 48.1272)).toBe("München");
  });
  it("leaves remote stops unassigned", () => {
    expect(city(20, 60)).toBeNull();
  });
});

describe("city names", () => {
  it("chooses the local name matching stop names", () => {
    expect(chooseCityName(["München", "Munich"], ["München Hbf", "München Ost"])).toBe("München");
    expect(chooseCityName(["Genf", "Genève", "Geneva"], ["Genève", "Genève-Eaux-Vives"])).toBe("Genève");
    expect(chooseCityName(["Praha", "Prague"], [])).toBe("Praha");
  });
  it("derives town names from stop names", () => {
    expect(townFromStopName("Kleindorf, Kirche")).toBe("Kleindorf");
    expect(townFromStopName("Oberau Bahnhof")).toBe("Oberau");
    expect(townFromStopName("Musterhausen (Kr. X)")).toBe("Musterhausen");
  });
});

import { parsePlaces, serializePlaces } from "../src/geonames.ts";
describe("places asset", () => {
  it("round-trips the compact places file", () => {
    const p = [{ ...places[0]!, parent: undefined, altNames: ["Berlin", "Berlín"] }, { ...places[2]!, parent: undefined }];
    const back = parsePlaces(serializePlaces(p));
    expect(back[0]).toEqual({ id: 1, name: "Berlin", lat: 52.52437, lon: 13.41053, population: 3426354, fcode: "PPLC", admin: ["16", "00", "11000", "11000000"], country: "DE", tz: "Europe/Berlin", altNames: ["Berlin", "Berlín"] });
    expect(back[1]!.altNames).toBeUndefined();
  });
});
