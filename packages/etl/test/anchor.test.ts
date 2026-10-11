import { describe, expect, it } from "vitest";
import { Cat } from "@etbm/shared";
import { anchorCitiesAtMainStation, mainStations } from "../src/core/anchor.ts";

describe("city anchors", () => {
  // city 0: town centre with a busy bus stop, a small town station and a rail junction 4 km away
  const stations = [
    { city: 0, lon: -8.159, lat: 52.472 }, // 0 bus stop (busy)
    { city: 0, lon: -8.197, lat: 52.504 }, // 1 junction (LD + regional)
    { city: 0, lon: -8.162, lat: 52.47 }, // 2 town station (regional, few)
    { city: 1, lon: -8.6, lat: 52.66 }, // 3 other city, rail
    { city: 2, lon: -8.0, lat: 52.3 }, // 4 bus-only city
  ];
  const patterns = [
    { stations: [0, 4], cat: Cat.Bus, days: 600 },
    { stations: [1, 3], cat: Cat.LongDistance, days: 60 },
    { stations: [2, 1, 3], cat: Cat.Regional, days: 20 },
  ];
  const days = patterns.map((p) => p.days);
  const catOf = (p: number) => patterns[p]!.cat;

  it("prefers the busiest rail station over busier bus stops", () => {
    expect([...mainStations(4, stations, patterns, days, catOf)]).toEqual([1, 3, 4, -1]);
  });

  it("moves served cities onto their main station", () => {
    const cities = [{ lon: -8.156, lat: 52.473 }, { lon: -8.62, lat: 52.66 }, { lon: -8.01, lat: 52.31 }, { lon: 1, lat: 1 }];
    expect(anchorCitiesAtMainStation(cities, stations, patterns, days, catOf)).toBe(3);
    expect(cities[0]).toEqual({ lon: -8.197, lat: 52.504 });
    expect(cities[2]).toEqual({ lon: -8.0, lat: 52.3 });
    expect(cities[3]).toEqual({ lon: 1, lat: 1 });
  });
});
