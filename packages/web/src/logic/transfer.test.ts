import { describe, expect, it } from "vitest";
import { Cat, decodeTtChunk, encodeTtChunk, type TtPatternIn } from "@etbm/shared";
import { buildCalIndex, encodeMask } from "./calendar.ts";
import { TransferSearch, TtStore, type SearchParams, type TtNet } from "./transfer.ts";

// 2026-10-20 is a Tuesday; Europe/Berlin is on CEST (UTC+2)
const DATE = "2026-10-20";
const START = "2026-10-19";
const DAYS = 7;
const cal = buildCalIndex({
  startDate: START,
  days: DAYS,
  masks: [
    encodeMask(Array.from({ length: DAYS }, () => true)), // 0 daily
    encodeMask(Array.from({ length: DAYS }, (_, i) => i === 3)), // 1 Thursday only
  ],
});

// cities and their stations
const CITY: Record<string, number[]> = {
  A: [0, 1], // origin
  B: [2], // intermediate stop of the A → C train
  C: [3],
  D: [4],
  E: [5],
  F: [6], // reached late in the evening
  G: [7],
  W: [8, 9, 10, 16], // 8 – 9: 12 min walk; 10 and 16 beyond walking range (no walking transfer)
  X: [11],
  Y: [12],
  Z: [13],
  Q: [14],
  T: [15],
};
const names = Object.keys(CITY);
const cityId = (n: string) => names.indexOf(n);
const stationCity = new Int32Array(17).fill(-1);
names.forEach((n, i) => CITY[n]!.forEach((s) => (stationCity[s] = i)));
const net: TtNet = {
  stationCity,
  cityStations: (c) => CITY[names[c]!]!,
  cityTz: names.map(() => "Europe/Berlin"),
  timezones: ["Europe/Berlin"],
  cal,
};

let pid = 0;
/** A pattern through `stops` ([station, minutes after start]) with trips starting at `starts` (local service minutes). */
const pat = (cat: number, stops: [number, number][], starts: number[], calendar = 0): TtPatternIn => ({
  id: pid++,
  cat,
  tz: 0,
  stations: stops.map((s) => s[0]),
  arr: stops.map((s) => s[1]),
  dep: stops.map((s) => s[1]),
  trips: starts.map((s) => [s, calendar]),
});
const h = (hh: number, mm = 0) => hh * 60 + mm;

const patterns: TtPatternIn[] = [
  // A → B → C, 08:00, at B 09:00, at C 10:00
  pat(Cat.LongDistance, [[0, 0], [2, 60], [3, 120]], [h(8)]),
  // B → E 09:05 (5 min after arriving at B) and 09:20
  pat(Cat.Regional, [[2, 0], [5, 30]], [h(9, 5)]),
  pat(Cat.Regional, [[2, 0], [14, 30]], [h(9, 20)]),
  // C → D 18:00 (an 8 h wait) by bus
  pat(Cat.Bus, [[3, 0], [4, 45]], [h(18)]),
  // A → F 21:00 → 23:00; F → G 00:20 the next day (80 min wait across midnight)
  pat(Cat.Coach, [[1, 0], [6, 120]], [h(21)]),
  pat(Cat.Regional, [[6, 0], [7, 30]], [h(0, 20)]),
  // A → W(8) 10:00 → 12:00
  pat(Cat.Regional, [[0, 0], [8, 120]], [h(10)]),
  // A → W(16) 11:00 → 11:50: a later origin departure, but 16 is too far from 9 and 10 to walk
  pat(Cat.Regional, [[1, 0], [16, 50]], [h(11)]),
  // from W: station 9 (12 min walk) 12:15 and 12:08, station 10 (beyond walking range) 12:25 and 15:00
  pat(Cat.Bus, [[9, 0], [11, 20]], [h(12, 15)]),
  pat(Cat.Bus, [[9, 0], [12, 20]], [h(12, 8)]),
  pat(Cat.Bus, [[10, 0], [13, 20]], [h(12, 25), h(15)]),
  // E → T 11:00 (a second change after B → E)
  pat(Cat.Regional, [[5, 0], [15, 40]], [h(11)]),
  // A → Q only on Thursdays (not on the travel day)
  pat(Cat.Regional, [[0, 0], [14, 50]], [h(7)], 1),
];
const walk: [number, number, number][] = [[8, 9, 12]];

