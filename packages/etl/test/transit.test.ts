import { describe, expect, it } from "vitest";
import { TRANSIT_STRIDE, TransitMode, changeAt, decodeTtChunk, encodeTtChunk, transitMinutes, transitModeLabel, walkMinutes } from "@etbm/shared";
import { TransitIndex, cityTransit } from "../src/urban/transit.ts";
import { transitModeOf, tripMinutes, type TransitFeed } from "../src/urban/transit-extract.ts";

const hours = (f: (h: number) => number) => Array.from({ length: 24 }, (_, h) => f(h));

/** A TransitPair 1 – 2 with the same hourly values every day type unless given. */
const pairOf = (wd: number[], sat = wd, sun = sat, modes: number = TransitMode.Metro, bus = [0, 0, 0]) => [1, 2, modes, ...bus, ...wd, ...sat, ...sun];
const WED = 2, FRI = 4, SAT = 5, SUN = 6;

describe("transit transfer times (shared)", () => {
  it("takes the hour's worst case or waits for a later, faster hour", () => {
    const b = pairOf(hours((h) => (h < 5 ? 0 : h === 7 ? 50 : 30)));
    expect(transitMinutes(b, 0, WED, 12 * 60 + 10)).toBe(30);
    // 06:50: this hour 30
    expect(transitMinutes(b, 0, WED, 6 * 60 + 50)).toBe(30);
    // 07:55: 50 this hour, or 5 min wait + 30 at 08:00
    expect(transitMinutes(b, 0, WED, 7 * 60 + 55)).toBe(35);
    // 02:30, no service: wait until 05:00 (150 min) + 30
    expect(transitMinutes(b, 0, WED, 2 * 60 + 30)).toBe(180);
    expect(transitMinutes(pairOf(hours(() => 0)), 0, WED, 600)).toBe(Infinity);
    // wraps to the next day
    expect(transitMinutes(pairOf(hours((h) => (h === 1 ? 20 : 0))), 0, WED, 23 * 60)).toBe(120 + 20);
    // ready time + minutes never decreases with a later start
    let prev = -Infinity;
    for (let m = 0; m < 1440; m++) {
      const y = m + transitMinutes(b, 0, WED, m);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });
  it("uses the values of the day type, into the next day's", () => {
    const p = pairOf(hours(() => 30), hours(() => 45), hours((h) => (h < 9 ? 0 : 60)));
    expect([0, 1, 2, 3, 4].map((d) => transitMinutes(p, 0, d, 720))).toEqual([30, 30, 30, 30, 30]);
    expect(transitMinutes(p, 0, SAT, 720)).toBe(45);
    expect(transitMinutes(p, 0, SUN, 720)).toBe(60);
    // Friday 23:50: Friday's 30
    expect(transitMinutes(p, 0, FRI, 23 * 60 + 50)).toBe(30);
    // Saturday 23:30: Saturday's 45 (Sunday has nothing before 09:00)
    expect(transitMinutes(p, 0, SAT, 23 * 60 + 30)).toBe(45);
    // Sunday 07:00: wait for 09:00
    expect(transitMinutes(p, 0, SUN, 7 * 60)).toBe(120 + 60);
    // Sunday 23:50: Monday 00:00 runs again (10 min wait + 30)
    expect(transitMinutes(p, 0, SUN, 23 * 60 + 50)).toBe(40);
  });
  it("uses transit only where it beats walking, else walks", () => {
    const b = pairOf(hours((h) => (h < 5 ? 0 : 30)));
    expect(changeAt(75, b, 0, "transit", WED, 600)).toEqual({ min: 30, by: "transit", modes: TransitMode.Metro });
    expect(changeAt(25, b, 0, "transit", WED, 600)).toEqual({ min: 25, by: "walk" });
    // at night the walk is faster than waiting for the first train
    expect(changeAt(75, b, 0, "transit", WED, 60)).toEqual({ min: 75, by: "walk" });
    // beyond walking range: transit only, waiting for the first train
    expect(changeAt(130, b, 0, "transit", WED, 60)).toEqual({ min: 270, by: "transit", modes: TransitMode.Metro });
    // a pair further along an array (a chunk's flat pairs)
    expect(changeAt(75, [9, 9, 9, ...b], 3, "transit", WED, 600)).toEqual({ min: 30, by: "transit", modes: TransitMode.Metro });
    expect(changeAt(130, undefined, 0, "transit", WED, 60)).toBeUndefined();
    // the other modes ignore the transit times
    expect(changeAt(75, b, 0, "walk", WED, 600)).toEqual({ min: 75, by: "walk" });
    expect(changeAt(75, b, 0, "bike", WED, 600)?.by).toBe("bike");
    // the bus hours of the day type tell a bus from the metro
    const mixed = pairOf(hours(() => 30), hours(() => 40), hours(() => 50), TransitMode.Metro | TransitMode.Bus, [1 << 22, 1 << 12, 0]);
    expect(changeAt(75, mixed, 0, "transit", WED, 22 * 60 + 5)?.modes).toBe(TransitMode.Bus);
    expect(changeAt(75, mixed, 0, "transit", WED, 12 * 60 + 5)?.modes).toBe(TransitMode.Metro);
    expect(changeAt(75, mixed, 0, "transit", SAT, 12 * 60 + 5)?.modes).toBe(TransitMode.Bus);
    expect(changeAt(75, mixed, 0, "transit", SUN, 12 * 60 + 5)?.modes).toBe(TransitMode.Metro);
  });
  it("names the modes as locals do", () => {
    expect(transitModeLabel(TransitMode.Metro | TransitMode.Rail, "FR")).toBe("metro/RER");
    expect(transitModeLabel(TransitMode.Metro | TransitMode.Rail, "DE")).toBe("U-/S-Bahn");
    expect(transitModeLabel(TransitMode.Metro, "GB")).toBe("Underground");
    expect(transitModeLabel(TransitMode.Tram, "PL")).toBe("tram");
    expect(transitModeLabel(TransitMode.Bus, "DE")).toBe("local bus");
    expect(transitModeLabel(TransitMode.Tram | TransitMode.Bus, "PL")).toBe("tram/bus");
  });
  it("round-trips transit pairs in the transfer timetable chunks", () => {
    const pair = [3, 7, TransitMode.Metro | TransitMode.Bus, (1 << 23) | (1 << 21) | 1, 0, 1 << 12, ...hours((h) => (h < 5 ? 0 : 30 + (h % 3))), ...hours((h) => (h < 6 ? 0 : 40)), ...hours((h) => (h < 7 ? 0 : 35 + (h % 2)))];
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
    const [a, b, modes, b1, b2, b3, ...bands] = r.pairs[0]!;
    expect([a, b, modes, b1, b2, b3]).toEqual([4, 9, TransitMode.Metro, 0, 0, 0]);
    // the same timetable every day
    expect(bands.slice(24, 48)).toEqual(bands.slice(0, 24));
    expect(bands.slice(48)).toEqual(bands.slice(0, 24));
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
