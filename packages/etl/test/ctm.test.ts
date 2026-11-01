import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dateRange, isoWeekday, readRetrievedAt, validateGtfs, type GtfsFeed } from "../src/generators/gtfs.ts";
import { generatorContext, loadGeneratorFiles, runGenerator, serviceWindow } from "../src/generators/registry.ts";
import { GeocodeStore, NeedsGeocodingError, type GeocodeFile, type MissingStop } from "../src/generators/geocodes.ts";
import { GeneratorState } from "../src/generators/state.ts";
import { GeneratorError, type GeneratorContext } from "../src/generators/types.ts";
import { GENERATORS_DIR, loadFeedsConfig } from "../src/feeds.ts";
import ctm, * as G from "../generators/ma-ctm.ts";

const here = import.meta.dirname;
const FIX = join(here, "fixtures", "ctm");
const START = "2026-11-02"; // a Monday: the sampled week is Wed 2026-11-04 … Tue 2026-11-10
const DAYS = 60;
const read = async (name: string) => JSON.parse(await readFile(join(FIX, name), "utf8")) as any;

// ---------------------------------------------------------------- a fake booking API from a small timetable

interface MRun {
  code: string;
  line: string;
  trip: string;
  /** weekdays (of the service day, the day of the first departure) it runs on, 0 = Monday */
  days: number[];
  /** [stop name, arrival, departure] in minutes after midnight of the service day */
  calls: [string, number | null, number | null][];
  /** service days on which it does not run although the weekday says so */
  except?: string[];
}
const iso = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
const dayNum = (d: string) => Math.round(Date.parse(d + "T00:00:00Z") / 86_400_000);
const stamp = (day: string, min: number) => `${iso(dayNum(day) + Math.floor(min / 1440))}T${String(Math.floor((min % 1440) / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}:00`;

interface FakeOpts {
  /** last day with answers (the sales horizon) */
  horizon?: string;
  /** stop pairs a run does not sell (a search does not list them): predicate(run, i, j) */
  unsold?: (r: MRun, i: number, j: number) => boolean;
  /** replace the answer of a request: (kind, url, json) → json */
  edit?: (kind: "stops" | "search" | "route", json: any, url: string) => any;
  /** make requests fail: (kind, n-th request of the kind) → true */
  fail?: (kind: "search" | "route", n: number) => boolean;
  /** false: no journeys with a change */
  changes?: boolean;
}

class FakeApi {
  requests: string[] = [];
  searches: { day: string; o: number; d: number }[] = [];
  private jid = new Map<string, { run: MRun; i: number; j: number; day: string }[]>();
  private n = 0;
  private count = { search: 0, route: 0 };
  constructor(
    readonly stops: any,
    readonly runs: MRun[],
    readonly o: FakeOpts = {},
  ) {}
  private cityOf(stop: string): number | undefined {
    for (const c of this.stops.Countries[0].Cities) if (c.BusStops.some((s: any) => s.BusStopName === stop)) return c.CityId;
    return undefined;
  }
  private active(r: MRun, day: string) {
    return r.days.includes(isoWeekday(day)) && !(r.except ?? []).includes(day);
  }
  /** every leg of the timetable that departs at stop i on the searched day: [run, i, service day] */
  private departures(date: string) {
    const out: { run: MRun; i: number; service: string }[] = [];
    for (const run of this.runs)
      for (let i = 0; i < run.calls.length - 1; i++) {
        // the instance whose stop i is passed on the searched day (a run that left the day before is listed too)
        const service = iso(dayNum(date) - Math.floor(run.calls[i]![2]! / 1440));
        if (this.active(run, service)) out.push({ run, i, service });
      }
    return out;
  }
  private leg(run: MRun, i: number, j: number, day: string) {
    return { BusCompanyName: "CTM", BrandShortName: "CONFORT", BusLineNumber: run.line, DepartureStopName: run.calls[i]![0], DepartureDatetime: stamp(day, run.calls[i]![2]!), DestinationStopName: run.calls[j]![0], ArrivalDatetime: stamp(day, run.calls[j]![1]!) };
  }
  fetchText: GeneratorContext["fetchText"] = async (url) => {
    this.requests.push(url);
    const edit = (kind: "stops" | "search" | "route", json: any) => JSON.stringify(this.o.edit ? this.o.edit(kind, json, url) : json);
    if (url === G.STOPS_URL) return edit("stops", this.stops);
    let m = /\/journeys\/search\?departureDate=([\d-]+)&.*originCityId=(\d+)&destinationCityId=(\d+)/.exec(url);
    if (m) {
      const [, date, o, d] = m as unknown as [string, string, string, string];
      this.searches.push({ day: date, o: Number(o), d: Number(d) });
      if (this.o.fail?.("search", ++this.count.search)) throw new Error(`HTTP 500 for ${url}`);
      const out: any[] = [];
      const add = (legs: { run: MRun; i: number; j: number; day: string }[]) => {
        const id = `j${++this.n}-${legs.map((l) => l.run.code).join("+")}`;
        this.jid.set(id, legs);
        const first = legs[0]!, last = legs[legs.length - 1]!;
        out.push({
          JourneyId: id,
          DepartureDateTime: stamp(first.day, first.run.calls[first.i]![2]!),
          ArrivalDateTime: stamp(last.day, last.run.calls[last.j]![1]!),
          OriginStopName: first.run.calls[first.i]![0],
          DestinationStopName: last.run.calls[last.j]![0],
          IsForSale: true,
          Legs: legs.map((l) => this.leg(l.run, l.i, l.j, l.day)),
        });
      };
      if (date >= "2026-11-01") {
        // after the sales horizon only the legs of the instance that left on the last day of sale remain
        const deps = this.departures(date).filter((x) => x.service <= (this.o.horizon ?? "2099-01-01"));
        for (const { run, i, service } of deps) {
          if (this.cityOf(run.calls[i]![0]) !== Number(o)) continue;
          for (let j = i + 1; j < run.calls.length; j++) {
            if (this.o.unsold?.(run, i, j) || this.cityOf(run.calls[j]![0]) !== Number(d)) continue;
            add([{ run, i, j, day: service }]);
          }
        }
        // one change: the first run to a stop where another run leaves within twelve hours
        if (this.o.changes !== false)
          for (const { run, i, service } of deps) {
            if (this.cityOf(run.calls[i]![0]) !== Number(o)) continue;
            for (let m2 = i + 1; m2 < run.calls.length; m2++) {
              if (this.o.unsold?.(run, i, m2)) continue;
              const arrive = dayNum(service) * 1440 + run.calls[m2]![1]!;
              for (const other of this.runs) {
                if (other === run) continue;
                const p = other.calls.findIndex((c) => c[0] === run.calls[m2]![0] && c[2] !== null);
                if (p < 0) continue;
                for (const sd of [-1, 0, 1].map((k) => iso(dayNum(service) + k))) {
                  const leave = dayNum(sd) * 1440 + other.calls[p]![2]!;
                  if (!this.active(other, sd) || leave < arrive || leave - arrive > 720) continue;
                  for (let q = p + 1; q < other.calls.length; q++)
                    if (this.cityOf(other.calls[q]![0]) === Number(d) && !this.o.unsold?.(other, p, q)) add([{ run, i, j: m2, day: service }, { run: other, i: p, j: q, day: sd }]);
                }
              }
            }
          }
      }
      return edit("search", { Journeys: out });
    }
    m = /\/journeys\/([^/]+)\/route\?/.exec(url);
    if (m) {
      if (this.o.fail?.("route", ++this.count.route)) throw new Error(`HTTP 500 for ${url}`);
      const legs = this.jid.get(m[1]!);
      if (!legs) throw new Error(`HTTP 400 for ${url}`);
      return edit("route", {
        Legs: legs.map(({ run, i, j: k, day }, n) => ({
          OrderNumber: n + 1,
          ServiceCode: run.code,
          BusCompanyName: "CTM",
          BusLineNumber: run.line,
          TripName: run.trip,
          DepartureStopName: run.calls[i]![0],
          DepartureDatetime: stamp(day, run.calls[i]![2]!),
          DestinationStopName: run.calls[k]![0],
          ArrivalDatetime: stamp(day, run.calls[k]![1]!),
          IntermediateStops: run.calls.slice(i + 1, k).map(([name, a, d]) => ({ StopName: name, ArrivalDateTime: stamp(day, a!), DepartureDateTime: stamp(day, d!), IsRequestPickUpStop: false, IsRequestDropOffStop: false })),
        })),
      });
    }
    throw new Error(`unexpected request ${url}`);
  };
}

