import { Cat, StopLimit, canAlight, canBoard, decodeTtChunk, encodeTtChunk, type CityFile, type TtPatternIn } from "@etbm/shared";
import { describe, expect, it } from "vitest";
import { buildCalIndex, encodeMask } from "./calendar.ts";
import { connections } from "./connections.ts";
import { ALL_CATS } from "./filters.ts";
import { computeReach, reachRuns } from "./reach.ts";
import { tripSchedule } from "./schedule.ts";
import { stationDepartures } from "./stations.ts";
import { ctx } from "./testdata.ts";
import { pairCandidates, timetable } from "./timetable.ts";
import { TransferSearch, TtStore, type TtNet } from "./transfer.ts";
import { wallToUtc } from "./tz.ts";

const all = { cats: ALL_CATS };
const { NoBoarding, NoAlighting } = StopLimit;

// testdata network: Alpha (0: stations 0 Hbf, 1 Süd), Beta (1: 2), Gamma (2: 3), Delta (3: 4), Eps (4: 5, 6).
// An international train Delta → Alpha Hbf → Alpha Süd → Beta → Gamma that only sets down at Alpha Hbf and only
// picks up at Beta (no travel Alpha → Beta, like a Eurostar Rotterdam → Amsterdam).
const cf: CityFile = {
  city: 0,
  routes: [{ name: "EST", agency: "Eurostar", cat: Cat.LongDistance, flags: 0 }],
  patterns: [
    {
      route: 0,
      stations: [4, 0, 1, 2, 3],
      arr: [0, 100, 108, 220, 600],
      dep: [0, 102, 110, 223, 600],
      corridors: [20, 21, 22, 23],
      headsign: "Gamma",
      limits: [1, NoBoarding, 3, NoAlighting],
    },
  ],
  patternTz: [0],
  trips: [[0, 600, 0, "9100"]], // daily 10:00 Berlin time
  transfers: [
    [0, 1, 15],
    [1, 0, 15],
  ],
  minTransfer: 5,
};
const p = cf.patterns[0]!;

describe("stop restrictions (Pattern.limits)", () => {
  it("canBoard / canAlight", () => {
    expect([0, 1, 2, 3, 4].map((i) => canBoard(p, i))).toEqual([true, false, true, true, false]);
    expect([0, 1, 2, 3, 4].map((i) => canAlight(p, i))).toEqual([false, true, true, false, true]);
  });

  it("reach: boards only where allowed, no destination where one cannot get off", () => {
    const r = computeReach(cf, ctx, all);
    expect([...r.dests.keys()]).toEqual([2]); // Gamma, not Beta
    expect(r.dests.get(2)!.minutes).toBe(600 - 110); // from Alpha Süd
    expect(computeReach(cf, ctx, all, 0).dests.size).toBe(0); // Alpha Hbf: drop-off only
    expect([...computeReach(cf, ctx, all, 1).dests.keys()]).toEqual([2]);
    const runs = reachRuns(cf, ctx, all);
    expect(runs.map((x) => x.dests)).toEqual([[{ city: 2, hops: 2 }]]);
    expect(runs[0]!.corridors).toEqual([22, 23]);
  });

  it("pair timetables: no Alpha → Beta, Alpha → Gamma boards at Süd only", () => {
    expect(pairCandidates(cf, ctx, all, 1)).toEqual([]);
    const [c] = pairCandidates(cf, ctx, all, 2);
    expect(c!.board).toBe(2);
    expect(c!.alight).toBe(4);
    expect(pairCandidates(cf, ctx, all, 2, 0)).toEqual([]);
    const [d] = timetable(cf, ctx, all, 2, "2026-10-09");
    expect(d!.depStation).toBe(1);
    expect(d!.altBoard).toEqual([]); // Alpha Hbf is not offered as another boarding stop
  });

  it("station departures count only stops with boarding", () => {
    const deps = stationDepartures(cf, ctx);
    expect(deps.has(0)).toBe(false);
    expect(deps.get(1)![Cat.LongDistance]).toBe(1);
  });

  it("onward connections: no boarding at a drop-off-only stop, no stop where one cannot get off; staying on board is fine", () => {
    const utc = wallToUtc("2026-10-09", 9 * 60 + 30, "Europe/Berlin");
    const arr = { city: 0, station: 0, utc };
    const cs = connections(cf, ctx, all, arr);
    expect(cs.map((x) => [x.depStation, x.stops.map((s) => s.city)])).toEqual([[1, [2]]]); // walked to Süd, Beta left out
    const through = connections(cf, ctx, all, { ...arr, utc: utc + 30 * 60000, routeName: "EST", number: "9100" });
    expect(through.map((x) => [x.depStation, x.through])).toEqual([[0, true]]);
  });

  it("trip schedule: labels restricted stops, no connections where one cannot get off", () => {
    const s = tripSchedule(cf, ctx, { from: 0, trip: 0, date: "2026-10-09", board: 2, alight: 4 })!;
    expect(s.stops.map((x) => x.limit ?? 0)).toEqual([0, NoBoarding, 0, NoAlighting, 0]);
    expect(s.stops.map((x) => x.onward)).toEqual([false, false, false, false, true]);
  });
});