function store(): TtStore {
  const s = new TtStore(stationCity.length);
  // two chunks, the pattern list split (and one pattern in both: kept once)
  s.addChunk(decodeTtChunk(encodeTtChunk({ patterns: patterns.slice(0, 8), walk: [] })));
  s.addChunk(decodeTtChunk(encodeTtChunk({ patterns: patterns.slice(7), walk })));
  return s;
}

function reach(over: Partial<SearchParams> = {}) {
  const s = new TransferSearch(store(), net, { origin: cityId("A"), date: DATE, cats: 15, transfers: 1, minTransfer: 10, maxWait: null, ...over });
  while (!s.done) s.round();
  const lv = (n: string) => s.out.level[cityId(n)];
  return { s, lv };
}

describe("transfer timetable chunks", () => {
  it("round-trips patterns, trips and walking transfers", () => {
    const c = decodeTtChunk(encodeTtChunk({ patterns: patterns.slice(0, 2), walk }));
    expect(Array.from(c.pId)).toEqual([0, 1]);
    expect(Array.from(c.stStation)).toEqual([0, 2, 3, 2, 5]);
    expect(Array.from(c.stArr)).toEqual([0, 60, 120, 0, 30]);
    expect(Array.from(c.trStart)).toEqual([h(8), h(9, 5)]);
    expect(Array.from(c.walk)).toEqual([8, 9, 12]);
  });
  it("keeps a pattern found in two chunks once", () => {
    expect(store().patterns).toBe(patterns.length);
  });
});

describe("reach with changes", () => {
  it("reaches the stops of direct trips in round 1, intermediate ones included", () => {
    const { lv, s } = reach({ transfers: 0 });
    expect(lv("B")).toBe(1);
    expect(lv("C")).toBe(1);
    expect(lv("E")).toBe(0);
    expect(s.out.minutes[cityId("C")]).toBe(120);
  });
  it("changes at an intermediate stop, respecting the minimum transfer time", () => {
    // B → E leaves 5 min after the arrival at B; B → Q 20 min after
    expect(reach({ minTransfer: 5 }).lv("E")).toBe(2);
    expect(reach({ minTransfer: 10 }).lv("E")).toBe(0);
    const r = reach({ minTransfer: 10 });
    expect(r.lv("Q")).toBe(2);
    expect(r.s.out.via[cityId("Q")]).toBe(cityId("B"));
    expect(r.s.out.minutes[cityId("Q")]).toBe(h(9, 50) - h(8)); // origin 08:00 → Q 09:50
  });
  it("limits the wait: hours or until local midnight", () => {
    expect(reach({ maxWait: null }).lv("D")).toBe(2); // 10:00 → 18:00, same day
    expect(reach({ maxWait: 180 }).lv("D")).toBe(0); // 8 h > 3 h
    // 23:00 → 00:20 the next day: not the same day, but within 2 hours
    expect(reach({ maxWait: null }).lv("G")).toBe(0);
    expect(reach({ maxWait: 120 }).lv("G")).toBe(2);
  });
  it("walks between the stations of a city (at least the walk, no transfer beyond walking range)", () => {
    const r = reach({ minTransfer: 5 });
    expect(r.lv("X")).toBe(2); // 15 min ≥ 12 min walk
    // from the 10:00 train (the 11:00 one arrives at station 16, too far from 9 to walk)
    expect(r.s.out.minutes[cityId("X")]).toBe(h(12, 35) - h(10));
    expect(r.lv("Y")).toBe(0); // 8 min < 12 min walk
    expect(r.lv("Z")).toBe(0); // station 10 is beyond walking range: not even after 3 h
    expect(reach({ minTransfer: 13 }).lv("X")).toBe(2); // 15 ≥ max(13, 12)
    expect(reach({ minTransfer: 16 }).lv("X")).toBe(0);
  });
  it("applies the mode filter to every leg", () => {
    expect(reach({ cats: Cat.LongDistance | Cat.Regional }).lv("D")).toBe(0); // C → D is a bus
    expect(reach({ cats: Cat.Regional | Cat.Bus }).lv("C")).toBe(0); // A → C is long-distance
    expect(reach({ cats: Cat.Regional | Cat.Bus }).lv("X")).toBe(2);
  });
  it("uses only trips running on the travel day", () => {
    const r = reach({ transfers: 0 });
    expect(r.lv("Q")).toBe(0); // the Thursday train
    const thu = reach({ transfers: 0, date: "2026-10-22" });
    expect(thu.lv("Q")).toBe(1);
  });
  it("counts further changes as further levels", () => {
    expect(reach({ minTransfer: 5, transfers: 1 }).lv("T")).toBe(0);
    expect(reach({ minTransfer: 5, transfers: 2 }).lv("T")).toBe(3);
  });
  it("records the ridden hops per round", () => {
    const { s } = reach({ minTransfer: 5 });
    const hops = (r: number) => Array.from(s.out.hops[r]!).filter((_, i) => i % 3 !== 2);
    expect(hops(0)).toEqual(expect.arrayContaining([0, 2, 2, 3]));
    expect(hops(1)).toEqual(expect.arrayContaining([2, 5]));
  });
});

