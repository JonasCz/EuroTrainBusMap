import { describe, expect, it } from "vitest";
import { FOREIGN_NAME_RE, applyStopNames, lookupStopName, normName, stopAltKey, stopKey, type StopNamesFile } from "../src/core/stopnames.ts";

const stations = [
  { name: "Wien Hbf", lon: 16.3762, lat: 48.1852, city: 0, rail: true },
  { name: "Vienna Erdberg (Busterminal VIB)", lon: 16.4144, lat: 48.1911, city: 0, rail: false },
  { name: "Vienna Hauptbahnhof (Bus)", lon: 16.3772, lat: 48.1846, city: 0, rail: false },
  { name: "Wien Hbf", lon: 13.0, lat: 47.8, city: 1, rail: true }, // same name elsewhere (far away)
];
const stops = [
  { key: "eu-flixbus:erdberg", altKey: stopAltKey("Vienna Erdberg (Busterminal VIB)", 16.4144, 48.1911), lon: 16.4144, lat: 48.1911 },
  { key: "eu-flixbus:hbf", altKey: stopAltKey("Vienna Hauptbahnhof (Bus)", 16.3772, 48.1846), lon: 16.3772, lat: 48.1846 },
  { key: "x:new", altKey: "~unknown@0,0", lon: 16.4, lat: 48.2 },
];
const mapping: StopNamesFile = {
  version: 1,
  entries: {
    "eu-flixbus:hbf": { action: "merge", station: "Wien Hbf", near: [16.3762, 48.1852] },
    [stopAltKey("Vienna Erdberg (Busterminal VIB)", 16.4144, 48.1911)]: { action: "rename", name: "Wien Erdberg (VIB)" },
  },
};

describe("stop name mapping", () => {
  it("builds stable keys", () => {
    expect(stopKey("eu-flixbus", "abc")).toBe("eu-flixbus:abc");
    expect(normName("Praha – Florenc (ÚAN)")).toBe("praha florenc uan");
    // fallback key tolerates ~10 m jitter
    expect(stopAltKey("Prague Florenc", 14.4401, 50.0899)).toBe(stopAltKey("prague  florenc", 14.44012, 50.08991));
  });
  it("merges into the nearest matching station, renames, leaves unknown stops alone", () => {
    const stationOf = Int32Array.from([1, 2, 1]);
    const r = applyStopNames(mapping, stops, stationOf, stations);
    expect([...stationOf]).toEqual([1, 0, 1]);
    expect(r.merged).toBe(1);
    expect(r.renames.get(1)).toBe("Wien Erdberg (VIB)");
    expect(r.missing).toEqual([]);
  });
  it("logs missing merge targets and never fails", () => {
    const stationOf = Int32Array.from([1, 2, 1]);
    const m: StopNamesFile = { version: 1, entries: { "eu-flixbus:hbf": { action: "merge", station: "Nowhere Hbf" }, "x:new": { action: "keep" } } };
    const r = applyStopNames(m, stops, stationOf, stations);
    expect([...stationOf]).toEqual([1, 2, 1]);
    expect(r.missing).toHaveLength(1);
    expect(applyStopNames(null, stops, stationOf, stations).merged).toBe(0);
  });
  it("does not rename rail stations", () => {
    const stationOf = Int32Array.from([0, 2, 1]);
    const r = applyStopNames(mapping, stops, stationOf, stations);
    expect(r.renames.has(0)).toBe(false);
  });
  it("looks up by primary then fallback key", () => {
    expect(lookupStopName(mapping, "eu-flixbus:hbf", "~x")?.action).toBe("merge");
    expect(lookupStopName(mapping, "other:id", stops[0]!.altKey)?.action).toBe("rename");
    expect(lookupStopName(mapping, "other:id", "~x")).toBeUndefined();
  });
  it("flags English / exonym names", () => {
    for (const n of ["Vienna Erdberg", "Prague Florenc Central Bus Station", "Munich ZOB", "Krakow MDA"]) expect(FOREIGN_NAME_RE.test(n)).toBe(true);
    for (const n of ["Wien Erdberg", "Praha ÚAN Florenc", "München ZOB", "Kraków MDA"]) expect(FOREIGN_NAME_RE.test(n)).toBe(false);
  });
});