const ALL = [0, 1, 2, 3, 4, 5, 6];
/** The timetable of the tests, after the real run CATF100 (Casablanca – Tafraout, line 009040, checked 2026-11-04). */
const RUNS = (): MRun[] => [
  {
    code: "CATF100", line: "009040", trip: "Casablanca-Tafraout", days: ALL,
    calls: [["Casablanca FAR", null, 390], ["Casablanca Maarif", 405, 420], ["Marrakech", 625, 630], ["Agadir", 825, 840], ["Tiznit", 975, 990], ["Tafraout", 1155, null]],
  },
  {
    code: "TFCA100", line: "009040", trip: "Tafraout-Casablanca", days: ALL,
    calls: [["Tafraout", null, 420], ["Tiznit", 540, 555], ["Agadir", 660, 675], ["Marrakech", 885, 890], ["Casablanca Maarif", 1090, 1100], ["Casablanca FAR", 1115, null]],
  },
  // leaves in the evening, calls after midnight and arrives at 03:00 the next day
  {
    code: "MAGU200", line: "009011", trip: "Marrakech-Guelmim Via Agadir", days: ALL,
    calls: [["Marrakech", null, 1170], ["Agadir", 1380, 1395], ["Tiznit", 1450, 1460], ["Guelmim", 1620, null]],
  },
  { code: "AGES300", line: "038044", trip: "Agadir-Essaouira", days: ALL, calls: [["Agadir", null, 480], ["Essaouira", 600, null]] },
  // Monday to Thursday; neither end is a hub: only known as the second leg of a journey Agadir – Essaouira – Safi
  { code: "ESSA301", line: "038044", trip: "Essaouira-Safi", days: [0, 1, 2, 3], calls: [["Essaouira", null, 660], ["Safi", 780, null]] },
  // Wednesdays, Fridays and Sundays
  { code: "ESAG302", line: "038044", trip: "Essaouira-Agadir", days: [2, 4, 6], calls: [["Essaouira", null, 840], ["Agadir", 960, null]] },
];