describe("journeys with changes", () => {
  it("lists the legs with stations, times and service dates", () => {
    const s = new TransferSearch(store(), net, { origin: cityId("A"), target: cityId("E"), date: DATE, cats: 15, transfers: 1, minTransfer: 5, maxWait: null });
    while (!s.done) s.round();
    const js = s.journeys();
    expect(js).toHaveLength(1);
    const [l1, l2] = js[0]!.legs;
    expect([l1!.stations[l1!.board], l1!.stations[l1!.alight]]).toEqual([0, 2]);
    expect([l2!.stations[l2!.board], l2!.stations[l2!.alight]]).toEqual([2, 5]);
    expect(l1!.serviceDate).toBe(DATE);
    // 08:00 CEST = 06:00 UTC, arrival 09:35 CEST
    expect(new Date(js[0]!.depUtc).toISOString()).toBe("2026-10-20T06:00:00.000Z");
    expect(new Date(js[0]!.arrUtc).toISOString()).toBe("2026-10-20T07:35:00.000Z");
  });
  it("crosses midnight with an hour limit, on the next service day", () => {
    const s = new TransferSearch(store(), net, { origin: cityId("A"), target: cityId("G"), date: DATE, cats: 15, transfers: 1, minTransfer: 5, maxWait: 120 });
    while (!s.done) s.round();
    const [j] = s.journeys();
    expect(j!.legs[1]!.serviceDate).toBe("2026-10-21");
    expect(new Date(j!.arrUtc).toISOString()).toBe("2026-10-20T22:50:00.000Z");
  });
});

