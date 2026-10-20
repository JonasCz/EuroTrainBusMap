import { describe, expect, it } from "vitest";
import { TRANSIT_HEAD, TransitMode, changeAt, transitMinutes, walkMinutes } from "@etbm/shared";

const WED = 2, SAT = 5, SUN = 6;
import { BusCollector, busPairs, mergeBusPairs } from "../src/urban/bus-transfer.ts";
import { patternTimes } from "../src/urban/extract.ts";
import { partitionFeed } from "../src/urban/regions.ts";
import { UMode, type PatternTimes, type UrbanFeed } from "../src/urban/types.ts";

// two stations 3 km apart (a 55 min walk) with a bus stop 100 m north of each (a 5 min walk to the stop)
const lat = 50, dLon = 3000 / (111_320 * Math.cos((lat * Math.PI) / 180)), north = 100 / 111_320;
const A = { id: 4, lon: 10, lat, city: 0 }, B = { id: 9, lon: 10 + dLon, lat, city: 0 };
const stopA = { lon: 10, lat: lat + north }, stopB = { lon: 10 + dLon, lat: lat + north };
const acc = walkMinutes(100);

const every = (from: number, to: number, step: number) => {
  const out: number[] = [];
  for (let t = from; t < to; t += step) out.push(t);
  return out;
};
/** every 10 min 06:00–20:00, then every 30 min until 23:30 */
const thinning = [...every(360, 1200, 10), ...every(1200, 1440, 30)];
const times = (deps: number[][], ride = 10): PatternTimes => ({ t: [0, ride], deps });
/** a line A → B and back with the same departures */
const both = (col: BusCollector, deps: number[][]) => {
  col.addPattern([stopA, stopB], times(deps));
  col.addPattern([stopB, stopA], times(deps));
};
const bandsOf = (col: BusCollector) => {
  const p = busPairs(col).get(0);
  expect(p).toHaveLength(1);
  expect(p![0]!.slice(0, 2)).toEqual([4, 9]);
  return p![0]!.slice(2);
};