const stopsFixture = () => read("filtered-stops.json");
async function fakeApi(runs: MRun[] = RUNS(), o: FakeOpts = {}, edit?: (stops: any) => void) {
  const stops = await stopsFixture();
  edit?.(stops);
  return new FakeApi(stops, runs, o);
}
const storeOf = (entries: GeocodeFile["entries"] = {}) => new GeocodeStore("ma-ctm", { version: 1, country: "ma", entries });
const fast: Partial<G.Options> = { intervalMs: 0, hubs: ["Casablanca", "Agadir"], minRuns: 3, minCities: 5 };
function ctxWith(api: FakeApi, startDate = START, warnings: string[] = [], extra: Partial<Parameters<typeof generatorContext>[0]> = {}): GeneratorContext {
  return generatorContext({ id: "ma-ctm", userAgent: "t", startDate, days: DAYS, warnings, fetchText: api.fetchText, log: () => {}, warn: () => {}, ...extra });
}
async function run(runs?: MRun[], o: FakeOpts = {}, opts: Partial<G.Options> = {}, edit?: (stops: any) => void, warnings: string[] = []) {
  const api = await fakeApi(runs, o, edit);
  const feed = await G.generateFrom(ctxWith(api, START, warnings), { ...fast, geo: storeOf(), ...opts });
  return { api, feed, warnings };
}
const stopsOf = (feed: GtfsFeed, trip: string) => {
  const name = new Map(feed.stops.map((s) => [s.stop_id, s.stop_name]));
  return feed.stopTimes.filter((s) => s.trip_id === trip).sort((a, b) => a.stop_sequence - b.stop_sequence).map((s) => name.get(s.stop_id));
};
const tripOf = (feed: GtfsFeed, code: string) => feed.trips.find((t) => t.trip_id.startsWith(code + ":"))!;
const datesOf = (feed: GtfsFeed, code: string) => feed.services.get(tripOf(feed, code).service_id)!;
const timesOf = (feed: GtfsFeed, trip: string) => feed.stopTimes.filter((s) => s.trip_id === trip).sort((a, b) => a.stop_sequence - b.stop_sequence).map((s) => [s.arr, s.dep]);

// stops without coordinates in the fixture that the geocode store has to place
const needsStore = () =>
  storeOf(Object.fromEntries(Object.entries(NEEDS).map(([n, [lat, lon]], i) => [`N${i}`, { name: n, lat: lat!, lon: lon!, source: "manual", checked: "2026-11-01" }])));
const NEEDS: Record<string, [number, number]> = { "Supratours Casa voyageurs": [33.59013, -7.590102], "Beni Mellal Supratours": [32.336353, -6.35429] };

describe("ma-ctm: reading the API (fixtures copied from the live API, 2026-11-04)", () => {
  it("filtered-stops: cities, stops and their coordinates", async () => {
    const net = G.parseNetwork(await stopsFixture(), 5);
    expect(net.cities).toHaveLength(12);
    expect(net.stopByName.get("Casablanca FAR")).toMatchObject({ id: 301, coord: [33.59586, -7.612193] });
    expect(net.stopByName.get("Supratours Casa voyageurs")!.coord).toBeNull();
    expect(net.stopByName.get("Casablanca Maarif")!.city.name).toBe("Casablanca");
    expect(net.cityByNorm.get("benimellal")!.stops).toHaveLength(3);
    expect(net.stopByNorm.get("casablancaainsebaa")!.name).toBe("Casablanca Ain Sebaa");
  });

  it("filtered-stops: strict", async () => {
    const mut = async (f: (j: any) => void) => {
      const j = await stopsFixture();
      f(j);
      return () => G.parseNetwork(j, 8);
    };
    expect(() => G.parseNetwork({})).toThrow(/no Countries/);
    expect(await mut((j) => (j.Countries[0].CountryName = "Espagne"))).toThrow(/country "Espagne"/);
    expect(await mut((j) => j.Countries[0].Cities[0].BusStops.push({ ...j.Countries[0].Cities[1].BusStops[0] }))).toThrow(/two stops called/);
    expect(await mut((j) => (j.Countries[0].Cities[0].BusStops[0].Coordinates = { Latitude: "x" }))).toThrow(/unreadable Coordinates/);
    expect(await mut((j) => (j.Countries[0].Cities = j.Countries[0].Cities.slice(0, 5)))).toThrow(/only 5 cities \(expected at least 8\)/);
  });

  it("search: journeys with their legs, times in minutes after midnight of the searched day", async () => {
    const js = G.parseSearch(await read("search-casablanca-agadir.json"), "2026-11-04");
    expect(js).toHaveLength(3);
    expect(js[0]).toMatchObject({ dep: 390, arr: 825, legs: [{ line: "009040", depStop: "Casablanca FAR", dep: 390, destStop: "Agadir", arr: 825 }] });
    // a change: two legs, the second leaves after the first arrives
    const two = G.parseSearch(await read("search-casablanca-mrirt-change.json"), "2026-11-04");
    expect(two[0]!.legs.map((l) => [l.line, l.depStop, l.destStop])).toEqual([["009006", "Casablanca FAR", "Beni Mellal Amiral"], ["015001", "Beni Mellal Amiral", "Mrirt"]]);
  });

  it("search: strict", async () => {
    const f = await read("search-casablanca-agadir.json");
    const mut = (edit: (j: any) => void) => {
      const j = structuredClone(f);
      edit(j);
      return () => G.parseSearch(j, "2026-11-04");
    };
    expect(mut((j) => (j.Journeys[0].Legs[0].BusCompanyName = "Supratours"))).toThrow(/company "Supratours"/);
    expect(mut((j) => (j.Journeys[0].Legs[0].DepartureDatetime = "2026-11-04T06:30"))).toThrow(/is not a YYYY-MM-DDTHH:MM:00 time/);
    expect(mut((j) => (j.Journeys[0].Legs[0].ArrivalDatetime = "2026-11-04T05:00:00"))).toThrow(/arrives before it departs/);
    expect(mut((j) => (j.Journeys[0].Legs[0].DepartureDatetime = "2026-11-12T06:30:00"))).toThrow(/days from the searched day/);
    expect(mut((j) => delete j.Journeys[0].Legs[0].BusLineNumber)).toThrow(/lacks BusLineNumber/);
    expect(mut((j) => (j.Journeys = {}))).toThrow(/no Journeys list/);
    const two = await read("search-casablanca-mrirt-change.json");
    two.Journeys[0].Legs[1].DepartureStopName = "Khenifra";
    expect(() => G.parseSearch(two, "2026-11-04")).toThrow(/do not connect/);
  });

  it("route: the stops between the searched ones, and the ServiceCode of each leg", async () => {
    const [p] = G.parseRoute(await read("route-casablanca-tafraout.json"), "2026-11-04");
    expect(p).toMatchObject({ code: "CATF100", line: "009040", tripName: "Casablanca-Tafraout" });
    expect(p!.calls.map((c) => c.name)).toEqual(["Casablanca FAR", "Casablanca Maarif", "Marrakech", "Agadir", "Inzegane", "Ait Melloul", "Tiznit", "Tighmi", "Idaousmlal", "Ait Ouafqa", "Tafraout"]);
    expect(p!.calls[0]).toEqual({ name: "Casablanca FAR", dep: 390 });
    expect(p!.calls[1]).toEqual({ name: "Casablanca Maarif", arr: 405, dep: 420 });
    expect(p!.calls[10]).toEqual({ name: "Tafraout", arr: 1155 });
    const two = G.parseRoute(await read("route-casablanca-mrirt-change.json"), "2026-11-04");
    expect(two.map((x) => [x.code, x.tripName])).toEqual([["CABM110", "Casablanca-Beni mellal"], ["FEAG103", "Inzegane-Fes Via Beni Mellal"]]);
    // the second leg belongs to a longer run: only its stops from Beni Mellal Amiral to Mrirt are known
    expect(two[1]!.calls[0]).toEqual({ name: "Beni Mellal Amiral", dep: 1035 });
    const bad = await read("route-casablanca-tafraout.json");
    bad.Legs[0].ServiceCode = "";
    expect(() => G.parseRoute(bad, "2026-11-04")).toThrow(/lacks ServiceCode/);
    const bad2 = await read("route-casablanca-tafraout.json");
    bad2.Legs[0].BusCompanyName = "Autre";
    expect(() => G.parseRoute(bad2, "2026-11-04")).toThrow(/company "Autre"/);
  });
});