describe("continuing a journey (after an arrival)", () => {
  // CEST: local = UTC + 2 h
  const at = (hh: number, mm = 0) => Date.UTC(2026, 9, 20, hh - 2, mm);
  const cont = (from: string, to: string, after: { station: number; utc: number } | null, over: Partial<SearchParams> = {}) => {
    const s = new TransferSearch(store(), net, { origin: cityId(from), target: cityId(to), date: DATE, cats: 15, transfers: 1, minTransfer: 5, maxWait: null, ...(after ? { after } : {}), ...over });
    while (!s.done) s.round();
    return s.journeys().map((j) => new Date(j.depUtc).toISOString().slice(11, 16));
  };
  it("boards only after the arrival plus the minimum transfer time", () => {
    // B → E 09:05 (07:05 UTC): 5 min after arriving at 09:00 is enough, 10 are not, an arrival at 09:10 is too late
    expect(cont("B", "E", { station: 2, utc: at(9) })).toEqual(["07:05"]);
    expect(cont("B", "E", { station: 2, utc: at(9) }, { minTransfer: 10 })).toEqual([]);
    expect(cont("B", "E", { station: 2, utc: at(9, 10) })).toEqual([]);
    // without an arrival every departure of the day counts
    expect(cont("B", "E", null)).toEqual(["07:05"]);
  });
  it("continues with changes and respects the maximum wait", () => {
    // B 09:05 → E 09:35, E 11:00 → T
    expect(cont("B", "T", { station: 2, utc: at(9) })).toEqual(["07:05"]);
    expect(cont("B", "T", { station: 2, utc: at(9) }, { transfers: 0 })).toEqual([]);
    // B → Q 09:20: within 30 min of the arrival, not within 15
    expect(cont("B", "Q", { station: 2, utc: at(9) }, { maxWait: 30 })).toEqual(["07:20"]);
    expect(cont("B", "Q", { station: 2, utc: at(9) }, { maxWait: 15 })).toEqual([]);
  });
  it("stays on board the trip it arrives on: no transfer time, not a change", () => {
    // arriving at B 09:00 on the A → B → C train (no stop time at B): it runs on to C at 10:00
    const ride = { stations: [0, 2, 3], arr: [0, 60, 120], dep: [0, 60, 120], start: h(8), cal: 0, date: DATE, stop: 1 };
    const run = (after: SearchParams["after"], over: Partial<SearchParams> = {}) => {
      const s = new TransferSearch(store(), net, { origin: cityId("B"), target: cityId("C"), date: DATE, cats: 15, transfers: 1, minTransfer: 10, maxWait: null, after, ...over });
      while (!s.done) s.round();
      return s.journeys();
    };
    expect(run({ station: 2, utc: at(9) })).toEqual([]);
    const js = run({ station: 2, utc: at(9), ride });
    expect(js).toHaveLength(1);
    expect(js[0]!.stay).toBe(true);
    expect(js[0]!.legs).toHaveLength(1);
    expect(js[0]!.legs[0]!.board).toBe(1);
    expect(js[0]!.legs[0]!.alight).toBe(2);
    expect(new Date(js[0]!.depUtc).toISOString().slice(11, 16)).toBe("07:00");
    // another trip (the arrival is not on it) or another day: nothing to stay on
    expect(run({ station: 2, utc: at(9), ride: { ...ride, start: h(8, 1) } })).toEqual([]);
    expect(run({ station: 2, utc: at(9), ride: { ...ride, stop: 2 } })).toEqual([]);
    // staying on board to C and changing there (the 18:00 bus to D)
    const d = new TransferSearch(store(), net, { origin: cityId("B"), target: cityId("D"), date: DATE, cats: 15, transfers: 1, minTransfer: 10, maxWait: null, after: { station: 2, utc: at(9), ride } });
    while (!d.done) d.round();
    expect(d.journeys().map((j) => [j.stay ?? false, j.legs.length])).toEqual([[true, 2]]);
    // the other options stay: B → E (change at 09:05 with 5 min) next to staying on board to C and changing there
    const s = new TransferSearch(store(), net, { origin: cityId("B"), target: cityId("E"), date: DATE, cats: 15, transfers: 1, minTransfer: 5, maxWait: null, after: { station: 2, utc: at(9), ride } });
    while (!s.done) s.round();
    expect(s.journeys().map((j) => [j.stay ?? false, j.legs.length])).toEqual([[false, 1]]);
  });
  it("walks from the arrival station to the other stations of the city", () => {
    // arriving at W station 8 at 12:00; station 9 is a 12 min walk: the 12:15 bus to X, not the 12:08 one to Y
    expect(cont("W", "X", { station: 8, utc: at(12) })).toEqual(["10:15"]);
    expect(cont("W", "Y", { station: 8, utc: at(12) })).toEqual([]);
    // station 10 is beyond walking range
    expect(cont("W", "Z", { station: 8, utc: at(12) })).toEqual([]);
  });
});

