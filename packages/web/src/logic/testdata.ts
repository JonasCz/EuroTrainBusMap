/** Small synthetic network used by unit tests. */
import { Cat, type CityFile, type NetworkFile } from "@etbm/shared";
import { buildCalIndex, encodeMask } from "./calendar.ts";
import { buildNetCtx } from "./context.ts";

// 2026-10-05 is a Monday
export const START = "2026-10-05";
const DAYS = 28;
const wd = (i: number) => (1 + i) % 7; // 0 = Sun
const bits = (pred: (i: number) => boolean) => encodeMask(Array.from({ length: DAYS }, (_, i) => pred(i)));

export const calendars = {
  startDate: START,
  days: DAYS,
  masks: [
    bits(() => true), // 0 daily
    bits((i) => wd(i) === 5 || wd(i) === 0), // 1 Fri+Sun
    bits(() => false), // 2 never
    bits((i) => i <= 2), // 3 Oct 5–7 only
    bits((i) => wd(i) >= 1 && wd(i) <= 5), // 4 Mon–Fri
  ],
};

const city = (id: number, name: string, tz: number, stations: number[]) => ({
  id, name, country: "XX", lon: id, lat: id, population: 1000, importance: 0.5, cats: 15, stations, tz,
});
const station = (id: number, c: number, name: string) => ({ id, city: c, name, lon: c, lat: c, cats: 15 });

export const network: NetworkFile = {
  schema: 3,
  build: "test",
  timezones: ["Europe/Berlin", "Europe/Prague", "Europe/Istanbul", "Europe/London"],
  cities: [
    city(0, "Alpha", 0, [0, 1]),
    city(1, "Beta", 1, [2]),
    city(2, "Gamma", 2, [3]),
    city(3, "Delta", 3, [4]),
    city(4, "Eps", 0, [5, 6]),
  ],
  stations: [
    station(0, 0, "Alpha Hbf"),
    station(1, 0, "Alpha Süd"),
    station(2, 1, "Beta hl.n."),
    station(3, 2, "Gamma Gar"),
    station(4, 3, "Delta Intl"),
    station(5, 4, "Eps Bf"),
    station(6, 4, "Eps ZOB"),
  ],
  corridors: [],
};

export const alpha: CityFile = {
  city: 0,
  routes: [
    { name: "ICE", agency: "DB", cat: Cat.LongDistance, flags: 0 },
    { name: "RE", agency: "DB", cat: Cat.Regional, flags: 0 },
    { name: "Flix", agency: "Flix", cat: Cat.Coach, flags: 0 },
  ],
  patterns: [
    // p0 ICE Alpha Hbf → Alpha Süd → Beta → Gamma
    { route: 0, stations: [0, 1, 2, 3], arr: [0, 8, 120, 600], dep: [0, 10, 125, 600], corridors: [9, 10, 11], headsign: "Gamma" },
    // p1 RE Delta → Alpha Hbf → Eps (London tz)
    { route: 1, stations: [4, 0, 5], arr: [0, 100, 160], dep: [0, 105, 160], corridors: [12, 13], headsign: "Eps" },
    // p2 Coach Alpha Süd → Beta (Oct 5–7 only)
    { route: 2, stations: [1, 2], arr: [0, 240], dep: [0, 240], corridors: [10], headsign: "Beta" },
    // p3 RE Alpha Hbf → Eps ZOB
    { route: 1, stations: [0, 6], arr: [0, 30], dep: [0, 30], corridors: [13], headsign: "Eps ZOB" },
    // p4 Coach Alpha → Gamma, never runs
    { route: 2, stations: [0, 3], arr: [0, 900], dep: [0, 900], corridors: [14], headsign: "Gamma" },
  ],
  patternTz: [0, 3, 0, 0, 0],
  trips: [
    [0, 600, 0, "1"], // 0: ICE daily 10:00
    [0, 1430, 1, "3"], // 1: ICE Fri/Sun 23:50
    [1, 1400, 0, "5"], // 2: RE from Delta 23:20 London time
    [2, 600, 3, "N1"], // 3: coach Oct 5–7
    [3, 700, 0, "7"], // 4: RE 11:40
    [3, 1460, 0, "9"], // 5: RE 24:20 (next calendar day)
    [4, 600, 2], // 6: never
  ],
  transfers: [
    [0, 1, 15],
    [1, 0, 15],
  ],
  minTransfer: 5,
};

export const cal = buildCalIndex(calendars);
export const ctx = buildNetCtx(network, cal);
