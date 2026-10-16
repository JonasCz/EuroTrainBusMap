import { Cat } from "@etbm/shared";
import { describe, expect, it } from "vitest";
import { LEVELS, catWidth, cityTierZoom, corridorMinZoom, isLongHop, levelIndex, stationLevel } from "./lod.ts";
import { shortStationName } from "./features.ts";

describe("lod", () => {
  it("snaps zooms to levels", () => {
    expect(levelIndex(0)).toBe(0);
    expect(levelIndex(5.5)).toBe(LEVELS.indexOf(5.5));
    expect(levelIndex(5.9)).toBe(LEVELS.indexOf(5.5));
    expect(levelIndex(20)).toBe(LEVELS.length - 1);
  });
  it("shows busy long-distance rail first and buses last", () => {
    expect(corridorMinZoom(Cat.LongDistance, 20, 50, true)).toBe(0);
    expect(corridorMinZoom(Cat.Regional, 200, 30, true)).toBe(4.5);
    expect(corridorMinZoom(Cat.Regional, 200, 5, true)).toBeGreaterThan(5.5);
    expect(corridorMinZoom(Cat.Coach, 30, 50, true)).toBe(6);
    expect(corridorMinZoom(Cat.Bus, 500, 20, true)).toBeGreaterThanOrEqual(7.5);
    expect(corridorMinZoom(Cat.Bus, 1, 20, true)).toBe(9.5);
  });
  it("treats long straight hops specially", () => {
    expect(isLongHop(300, false)).toBe(true);
    expect(isLongHop(300, true)).toBe(false);
    expect(corridorMinZoom(Cat.Coach, 100, 300, false)).toBe(6.5);
  });
  it("tiers cities by importance and stations by service", () => {
    expect(cityTierZoom(0.9)).toBe(0);
    expect(cityTierZoom(0.1)).toBe(9.5);
    expect(stationLevel(Cat.Bus, 0)).toBe(0);
    expect(stationLevel(Cat.LongDistance, 3)).toBe(0);
    expect(stationLevel(Cat.Regional, 10)).toBe(1);
    expect(stationLevel(Cat.Bus, 30)).toBe(3);
  });
  it("widths grow with frequency; buses thinner", () => {
    expect(catWidth(Cat.Regional, 100)).toBeGreaterThan(catWidth(Cat.Regional, 5));
    expect(catWidth(Cat.Bus, 100)).toBeLessThan(catWidth(Cat.Regional, 100));
    expect(catWidth(Cat.Coach, 10, false)).toBeLessThan(catWidth(Cat.Coach, 10, true));
  });
  it("shortens station names inside their city", () => {
    expect(shortStationName("Berlin Hbf", "Berlin")).toBe("Hbf");
    expect(shortStationName("Berlin-Spandau", "Berlin")).toBe("Spandau");
    expect(shortStationName("Berliner Tor", "Berlin")).toBe("Berliner Tor");
    expect(shortStationName("Praha hl.n.", "Praha")).toBe("hl.n.");
  });
});

import { mix } from "./layers.ts";
describe("mix", () => {
  it("blends colours linearly", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#f7f5f0", "#e9e4d8", 0)).toBe("#f7f5f0");
    expect(mix("#f7f5f0", "#e9e4d8", 1)).toBe("#e9e4d8");
  });
});