describe("stop restrictions in the transfer search", () => {
  // A (0) → B (1) → C (2) at 08:00, nobody gets off at B; D (3) → B → E (4) at 09:00, drop-off only at B
  const stationCity = Int32Array.from([0, 1, 2, 3, 4]);
  const cal = buildCalIndex({ startDate: "2026-10-19", days: 7, masks: [encodeMask(Array.from({ length: 7 }, () => true))] });
  const net: TtNet = { stationCity, cityStations: (c) => [c], cityTz: Array(5).fill("Europe/Berlin"), timezones: ["Europe/Berlin"], cal };
  const pats: TtPatternIn[] = [
    { id: 0, cat: Cat.LongDistance, tz: 0, stations: [0, 1, 2], arr: [0, 60, 120], dep: [0, 60, 120], limits: [1, NoAlighting], trips: [[480, 0]] },
    { id: 1, cat: Cat.Regional, tz: 0, stations: [3, 1, 4], arr: [0, 30, 60], dep: [0, 32, 60], limits: [1, NoBoarding], trips: [[540, 0]] },
  ];
  const chunk = decodeTtChunk(encodeTtChunk({ patterns: pats, walk: [] }));
  const store = () => {
    const s = new TtStore(5);
    s.addChunk(chunk);
    return s;
  };
  const levels = (origin: number) => {
    const s = new TransferSearch(store(), net, { origin, date: "2026-10-20", cats: 15, transfers: 1, minTransfer: 5, maxWait: null });
    while (!s.done) s.round();
    return Array.from(s.out.level);
  };

  it("round-trips the restrictions", () => {
    expect(Array.from(chunk.stLimit)).toEqual([0, NoAlighting, 0, 0, NoBoarding, 0]);
  });

  it("does not get off or board where it is not allowed; the vehicle passes", () => {
    expect(levels(0)).toEqual([0, 0, 1, 0, 0]); // C reached, B passed
    expect(levels(1)).toEqual([0, 0, 1, 0, 0]); // from B: the A → C train boards there, the D → E one does not
    expect(levels(3)).toEqual([0, 1, 0, 0, 1]); // D → E: drop-off at B allowed
  });

  it("journeys and their legs carry the restrictions", () => {
    const s = new TransferSearch(store(), net, { origin: 0, target: 2, date: "2026-10-20", cats: 15, transfers: 1, minTransfer: 5, maxWait: null });
    while (!s.done) s.round();
    const [j] = s.journeys();
    expect(j!.legs[0]!.limits).toEqual([1, NoAlighting]);
    const none = new TransferSearch(store(), net, { origin: 0, target: 1, date: "2026-10-20", cats: 15, transfers: 1, minTransfer: 5, maxWait: null });
    while (!none.done) none.round();
    expect(none.journeys()).toEqual([]);
  });
});
