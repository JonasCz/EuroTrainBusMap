import { describe, expect, it } from "vitest";
import { frequencyBand, stopModes } from "./urban.ts";
import { parseHash, toHash } from "../ui/state.ts";
import { localOn, sameFilters, ALL_CATS } from "./filters.ts";
import type { Net } from "../data/net.ts";

describe("frequencyBand", () => {
  it("turns trips per day of one direction into a headway band", () => {
    expect(frequencyBand(undefined)).toBe("");
    expect(frequencyBand(0)).toBe("");
    expect(frequencyBand(3)).toBe("3 trips a day");
    expect(frequencyBand(1)).toBe("1 trip a day");
    expect(frequencyBand(96)).toBe("every ~10 min"); // 16 h service, 10 min headway
    expect(frequencyBand(32)).toBe("every ~30 min");
    expect(frequencyBand(400)).toBe("every few minutes");
    expect(frequencyBand(16)).toBe("every ~60 min");
  });
});

describe("stopModes", () => {
  it("names the modes of a stop, metro first", () => {
    expect(stopModes((1 << 0) | (1 << 2))).toEqual(["Metro", "Bus"]);
    expect(stopModes(1 << 1)).toEqual(["Tram"]);
    expect(stopModes(0)).toEqual([]);
  });
});

describe("local transport toggle", () => {
  const net = { cities: [], slug: [], bySlug: new Map(), file: { stations: [], timezones: [] } } as unknown as Net;
  it("is on by default, off with local=0, and round-trips through the hash", () => {
    expect(localOn(parseHash(net, "").filters)).toBe(true);
    const off = parseHash(net, "#local=0");
    expect(localOn(off.filters)).toBe(false);
    expect(toHash(net, off)).toBe("#local=0");
    expect(toHash(net, parseHash(net, "#modes=lr&local=0"))).toBe("#modes=lr&local=0");
    expect(toHash(net, parseHash(net, ""))).toBe("");
  });
  it("counts as a filter change", () => {
    expect(sameFilters({ cats: ALL_CATS }, { cats: ALL_CATS, local: true })).toBe(true);
    expect(sameFilters({ cats: ALL_CATS }, { cats: ALL_CATS, local: false })).toBe(false);
  });
});