describe("ma-ctm: runs on different days are one run", () => {
  const call = (name: string, arr: number | undefined, dep: number | undefined) => ({ name, ...(arr !== undefined ? { arr } : {}), ...(dep !== undefined ? { dep } : {}) });
  it("merges pieces of one ServiceCode (same times, same order), refuses other times", () => {
    const a = [call("FAR", undefined, 390), call("Maarif", 405, 420), call("Marrakech", 625, 630), call("Agadir", 825, undefined)];
    const b = [call("Marrakech", undefined, 630), call("Agadir", 825, 840), call("Tiznit", 975, undefined)];
    expect(G.mergeCalls(a, b)!.map((c) => [c.name, c.arr, c.dep])).toEqual([["FAR", undefined, 390], ["Maarif", 405, 420], ["Marrakech", 625, 630], ["Agadir", 825, 840], ["Tiznit", 975, undefined]]);
    expect(G.mergeCalls(a, [call("Marrakech", undefined, 640), call("Agadir", 825, undefined)])).toBeNull(); // other time
    expect(G.mergeCalls(a, [call("Agadir", undefined, 840), call("Marrakech", 900, undefined)])).toBeNull(); // other order
    expect(G.mergeCalls(a, [call("Tiznit", undefined, 990), call("Tafraout", 1100, undefined)])).toBeNull(); // nothing shared
    // earlier stops are put in front
    expect(G.mergeCalls(a, [call("Ain Sebaa", undefined, 360), call("FAR", 380, 390)])!.map((c) => c.name)).toEqual(["Ain Sebaa", "FAR", "Maarif", "Marrakech", "Agadir"]);
  });

  it("a leg found on the day after the run left is the same run: the service day is the day of the first departure", () => {
    const store = new G.RunStore();
    const piece = (calls: ReturnType<typeof call>[]) => ({ code: "AGDA100", line: "001011", tripName: "Agadir-Dakhla", calls });
    // searched on Wed 2026-11-04: the run that left Agadir on Tuesday 11-03, seen at Guelmim (03:00 the next day = 11-04 00:40…)
    const d1 = store.add("2026-11-04", piece([call("Guelmim", undefined, 40), call("Tan Tan", 160, undefined)]), true);
    expect(G.maskText(G.maskOf(d1, ["2026-11-04"]))).toBe("0010000"); // provisional: the first call known is the start
    // and the run that left Agadir on Wednesday, seen at Agadir (10:00): its calls are Agadir 10:00, Guelmim 15:00+…
    const full = store.add("2026-11-04", piece([call("Agadir", undefined, 600), call("Guelmim", 1380, 1480), call("Tan Tan", 1600, undefined)]), true);
    expect(store.runs).toHaveLength(1);
    expect(full).toBe(d1);
    // Guelmim 40 (the first piece) is 1480 - 1440 on the previous instance: found at k = -1; Agadir's own instance at k = 0
    expect(G.serviceDays(full, ["2026-11-04"]).map((d) => new Date(d * 86_400_000).toISOString().slice(0, 10))).toEqual(["2026-11-03", "2026-11-04"]);
    expect(full.calls.map((c) => [c.name, c.dep])).toEqual([["Agadir", 600], ["Guelmim", 1480], ["Tan Tan", undefined]]);
    // a leg of the same run on another searched day is recognised without a route
    expect(store.explains("2026-11-06", { line: "001011", depStop: "Guelmim", dep: 40, destStop: "Tan Tan", arr: 160 }, true)).toBe(full);
    expect(G.maskText(G.maskOf(full, ["2026-11-04", "2026-11-05", "2026-11-06"]))).toBe("0111000"); // service days Tue 11-03, Wed 11-04, Thu 11-05 (the 11-06 leg is the run that left on the 5th)
  });

  it("two runs found apart become one when a piece joins them", () => {
    const store = new G.RunStore();
    const mk = (calls: ReturnType<typeof call>[]) => ({ code: "FELA100", line: "015024", tripName: "Fes-Laayoune", calls });
    store.add("2026-11-04", mk([call("Fes", undefined, 600), call("Meknes", 660, 670)]));
    store.add("2026-11-04", mk([call("Marrakech", undefined, 900), call("Agadir", 1100, undefined)]));
    expect(store.runs).toHaveLength(2);
    store.add("2026-11-04", mk([call("Meknes", undefined, 670), call("Marrakech", 890, 900)]));
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]!.calls.map((c) => c.name)).toEqual(["Fes", "Meknes", "Marrakech", "Agadir"]);
  });
});