describe("journeys: route options", () => {
  // O origin; P, M, Q change cities; N target. Brands: 1 Intercités, 2 TGV, 3 TER
  const C2: Record<string, number[]> = { O: [0], P: [1, 2], M: [3], Q: [4], N: [5] };
  const nm = Object.keys(C2);
  const id = (n: string) => nm.indexOf(n);
  const sc = new Int32Array(6).fill(-1);
  nm.forEach((n, i) => C2[n]!.forEach((s) => (sc[s] = i)));
  const net2: TtNet = { stationCity: sc, cityStations: (c) => C2[nm[c]!]!, cityTz: nm.map(() => "Europe/Berlin"), timezones: ["Europe/Berlin"], brands: ["", "Intercités", "TGV", "TER", "Zou"], cal };
  const IC = 1, TGV = 2, TER = 3;
  const b = (brand: number, p: TtPatternIn): TtPatternIn => ({ ...p, brand });
  const base: TtPatternIn[] = [
    b(IC, pat(Cat.LongDistance, [[0, 0], [3, 386]], [h(6, 10)])), // O 06:10 → M 12:36
    b(TGV, pat(Cat.LongDistance, [[0, 0], [1, 129]], [h(6, 46)])), // O 06:46 → P 08:55
    b(TGV, pat(Cat.LongDistance, [[2, 0], [3, 198], [5, 356]], [h(10, 10)])), // P 10:10 → M 13:28 → N 16:06
    b(TER, pat(Cat.Regional, [[3, 0], [5, 160]], [h(13), h(17)])), // M 13:00 / 17:00 → N +2:40
    b(TGV, pat(Cat.LongDistance, [[0, 0], [4, 140]], [h(6, 40)])), // O 06:40 → Q 09:00
    b(TGV, pat(Cat.LongDistance, [[4, 0], [5, 420]], [h(9, 30)])), // Q 09:30 → N 16:30
  ];
  const search = (pats: TtPatternIn[], over: Partial<SearchParams> = {}, walkMin: number | null = 25, transit?: number[]) => {
    const st = new TtStore(6);
    st.addChunk(decodeTtChunk(encodeTtChunk({ patterns: pats, walk: walkMin === null ? [] : [[1, 2, walkMin]], transit: transit ? [[1, 2, 2, ...transit]] : [] })));
    const s = new TransferSearch(st, net2, { origin: id("O"), target: id("N"), date: DATE, cats: 15, transfers: 1, minTransfer: 10, maxWait: null, ...over });
    while (!s.done) s.round();
    const fmt = (u: number) => new Date(u).toISOString().slice(11, 16);
    return s.journeys().map((j) => `${fmt(j.depUtc)}-${fmt(j.arrUtc)} ${j.legs.map((l) => `${l.brand}@${nm[sc[l.stations[l.board]!]!]}`).join(" ")}`);
  };
  // times in UTC (CEST − 2 h)
  it("keeps a slower option of other brands and every onward service at the change", () => {
    expect(search(base)).toEqual([
      "04:10-13:40 Intercités@O TER@M", // Intercités → M → TER (13:00), the 17:00 TER is later on the same option
      "04:10-14:06 Intercités@O TGV@M", // beaten on time by TGV → P → TGV (same TGV), but other brands
      "04:46-14:06 TGV@O TGV@P", // the change at Q (06:40 → 16:30, same brands) is beaten by it
    ]);
  });
  it("drops options beaten by fewer changes without another brand", () => {
    // a direct TGV 07:00 → 15:00 beats both journeys with a TGV leg, not the Intercités + TER
    const direct = b(TGV, pat(Cat.LongDistance, [[0, 0], [5, 480]], [h(7)]));
    expect(search([...base, direct])).toEqual(["04:10-13:40 Intercités@O TER@M", "05:00-13:00 TGV@O"]);
  });
  it("keeps one of journeys at the same times with the same modes and changes", () => {
    const zou = b(4, pat(Cat.Regional, [[3, 0], [5, 160]], [h(13)])); // another brand, same run times as the 13:00 TER
    expect(search([...base, zou], { cats: Cat.LongDistance | Cat.Regional })).toHaveLength(3);
  });
  it("does not wait out the night after a change reached after midnight (same day)", () => {
    const late = [
      b(TER, pat(Cat.Regional, [[0, 0], [3, 70]], [h(23)])), // O 23:00 → M 00:10
      b(TER, pat(Cat.Regional, [[3, 0], [5, 60]], [h(1), h(6)])), // M 01:00 / 06:00 → N
    ];
    expect(search(late)).toEqual(["21:00-00:00 TER@O TER@M"]); // the 01:00, not the 06:00
    expect(search([late[0]!, b(TER, pat(Cat.Regional, [[3, 0], [5, 60]], [h(6)]))])).toEqual([]);
    expect(search([late[0]!, b(TER, pat(Cat.Regional, [[3, 0], [5, 60]], [h(6)]))], { maxWait: 360 })).toEqual(["21:00-05:00 TER@O TER@M"]);
  });
  it("applies the mode filter and walks between stations of the change city", () => {
    expect(search(base, { cats: Cat.LongDistance })).toEqual(["04:10-14:06 Intercités@O TGV@M", "04:46-14:06 TGV@O TGV@P"]);
    // P 08:55, then a walk to the other station for the 10:10 TGV: 75 min are enough, 80 are not
    expect(search(base, { cats: Cat.LongDistance }, 75)).toEqual(["04:10-14:06 Intercités@O TGV@M", "04:46-14:06 TGV@O TGV@P"]);
    expect(search(base, { cats: Cat.LongDistance }, 80)).toEqual(["04:10-14:06 Intercités@O TGV@M", "04:40-14:30 TGV@O TGV@Q"]);
  });
  it("cycles between stations of the change city when chosen", () => {
    const tgv = { cats: Cat.LongDistance };
    // an 80 min walk (5.8 km) is a 30 min ride: the 10:10 TGV from the other station is reached again
    expect(search(base, { ...tgv, changeBy: "bike" }, 80)).toEqual(["04:10-14:06 Intercités@O TGV@M", "04:46-14:06 TGV@O TGV@P"]);
    // beyond walking range (stored for cycling only): no walk, a 46 min ride
    expect(search(base, { ...tgv, maxWait: 600 }, 130)).toEqual(["04:10-14:06 Intercités@O TGV@M", "04:40-14:30 TGV@O TGV@Q"]);
    expect(search(base, { ...tgv, changeBy: "bike" }, 130)).toEqual(["04:10-14:06 Intercités@O TGV@M", "04:46-14:06 TGV@O TGV@P"]);
    // beyond cycling range (a 69 min ride): no transfer
    expect(search(base, { ...tgv, changeBy: "bike", minTransfer: 0 }, 200)).toEqual(["04:10-14:06 Intercités@O TGV@M", "04:40-14:30 TGV@O TGV@Q"]);
    // the minimum transfer time still applies to a ride
    expect(search(base, { ...tgv, changeBy: "bike", minTransfer: 50 }, 80)).toEqual(["04:10-14:06 Intercités@O TGV@M", "04:46-14:06 TGV@O TGV@P"]);
    expect(search(base, { ...tgv, changeBy: "bike", minTransfer: 76 }, 80)).toEqual([]);
  });
  it("changes by transit at the hour of the arrival when chosen", () => {
    const tgv = { cats: Cat.LongDistance };
    const hours = (f: (h: number) => number) => Array.from({ length: 24 }, (_, k) => f(k));
    // P 08:55 (local), the 10:10 TGV from the other station: an 80 min walk misses it, 40 min by metro make it
    const via = ["04:10-14:06 Intercités@O TGV@M", "04:46-14:06 TGV@O TGV@P"], viaQ = ["04:10-14:06 Intercités@O TGV@M", "04:40-14:30 TGV@O TGV@Q"];
    expect(search(base, { ...tgv, changeBy: "transit" }, 80, hours(() => 40))).toEqual(via);
    expect(search(base, { ...tgv, changeBy: "walk" }, 80, hours(() => 40))).toEqual(viaQ);
    // the worst case of the hour of the arrival counts: 80 min at 8 h is too slow …
    expect(search(base, { ...tgv, changeBy: "transit" }, 80, hours((k) => (k === 8 ? 80 : 90)))).toEqual(viaQ);
    // … unless waiting for the next hour is faster (09:00 + 30 min)
    expect(search(base, { ...tgv, changeBy: "transit" }, 80, hours((k) => (k === 8 ? 80 : 30)))).toEqual(via);
    // no service at 8 h and later in the morning: walked (too slow)
    expect(search(base, { ...tgv, changeBy: "transit" }, 80, hours((k) => (k >= 8 && k < 12 ? 0 : 20)))).toEqual(viaQ);
    // beyond walking range: by transit only
    expect(search(base, { ...tgv, changeBy: "transit", maxWait: 600 }, null, hours(() => 40))).toEqual(via);
    expect(search(base, { ...tgv, changeBy: "transit", maxWait: 600 }, null)).toEqual(viaQ);
    // the minimum transfer time still applies
    expect(search(base, { ...tgv, changeBy: "transit", minTransfer: 50 }, 80, hours(() => 40))).toEqual(via);
    expect(search(base, { ...tgv, changeBy: "transit", minTransfer: 76 }, 80, hours(() => 40))).toEqual([]);
  });
  it("reaches cities by transit changes in the reach search too", () => {
    const reach = (by: "walk" | "transit", transit: number[]) => {
      const st = new TtStore(6);
      st.addChunk(decodeTtChunk(encodeTtChunk({ patterns: [base[1]!, base[2]!], walk: [[1, 2, 80]], transit: [[1, 2, 2, ...transit]] })));
      const s = new TransferSearch(st, net2, { origin: id("O"), date: DATE, cats: Cat.LongDistance, transfers: 1, minTransfer: 10, maxWait: null, changeBy: by });
      while (!s.done) s.round();
      return s.out.level[id("N")];
    };
    const all40 = Array.from({ length: 24 }, () => 40);
    // N only via the TGV O → P and the TGV P 10:10 → M → N from the other station of P
    expect(reach("walk", all40)).toBe(0);
    expect(reach("transit", all40)).toBe(2);
    expect(reach("transit", Array.from({ length: 24 }, (_, k) => (k === 8 ? 80 : 90)))).toBe(0);
  });
});
