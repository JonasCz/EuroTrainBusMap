import { describe, expect, it } from "vitest";
import { TRANSIT_STRIDE, TransitMode, changeAt, decodeTtChunk, encodeTtChunk, transitMinutes, transitModeLabel, walkMinutes } from "@etbm/shared";
import { TransitIndex, cityTransit } from "../src/urban/transit.ts";
import { transitModeOf, tripMinutes, type TransitFeed } from "../src/urban/transit-extract.ts";

const hours = (f: (h: number) => number) => Array.from({ length: 24 }, (_, h) => f(h));

describe("transit transfer times (shared)", () => {
  it("takes the hour's worst case or waits for a later, faster hour", () => {
    const b = hours((h) => (h < 5 ? 0 : h === 7 ? 50 : 30));
    expect(transitMinutes(b, 0, 12 * 60 + 10)).toBe(30);
    // 06:50: this hour 30
    expect(transitMinutes(b, 0, 6 * 60 + 50)).toBe(30);
    // 07:55: 50 this hour, or 5 min wait + 30 at 08:00
    expect(transitMinutes(b, 0, 7 * 60 + 55)).toBe(35);
    // 02:30, no service: wait until 05:00 (150 min) + 30
    expect(transitMinutes(b, 0, 2 * 60 + 30)).toBe(180);
    expect(transitMinutes(hours(() => 0), 0, 600)).toBe(Infinity);
    // wraps to the next day
    expect(transitMinutes(hours((h) => (h === 1 ? 20 : 0)), 0, 23 * 60)).toBe(120 + 20);
    // ready time + minutes never decreases with a later start
    let prev = -Infinity;
    for (let m = 0; m < 1440; m++) {
      const y = m + transitMinutes(b, 0, m);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });
  it("uses transit only where it beats walking, else walks", () => {
    const b = hours((h) => (h < 5 ? 0 : 30));
    expect(changeAt(75, b, 0, "transit", 600)).toEqual({ min: 30, by: "transit" });
    expect(changeAt(25, b, 0, "transit", 600)).toEqual({ min: 25, by: "walk" });
    // at night the walk is faster than waiting for the first train
    expect(changeAt(75, b, 0, "transit", 60)).toEqual({ min: 75, by: "walk" });
    // beyond walking range: transit only, waiting for the first train
    expect(changeAt(130, b, 0, "transit", 60)).toEqual({ min: 270, by: "transit" });
    expect(changeAt(130, undefined, 0, "transit", 60)).toBeUndefined();
    // the other modes ignore the transit times
    expect(changeAt(75, b, 0, "walk", 600)).toEqual({ min: 75, by: "walk" });
    expect(changeAt(75, b, 0, "bike", 600)?.by).toBe("bike");
  });
  it("names the modes as locals do", () => {
    expect(transitModeLabel(TransitMode.Metro | TransitMode.Rail, "FR")).toBe("metro/RER");
    expect(transitModeLabel(TransitMode.Metro | TransitMode.Rail, "DE")).toBe("U-/S-Bahn");
    expect(transitModeLabel(TransitMode.Metro, "GB")).toBe("Underground");
    expect(transitModeLabel(TransitMode.Tram, "PL")).toBe("tram");
  });
  it("round-trips transit pairs in the transfer timetable chunks", () => {
    const pair = [3, 7, TransitMode.Metro, ...hours((h) => (h < 5 ? 0 : 30 + (h % 3)))];
    const c = decodeTtChunk(encodeTtChunk({ patterns: [], walk: [[3, 7, 40]], transit: [pair] }));
    expect(c.transit.length).toBe(TRANSIT_STRIDE);
    expect(Array.from(c.transit)).toEqual(pair);
    expect(Array.from(c.walk)).toEqual([3, 7, 40]);
  });
});

describe("transit transfer times (ETL)", () => {
  it("reads route types and trip times conservatively", () => {
    expect(transitModeOf(1, false)).toBe(TransitMode.Metro);
    expect(transitModeOf(900, false)).toBe(TransitMode.Tram);
    expect(transitModeOf(109, false)).toBe(TransitMode.Rail);
    expect(transitModeOf(2, false)).toBe(0); // intercity rail of a national feed
    expect(transitModeOf(2, true)).toBe(TransitMode.Rail); // RER in the local authority's feed
    expect(transitModeOf(3, true)).toBe(0); // buses are not used
    // departures rounded down, arrivals up, a stop without times interpolated
    expect(tripMinutes([null, null, 600 + 125], [480 + 30, null, null])).toEqual({ arr: [9, 11, 13], dep: [8, 10, 12] });
    expect(tripMinutes([null, 600], [null, null])).toBeNull();
  });

  it("computes hourly worst cases from a timetable (headway, night, both directions)", () => {
    // two stations 3 km apart (a 55 min walk), a metro stop 100 m from each, 10 min ride; every 10 min 06:00 – 21:00,
    // every 20 min until 00:30, nothing at night
    const lat = 50, dLon = 3000 / (111_320 * Math.cos((lat * Math.PI) / 180));
    const sA = { id: 4, lon: 10, lat, cats: 1, tpd: 100 }, sB = { id: 9, lon: 10 + dLon, lat, cats: 2, tpd: 50 };
    const off = 100 / 111_320;
    const starts: number[] = [];
    for (let t = 6 * 60; t < 21 * 60; t += 10) starts.push(t);
    for (let t = 21 * 60; t <= 24 * 60 + 30; t += 20) starts.push(t);
    const trips = starts.flatMap((s) => [s, 0xff]);
    const feed: TransitFeed = {
      key: "x",
      version: 1,
      stops: [[10, lat + off], [10 + dLon, lat + off]],
      patterns: [
        { mode: TransitMode.Metro, stops: [0, 1], arr: [0, 10], dep: [0, 10], trips },
        { mode: TransitMode.Metro, stops: [1, 0], arr: [0, 10], dep: [0, 10], trips },
      ],
      stats: { routes: 1, trips: 0, freqTrips: 0 },
    };
    const r = cityTransit(new TransitIndex([feed]), { city: 0, stations: [sA, sB] });
    expect(r.pairs).toHaveLength(1);
    const [a, b, modes, ...bands] = r.pairs[0]!;
    expect([a, b, modes]).toEqual([4, 9, TransitMode.Metro]);
    const acc = walkMinutes(100); // 5 min to / from the platforms
    // midday: just missed a train: 9 min wait (whole minutes), 10 min ride
    expect(bands[12]).toBe(acc + 9 + 10 + acc);
    // late evening: every 20 min
    expect(bands[22]).toBe(acc + 19 + 10 + acc);
    // 04:00: waiting for the first train at 06:00
    expect(bands[4]).toBe(120 + 10 + acc);
    // 01:00: more than TRANSIT_MAX_MIN until the first train
    expect(bands[1]).toBe(0);
    expect(walkMinutes(3000)).toBeGreaterThan(bands[12]!);
  });
});