describe("ma-ctm: the generator on a fake API", () => {
  it("happy path: runs, stops with coordinates, past midnight, routes", async () => {
    const warnings: string[] = [];
    const { feed, api } = await run(undefined, {}, { geo: needsStore() }, undefined, warnings);
    validateGtfs(feed, serviceWindow(START, DAYS));
    expect(feed.agency).toEqual([expect.objectContaining({ agency_id: "ctm", agency_url: "https://www.ctm.ma/", agency_timezone: "Africa/Casablanca", agency_lang: "fr" })]);
    expect(feed.trips.map((t) => t.trip_id.split(":")[0]).sort()).toEqual(["AGES300", "CATF100", "ESAG302", "ESSA301", "MAGU200", "TFCA100"]);
    expect(feed.routes.every((r) => r.route_type === 200 && r.agency_id === "ctm")).toBe(true);
    expect(feed.routes.map((r) => r.route_long_name).sort()).toEqual(["Agadir – Essaouira", "Casablanca – Tafraout", "Essaouira – Agadir", "Essaouira – Safi", "Marrakech – Guelmim via Agadir", "Tafraout – Casablanca"]);
    // CATF100: all six stops, times after midnight of the service day, coordinates of filtered-stops
    const t = tripOf(feed, "CATF100");
    expect(stopsOf(feed, t.trip_id)).toEqual(["Casablanca FAR", "Casablanca Maarif", "Marrakech", "Agadir", "Tiznit", "Tafraout"]);
    expect(timesOf(feed, t.trip_id)[0]).toEqual([390, 390]);
    expect(timesOf(feed, t.trip_id)[1]).toEqual([405, 420]);
    expect(t.trip_headsign).toBe("Tafraout");
    expect(feed.stops.find((s) => s.stop_name === "Casablanca FAR")).toMatchObject({ stop_lat: 33.59586, stop_lon: -7.612193 });
    // the run that arrives at 03:00 the next day: Guelmim at 1620 minutes
    const g = tripOf(feed, "MAGU200");
    expect(timesOf(feed, g.trip_id).at(-1)).toEqual([1620, 1620]);
    expect(timesOf(feed, g.trip_id)[2]).toEqual([1450, 1460]);
    // Essaouira – Safi has no hub: found as the second leg of a journey with a change, then searched by the pair of its ends
    expect(stopsOf(feed, tripOf(feed, "ESSA301").trip_id)).toEqual(["Essaouira", "Safi"]);
    expect(api.searches.some((s) => s.o === 5595 && s.d === 5615 && s.day === "2026-11-04")).toBe(true);
    expect(api.requests.length).toBeLessThanOrEqual(G.MAX_REQUESTS);
    expect(warnings.filter((w) => !/spot|sells up to/.test(w))).toEqual([]);
  });

  it("weekly mask: the weekdays of the service day over the window, up to the sales horizon", async () => {
    const { feed } = await run(undefined, { horizon: "2026-12-20" });
    const win = serviceWindow(START, DAYS); // 2026-11-01 … 2027-01-01
    const wed = datesOf(feed, "ESAG302");
    expect(new Set(wed.map(isoWeekday))).toEqual(new Set([2, 4, 6]));
    expect(wed[0]).toBe("2026-11-01"); // a Sunday: the window starts the day before the build's start date
    expect(wed.at(-1)).toBe("2026-12-20"); // the last day the API answers
    expect(win.to).toBe("2027-01-01");
    expect(new Set(datesOf(feed, "ESSA301").map(isoWeekday))).toEqual(new Set([0, 1, 2, 3]));
    expect(datesOf(feed, "CATF100")).toEqual(dateRange("2026-11-01", "2026-12-20"));
    // the run of the evening: its service day is the day it leaves Marrakech
    expect(datesOf(feed, "MAGU200")).toEqual(dateRange("2026-11-01", "2026-12-20"));
  });

  it("the sales horizon is found by bisection and reported", async () => {
    const warnings: string[] = [];
    const { api } = await run(undefined, { horizon: "2026-12-05" }, {}, undefined, warnings);
    expect(warnings.join("\n")).toMatch(/the API sells up to 2026-12-05; service ends there/);
    // 2027-01-01 (probe), then about six bisection steps (the spot checks, 2026-11-25 and 2026-12-23, are other searches)
    const probes = api.searches.filter((s) => s.day > "2026-11-10" && s.day <= "2027-01-01" && !["2026-11-25", "2026-12-23"].includes(s.day)).map((s) => s.day);
    expect(probes[0]).toBe("2027-01-01");
    expect(new Set(probes).size).toBeLessThanOrEqual(8);
  });

  it("weekday of the service day, not of the searched day: a stop passed after midnight", async () => {
    // Tuesdays and Thursdays only: leaves Guelmim at 23:00, calls at Tiznit at 00:15 and reaches Agadir at 01:30 the next day.
    // With Tiznit as the only hub the pair Tiznit – Agadir is the cheapest to search again (it also lists TFCA100): its
    // journeys leave on the day after the service day.
    const runs: MRun[] = [
      ...RUNS().slice(0, 2),
      { code: "GUAG500", line: "009011", trip: "Guelmim-Agadir", days: [1, 3], calls: [["Guelmim", null, 1380], ["Tiznit", 1450, 1455], ["Agadir", 1530, null]] },
    ];
    const { feed, api } = await run(runs, {}, { hubs: ["Tiznit"] });
    expect(new Set(datesOf(feed, "GUAG500").map(isoWeekday))).toEqual(new Set([1, 3]));
    expect(timesOf(feed, tripOf(feed, "GUAG500").trip_id)).toEqual([[1380, 1380], [1450, 1455], [1530, 1530]]);
    // the sampled week searched the pair on 11-04 … 11-10 and found the service days 11-03 … 11-09
    expect(api.searches.filter((s) => s.o === 5656 && s.d === 5589).map((s) => s.day)).toContain("2026-11-10");
  });

  it("a run known only in part is completed through the search of its trip name's cities", async () => {
    // Marrakech is the only hub: CATF100 is seen from Casablanca to Marrakech and from Marrakech to Tiznit, Tafraout is not sold from there
    const unsold = (r: MRun, i: number, j: number) => r.code === "CATF100" && r.calls[j]![0] === "Tafraout" && r.calls[i]![0] === "Marrakech";
    const { feed } = await run(undefined, { unsold }, { hubs: ["Marrakech"] });
    expect(stopsOf(feed, tripOf(feed, "CATF100").trip_id).at(-1)).toBe("Tafraout");
    expect(stopsOf(feed, tripOf(feed, "CATF100").trip_id)).toHaveLength(6);
    // not found: the run ends at Tiznit and the generator says so
    const warnings: string[] = [];
    const none = (r: MRun, _i: number, j: number) => r.code === "CATF100" && r.calls[j]![0] === "Tafraout";
    const part = await run(undefined, { unsold: none }, { hubs: ["Marrakech"] }, undefined, warnings);
    expect(stopsOf(part.feed, tripOf(part.feed, "CATF100").trip_id).at(-1)).toBe("Tiznit");
    expect(warnings.join("\n")).toMatch(/1 runs are known only in part .*CATF100/);
  });

  it("a city without any run is searched against its nearest neighbours", async () => {
    const { api } = await run();
    // Tamelelt (5744) is in the stop list, no run calls there
    expect(api.searches.some((s) => s.o === 5744 && s.d === 5686 && s.day === "2026-11-04")).toBe(true); // Marrakech, a neighbour
    expect(api.searches.some((s) => s.d === 5744)).toBe(true);
  });

  it("a run that no search of a city pair lists directly is left out, with a warning", async () => {
    const warnings: string[] = [];
    // ESSA301's end-to-end pair is never listed: the pair search says nothing about it
    const hide = (kind: string, json: any, url: string) =>
      kind === "search" && /originCityId=5595&destinationCityId=5615/.test(url) ? { Journeys: [] } : json;
    const { feed } = await run(undefined, { edit: hide }, {}, undefined, warnings);
    expect(feed.trips.some((t) => t.trip_id.startsWith("ESSA301"))).toBe(false);
    expect(warnings.join("\n")).toMatch(/1 runs are listed by no search of a city pair, .*ESSA301/);
  });

  it("stops without coordinates: the routes calling there are left out, everything else is built", async () => {
    const runs = RUNS();
    runs.push({ code: "AGBM600", line: "015001", trip: "Agadir-Beni Mellal", days: ALL, calls: [["Agadir", null, 700], ["Beni Mellal Supratours", 1000, null]] });
    const needs = { stops: [] as MissingStop[], dropped: [] as string[] };
    const api = await fakeApi(runs);
    const feed = await G.generateFrom(ctxWith(api, START, [], { needs }), { ...fast, geo: storeOf() });
    expect(feed.trips.some((t) => t.trip_id.startsWith("AGBM600"))).toBe(false);
    expect(feed.trips.length).toBe(6);
    expect(needs.stops.map((s) => s.name)).toEqual(["Beni Mellal Supratours"]);
    expect(needs.dropped[0]).toMatch(/1 runs calling at Beni Mellal Supratours/);
    // an unreviewed entry counts as missing, a skip entry leaves the stop out of the run
    const un = await run(runs, {}, { geo: storeOf({ BENIMELLALSUPRATOURS: { name: "Beni Mellal Supratours", lat: 32.34, lon: -6.35, source: "osm-auto", checked: null } }) });
    expect(un.feed.trips.some((t) => t.trip_id.startsWith("AGBM600"))).toBe(false);
    const sk = await run(runs, {}, { geo: storeOf({ BENIMELLALSUPRATOURS: { name: "Beni Mellal Supratours", lat: 0, lon: 0, source: "none", checked: "2026-11-01", skip: true } }) });
    expect(sk.feed.trips.some((t) => t.trip_id.startsWith("AGBM600"))).toBe(false); // fewer than two stops left
    // a reviewed entry places it
    const ok = await run(runs, {}, { geo: needsStore() });
    expect(stopsOf(ok.feed, tripOf(ok.feed, "AGBM600").trip_id)).toEqual(["Agadir", "Beni Mellal Supratours"]);
    expect(ok.feed.stops.find((x) => x.stop_name === "Beni Mellal Supratours")).toMatchObject({ stop_lat: 32.336353, stop_lon: -6.35429 });
    // nothing is left: the source fails and names the stop
    await expect(run([runs[6]!], {}, { minRuns: 1 })).rejects.toBeInstanceOf(NeedsGeocodingError);
  });

  it("a reviewed entry of the geocode store wins over the API's coordinates", async () => {
    const entries = { MARRAKECH: { name: "Marrakech", lat: 31.6, lon: -8.0, source: "manual", checked: "2026-11-01" } };
    const { feed } = await run(undefined, {}, { geo: storeOf(entries) });
    expect(feed.stops.find((s) => s.stop_name === "Marrakech")).toMatchObject({ stop_lat: 31.6, stop_lon: -8 });
  });

  it("an impossible hop drops the run with a warning; too many fail the source", async () => {
    const warnings: string[] = [];
    // Tiznit moved 400 km away: every run through it has an impossible hop
    const moved = (stops: any) => {
      stops.Countries[0].Cities.find((c: any) => c.CityName === "Tiznit").BusStops[0].Coordinates = { Latitude: 34.5, Longitude: -3.5 };
    };
    await expect(run(undefined, {}, {}, moved)).rejects.toThrow(/runs dropped .*impossible hops/);
    // one bad run among many is only dropped
    const many: MRun[] = [];
    for (let i = 0; i < 12; i++) many.push({ code: `M${i}`, line: "009040", trip: "Casablanca-Marrakech", days: ALL, calls: [["Casablanca FAR", null, 100 + i * 60], ["Marrakech", 100 + i * 60 + 240, null]] });
    many.push({ code: "MBAD", line: "009040", trip: "Casablanca-Marrakech", days: ALL, calls: [["Casablanca FAR", null, 5], ["Marrakech", 20, null]] }); // 240 km in 15 min
    const ok = await run(many, {}, {}, undefined, warnings);
    expect(ok.feed.trips).toHaveLength(12);
    expect(warnings.join("\n")).toMatch(/run Casablanca-Marrakech MBAD .*impossible hop Casablanca FAR → Marrakech/);
  });

  it("the source changing shape fails it", async () => {
    await expect(run(undefined, { edit: (k, j) => (k === "stops" ? { ...j, Countries: [{ ...j.Countries[0], CountryName: "Espagne" }] } : j) })).rejects.toThrow(/country "Espagne"/);
    await expect(run(undefined, { edit: (k, j) => (k === "search" ? { Journeys: j.Journeys.map((x: any) => ({ ...x, Legs: x.Legs.map((l: any) => ({ ...l, BusCompanyName: "FlixBus" })) })) } : j) })).rejects.toThrow(/company "FlixBus"/);
    await expect(run(undefined, { edit: (k, j) => (k === "search" ? { Trips: [] } : j) })).rejects.toThrow(/no Journeys list/);
    await expect(run(undefined, { edit: (k, j) => (k === "route" ? { Legs: j.Legs.map((l: any) => ({ ...l, DestinationStopName: "Agadir" })) } : j) })).rejects.toThrow(/does not match the searched leg/);
    await expect(run(undefined, { edit: (k, j) => (k === "route" ? { Legs: [] } : j) })).rejects.toThrow(/has 0 legs/);
    // too few runs: the API answered with much less than usual
    await expect(run(undefined, {}, { minRuns: 100 })).rejects.toThrow(/only \d+ runs found \(expected at least 100\)/);
    // trip names nobody can read any more
    await expect(run(RUNS().map((r) => ({ ...r, trip: "???" })))).rejects.toThrow(/trip name whose ends are no city or stop/);
    // a stop list that shrank
    await expect(run(undefined, {}, { minCities: 50 })).rejects.toThrow(/only 12 cities \(expected at least 50\)/);
  });

  it("failed requests are counted; too many fail the source", async () => {
    const warnings: string[] = [];
    const ok = await run(undefined, { fail: (k, n) => k === "route" && n === 3 }, {}, undefined, warnings);
    expect(ok.feed.trips.length).toBeGreaterThan(0);
    expect(warnings.join("\n")).toMatch(/request failed \(1 so far\)/);
    await expect(run(undefined, { fail: (k, n) => k === "search" && n % 3 === 0 })).rejects.toThrow(/requests failed/);
    // an API that stops answering is left alone: eight failures in a row end the run
    const calls = { n: 0 };
    await expect(run(undefined, { fail: (k) => k === "search" && ++calls.n > 3 })).rejects.toThrow(/8 requests in a row failed, the API does not answer/);
    expect(calls.n).toBeLessThanOrEqual(13);
  });

  it("the request budget ends the run with what was found, and warns; the pacing holds", async () => {
    const warnings: string[] = [];
    const { api, feed } = await run(undefined, {}, { maxRequests: 70 }, undefined, warnings);
    expect(api.requests.length).toBeLessThanOrEqual(70);
    expect(warnings.join("\n")).toMatch(/request budget/);
    expect(feed.trips.length).toBeGreaterThan(0);
    // at most two requests in flight, starts about intervalMs apart (the recorded start follows the paced one by a moment)
    let inflight = 0, max = 0;
    const starts: number[] = [];
    const base = await fakeApi();
    const slow: GeneratorContext["fetchText"] = async (u, o) => {
      starts.push(Date.now());
      max = Math.max(max, ++inflight);
      await new Promise((r) => setTimeout(r, 70));
      inflight--;
      return base.fetchText(u, o);
    };
    await G.generateFrom({ ...ctxWith(base), fetchText: slow }, { ...fast, intervalMs: 40, maxRequests: 24, geo: storeOf() });
    expect(starts.length).toBe(24);
    expect(max).toBe(2);
    expect(Math.min(...starts.slice(1).map((t, i) => t - starts[i]!))).toBeGreaterThanOrEqual(25);
  });

  it("observes one page per line number, without prices, seats or journey ids; a changed time is reported", async () => {
    const state = new GeneratorState();
    const observed: ReturnType<GeneratorContext["observe"]>[] = [];
    await G.generateFrom(ctxWith(await fakeApi(), START, [], { state, observed }), { ...fast, geo: storeOf() });
    expect(observed.map((o) => o.key).sort()).toEqual(["line-009011", "line-009040", "line-038044"]);
    expect(observed.every((o) => o.isNew)).toBe(true);
    // the same timetable again: nothing changed
    const again: typeof observed = [];
    await G.generateFrom(ctxWith(await fakeApi(), START, [], { state, observed: again }), { ...fast, geo: storeOf() });
    expect(again.some((o) => o.changed)).toBe(false);
    // CATF100 leaves ten minutes later: line 009040 changed, the others not
    const later = RUNS();
    later[0]!.calls[0]![2] = 400;
    later[0]!.calls[1]![1] = 415;
    const changed: typeof observed = [];
    await G.generateFrom(ctxWith(await fakeApi(later), START, [], { state, observed: changed }), { ...fast, geo: storeOf() });
    expect(changed.filter((o) => o.changed).map((o) => o.key)).toEqual(["line-009040"]);
  });

  it("a later date is compared with the weekly mask: a run missing though its line is offered is a warning", async () => {
    const warnings: string[] = [];
    const runs = RUNS();
    runs.push({ code: "TFCA101", line: "009040", trip: "Tafraout-Casablanca", days: ALL, calls: [["Tafraout", null, 780], ["Tiznit", 900, 915], ["Agadir", 1020, 1035], ["Marrakech", 1245, 1250], ["Casablanca Maarif", 1450, 1460], ["Casablanca FAR", 1475, null]] });
    runs[1]!.except = dateRange("2026-11-20", "2026-12-31"); // TFCA100 stops running from 11-20 on (the spot checks are 11-25 and 12-23)
    await run(runs, {}, {}, undefined, warnings);
    expect(warnings.join("\n")).toMatch(/does not predict 2026-11-25: 1 of \d+ runs expected but not found though their line is offered \(TFCA100/);
    // a line that is not offered that far ahead at all is not a difference (some lines are sold 30 days ahead, others 60)
    const quiet: string[] = [];
    const runs2 = RUNS();
    runs2[1]!.except = dateRange("2026-12-01", "2026-12-31");
    await run(runs2, {}, {}, undefined, quiet);
    expect(quiet.filter((w) => /does not predict/.test(w))).toEqual([]);
  });

  it("the generator and its feed are registered; the geocode file is reviewed, complete and in Morocco", async () => {
    const set = await loadGeneratorFiles(GENERATORS_DIR);
    expect([...set.generators.keys()]).toContain("ma-ctm");
    expect(set.generators.get("ma-ctm")).toBe(ctm);
    const cfg = await loadFeedsConfig(join(here, "../feeds.json"));
    const f = cfg.feeds.find((x) => x.id === "ma-ctm")!;
    expect(f).toMatchObject({ country: "MA", tier: "core", keep: ["coach"], sources: [{ generated: "ma-ctm" }], options: { allCoach: true }, timetableUrl: "https://booking.ctm.ma/" });
    expect(cfg.feeds.at(-1)!.id).toBe("ma-ctm"); // last: a slow generator does not hold up the feeds behind it
    const store = await GeocodeStore.load("ma-ctm");
    for (const [k, e] of Object.entries(store.file.entries)) {
      expect(e.checked, k).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(G.inBox(e.lat, e.lon), k).toBe(true);
    }
    // the stops of the stop list that have no coordinates have a reviewed entry
    const net = G.parseNetwork(await read("filtered-stops.json"), 5);
    for (const n of Object.keys(NEEDS)) expect(store.lookup(n)?.checked, n).toBeTruthy();
    expect(net.stopByName.get("Beni Mellal Supratours")!.coord).toBeNull();
    for (const n of ["Ait Ourir", "Boufakrane", "Tchika"]) expect(store.lookup(n)?.checked, n).toBeTruthy();
  });

  it("run through the registry: validated, written as a zip with the retrieval time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "etbm-ctm-"));
    try {
      const api = await fakeApi();
      const g = { ...ctm, generate: (ctx: GeneratorContext) => G.generateFrom({ ...ctx, fetchText: api.fetchText }, { ...fast, geo: storeOf() }) };
      const dest = join(dir, "ma-ctm.zip");
      const { report } = await runGenerator(g, "ma-ctm", { userAgent: "t", startDate: START, days: DAYS, dest, tmpDir: dir, log: () => {}, warn: () => {} });
      expect(report.ok).toBe(true);
      expect(report.counts).toMatchObject({ trips: 6, routes: 6 });
      expect(report.pages?.length).toBe(3);
      expect(existsSync(dest)).toBe(true);
      expect(readRetrievedAt(dest)).toBe(report.retrievedAt);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