describe("station changes by local bus", () => {
  it("waits longer in the evening and has no service at night", () => {
    const col = new BusCollector([A, B]);
    both(col, [thinning, thinning, thinning]);
    const b = bandsOf(col);
    // midday: a bus just missed, 9 min wait, 10 min ride, walks to and from the stops
    expect(b[12]).toBe(acc + 9 + 10 + acc);
    // evening: every 30 min
    expect(b[21]).toBe(acc + 29 + 10 + acc);
    // the last bus at 23:30: the rest of the hour waits for the first bus at 06:00 (over TRANSIT_MAX_MIN)
    expect(b[23]).toBe(0);
    expect(b[0]).toBe(0);
    // 04:00: two hours to the first bus (ready at the stop at 04:05 for the 06:00)
    expect(b[4]).toBe(120 + 10 + acc);
    // at 00:30 the walk (55 min) beats waiting for the first bus; at 12:10 the bus wins
    const pair = mergeBusPairs(undefined, busPairs(col).get(0))[0]!;
    expect(changeAt(walkMinutes(3000), pair, 0, "transit", WED, 30)).toEqual({ min: walkMinutes(3000), by: "walk" });
    expect(changeAt(walkMinutes(3000), pair, 0, "transit", WED, 12 * 60 + 10)).toEqual({ min: 29, by: "transit", modes: TransitMode.Bus });
    // beyond walking range at night: wait for a later hour
    expect(transitMinutes(pair, 0, WED, 30)).toBe(360 + 10 + acc - 30); // at B at 06:15
  });

  it("combines the frequencies of two lines serving a pair, counts a line from two feeds once", () => {
    const x = every(360, 1320, 20), y = every(370, 1320, 20);
    const one = new BusCollector([A, B]);
    both(one, [x, x, x]);
    expect(bandsOf(one)[12]).toBe(acc + 19 + 10 + acc);
    const two = new BusCollector([A, B]);
    both(two, [x, x, x]);
    both(two, [y, y, y]);
    expect(bandsOf(two)[12]).toBe(acc + 9 + 10 + acc);
    const dup = new BusCollector([A, B]);
    both(dup, [x, x, x]);
    both(dup, [[...x], [...x], [...x]]);
    expect(bandsOf(dup)[12]).toBe(acc + 19 + 10 + acc);
  });

  it("walks from the station to stops within reach only, and boards where the walk + ride is shortest", () => {
    const far = 700 / 111_320;
    const col = new BusCollector([A, B]);
    col.addPattern([{ lon: 10, lat: lat - far }, stopB], times([thinning, thinning, thinning]));
    col.addPattern([stopB, { lon: 10, lat: lat - far }], times([thinning, thinning, thinning]));
    expect(busPairs(col).size).toBe(0);
    // a stop 400 m away: a 10 min walk
    const mid = 400 / 111_320;
    const c2 = new BusCollector([A, B]);
    both(c2, []);
    c2.addPattern([{ lon: 10, lat: lat + mid }, stopB], times([thinning, thinning, thinning]));
    c2.addPattern([stopB, { lon: 10, lat: lat + mid }], times([thinning, thinning, thinning]));
    expect(bandsOf(c2)[12]).toBe(walkMinutes(400) + 9 + 10 + acc);
    // a pattern calling near A twice (a loop through the forecourt) boards at the later stop (shorter ride)
    const c3 = new BusCollector([A, B]);
    const d3 = [thinning, thinning, thinning];
    c3.addPattern([stopA, { ...stopA }, stopB], { t: [0, 3, 13], deps: d3 });
    c3.addPattern([stopB, stopA], times(d3));
    expect(bandsOf(c3)[12]).toBe(acc + 9 + 10 + acc);
  });

  it("keeps the weekdays, Saturdays and Sundays apart", () => {
    const sat = every(360, 1440, 30);
    const col = new BusCollector([A, B]);
    both(col, [thinning, sat, []]);
    const b = bandsOf(col);
    expect(b[12]).toBe(acc + 9 + 10 + acc);
    expect(b[24 + 12]).toBe(acc + 29 + 10 + acc);
    // no bus on Sundays: no service all day, so the change is walked
    expect(b.slice(48).every((v) => v === 0)).toBe(true);
    const pair = mergeBusPairs(undefined, busPairs(col).get(0))[0]!;
    expect(changeAt(walkMinutes(3000), pair, 0, "transit", SAT, 12 * 60 + 10)).toEqual({ min: 49, by: "transit", modes: TransitMode.Bus });
    expect(changeAt(walkMinutes(3000), pair, 0, "transit", SUN, 12 * 60 + 10)).toEqual({ min: walkMinutes(3000), by: "walk" });
    // Saturday 23:40 (the last bus gone): Sunday has none, Monday's first bus is beyond TRANSIT_MAX_MIN
    expect(transitMinutes(pair, 0, SAT, 23 * 60 + 40)).toBe(Infinity);
  });

  it("merges into the rail-bound transit pairs hour by hour and labels the bus hours", () => {
    const col = new BusCollector([A, B]);
    both(col, [thinning, thinning, thinning]);
    const day = Array.from({ length: 24 }, (_, h) => (h >= 6 && h < 20 ? 25 : 0));
    const rail = [4, 9, TransitMode.Metro, 0, 0, 0, ...day, ...day, ...day];
    const [m] = mergeBusPairs([rail], busPairs(col).get(0));
    expect(m!.slice(0, 2)).toEqual([4, 9]);
    expect(m![2]).toBe(TransitMode.Metro | TransitMode.Bus);
    expect(m![TRANSIT_HEAD + 12]).toBe(25);
    expect(m![TRANSIT_HEAD + 21]).toBe(acc + 29 + 10 + acc);
    expect(m![3]! & (1 << 12)).toBe(0);
    expect(m![3]! & (1 << 21)).not.toBe(0);
    expect(m![5]! & (1 << 21)).not.toBe(0);
    expect(changeAt(55, m, 0, "transit", WED, 12 * 60 + 10)).toEqual({ min: 25, by: "transit", modes: TransitMode.Metro });
    expect(changeAt(55, m, 0, "transit", WED, 21 * 60 + 10)).toEqual({ min: 49, by: "transit", modes: TransitMode.Bus });
    // the rail pairs of a city without buses stay as they are
    expect(mergeBusPairs([rail], undefined)).toEqual([rail]);
  });

  it("reads the pattern times of a bus line and keeps them out of the layer", () => {
    expect(patternTimes([{ a: null, d: 600 }, { a: 900, d: 960 }, { a: 1500, d: null }], [[400], [], []])).toEqual({ t: [0, 5, 15], deps: [[400], [], []] });
    expect(patternTimes([{ a: null, d: 600 }, { a: 900, d: 960 }], [[], [], []])).toBeUndefined();
    expect(patternTimes([{ a: null, d: null }, { a: 900, d: 960 }], [[1], [], []])).toBeUndefined();
    const feed: UrbanFeed = {
      key: "x",
      version: 5,
      stops: [{ id: "a", name: "A", parent: "", ...stopA }, { id: "b", name: "B", parent: "", ...stopB }],
      lines: [{ mode: UMode.Bus, name: "1", desc: "", agency: "", color: "", tpd: 90, patterns: [{ coords: [[stopA.lon, stopA.lat], [stopB.lon, stopB.lat]], stops: [0, 1], trips: 90, geom: "stops", times: times([thinning, [], []]) }] }],
      stats: { routes: 1, kept: 1, shaped: 0, dropped: {} },
    };
    for (const part of partitionFeed(feed).values()) for (const l of part.lines) for (const p of l.patterns) expect(p.times).toBeUndefined();
    const col = new BusCollector([A, B]);
    col.addFeed(feed);
    expect(col.patterns).toBe(1);
  });
});
