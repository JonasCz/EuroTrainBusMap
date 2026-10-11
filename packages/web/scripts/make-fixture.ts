/**
 * Generates a small, schema-conformant demo dataset into public/data/ so the
 * frontend can be developed before the real ETL output exists.
 *
 *   node --experimental-strip-types scripts/make-fixture.ts [--no-basemap]
 *
 * The timetable is invented (but plausible); coordinates are real-ish.
 * Basemap layers come from Natural Earth via scripts/basemap.ts.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Cat,
  Flag,
  SCHEMA_VERSION,
  type AttributionFile,
  type CalendarsFile,
  type CatBit,
  type City,
  type CityFile,
  type Corridor,
  type Manifest,
  type NetworkFile,
  type Pattern,
  type Route,
  type Station,
  type Trip,
} from "../../shared/src/index.ts";
import { buildBasemap } from "./basemap.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "public", "data");
const BUILD = "fixture";
const DAYS = 60;

// ---------------------------------------------------------------------------
// Cities & stations

const TZ = [
  "Europe/Berlin",
  "Europe/Prague",
  "Europe/Vienna",
  "Europe/Zurich",
  "Europe/Paris",
  "Europe/Brussels",
  "Europe/Amsterdam",
  "Europe/Copenhagen",
  "Europe/Warsaw",
  "Europe/Budapest",
  "Europe/Rome",
  "Europe/Istanbul",
  "Europe/London",
];

type StationDef = [name: string, lon: number, lat: number];
interface CityDef {
  name: string;
  country: string;
  tz: string;
  pop: number;
  stations: StationDef[];
}

const CITY_DEFS: CityDef[] = [
  { name: "Berlin", country: "DE", tz: "Europe/Berlin", pop: 3_850_000, stations: [
    ["Berlin Hbf", 13.3695, 52.5251], ["Berlin Südkreuz", 13.3655, 52.4752], ["Berlin Gesundbrunnen", 13.3884, 52.5486],
    ["Berlin Ostbahnhof", 13.4344, 52.5104], ["Berlin ZOB", 13.2793, 52.5073]] },
  { name: "Hamburg", country: "DE", tz: "Europe/Berlin", pop: 1_900_000, stations: [
    ["Hamburg Hbf", 10.0067, 53.553], ["Hamburg-Harburg", 9.9917, 53.4563], ["Hamburg Dammtor", 9.9897, 53.5606], ["Hamburg ZOB", 10.0118, 53.5521]] },
  { name: "München", country: "DE", tz: "Europe/Berlin", pop: 1_510_000, stations: [
    ["München Hbf", 11.5583, 48.1402], ["München Ost", 11.6046, 48.1272], ["München-Pasing", 11.4613, 48.1497], ["München ZOB", 11.55, 48.1426]] },
  { name: "Frankfurt am Main", country: "DE", tz: "Europe/Berlin", pop: 770_000, stations: [
    ["Frankfurt (Main) Hbf", 8.6625, 50.107], ["Frankfurt Flughafen Fernbf", 8.5703, 50.053], ["Frankfurt (Main) Süd", 8.6869, 50.0993]] },
  { name: "Köln", country: "DE", tz: "Europe/Berlin", pop: 1_080_000, stations: [["Köln Hbf", 6.9583, 50.943], ["Köln Messe/Deutz", 6.9746, 50.9409]] },
  { name: "Leipzig", country: "DE", tz: "Europe/Berlin", pop: 620_000, stations: [["Leipzig Hbf", 12.3821, 51.3455], ["Leipzig Hbf ZOB", 12.387, 51.3466]] },
  { name: "Dresden", country: "DE", tz: "Europe/Berlin", pop: 560_000, stations: [["Dresden Hbf", 13.7323, 51.0405], ["Dresden-Neustadt", 13.7419, 51.0657]] },
  { name: "Praha", country: "CZ", tz: "Europe/Prague", pop: 1_350_000, stations: [
    ["Praha hl.n.", 14.4353, 50.0831], ["Praha-Holešovice", 14.44, 50.11], ["Praha ÚAN Florenc", 14.4398, 50.0898]] },
  { name: "Wien", country: "AT", tz: "Europe/Vienna", pop: 2_000_000, stations: [
    ["Wien Hbf", 16.3757, 48.1852], ["Wien Meidling", 16.3334, 48.1745], ["Wien Westbahnhof", 16.3375, 48.1966], ["Wien Erdberg (VIB)", 16.414, 48.1913]] },
  { name: "Zürich", country: "CH", tz: "Europe/Zurich", pop: 440_000, stations: [["Zürich HB", 8.5402, 47.3782], ["Zürich Flughafen", 8.5622, 47.4504], ["Zürich Sihlquai", 8.5365, 47.3815]] },
  { name: "Basel", country: "CH", tz: "Europe/Zurich", pop: 180_000, stations: [["Basel SBB", 7.5895, 47.5476], ["Basel Bad Bf", 7.6074, 47.5671]] },
  { name: "Paris", country: "FR", tz: "Europe/Paris", pop: 11_000_000, stations: [
    ["Paris Gare de Lyon", 2.3733, 48.8443], ["Paris Gare du Nord", 2.3553, 48.8809], ["Paris Gare de l'Est", 2.359, 48.8768], ["Paris Bercy Seine", 2.3825, 48.838]] },
  { name: "Lyon", country: "FR", tz: "Europe/Paris", pop: 1_400_000, stations: [["Lyon Part-Dieu", 4.8594, 45.7606], ["Lyon Perrache", 4.826, 45.7485]] },
  { name: "Bruxelles / Brussel", country: "BE", tz: "Europe/Brussels", pop: 1_220_000, stations: [
    ["Bruxelles-Midi / Brussel-Zuid", 4.3357, 50.8357], ["Bruxelles-Central", 4.357, 50.8454], ["Bruxelles-Nord / Brussel-Noord", 4.3609, 50.8603]] },
  { name: "Amsterdam", country: "NL", tz: "Europe/Amsterdam", pop: 920_000, stations: [
    ["Amsterdam Centraal", 4.9003, 52.3789], ["Amsterdam Zuid", 4.8719, 52.3389], ["Amsterdam Sloterdijk", 4.8378, 52.3889]] },
  { name: "København", country: "DK", tz: "Europe/Copenhagen", pop: 1_350_000, stations: [["København H", 12.565, 55.6727], ["Nørreport", 12.5714, 55.6833]] },
  { name: "Warszawa", country: "PL", tz: "Europe/Warsaw", pop: 1_860_000, stations: [
    ["Warszawa Centralna", 21.0031, 52.2287], ["Warszawa Wschodnia", 21.0532, 52.2516], ["Warszawa Zachodnia", 20.9616, 52.22]] },
  { name: "Kraków", country: "PL", tz: "Europe/Warsaw", pop: 800_000, stations: [["Kraków Główny", 19.9476, 50.0675], ["Kraków MDA", 19.9502, 50.0668]] },
  { name: "Budapest", country: "HU", tz: "Europe/Budapest", pop: 1_700_000, stations: [
    ["Budapest-Keleti", 19.0839, 47.5003], ["Budapest-Déli", 19.0248, 47.5], ["Budapest-Kelenföld", 19.0201, 47.4646], ["Budapest Népliget", 19.096, 47.476]] },
  { name: "Milano", country: "IT", tz: "Europe/Rome", pop: 1_370_000, stations: [
    ["Milano Centrale", 9.2048, 45.4864], ["Milano Porta Garibaldi", 9.1873, 45.4848], ["Milano Lampugnano", 9.105, 45.489]] },
  { name: "İstanbul", country: "TR", tz: "Europe/Istanbul", pop: 15_600_000, stations: [
    ["İstanbul Söğütlüçeşme", 29.0379, 40.9928], ["İstanbul Pendik", 29.2342, 40.879], ["İstanbul Halkalı", 28.766, 41.018], ["Büyük İstanbul Otogarı", 28.8946, 41.0393]] },
  { name: "Ankara", country: "TR", tz: "Europe/Istanbul", pop: 5_700_000, stations: [["Ankara Garı", 32.8467, 39.9365], ["Ankara AŞTİ", 32.8128, 39.918]] },
  { name: "London", country: "GB", tz: "Europe/London", pop: 9_000_000, stations: [
    ["London St Pancras International", -0.1263, 51.5317], ["London Victoria Coach Station", -0.149, 51.4925], ["London Euston", -0.1335, 51.5282]] },
  { name: "Potsdam", country: "DE", tz: "Europe/Berlin", pop: 185_000, stations: [["Potsdam Hbf", 13.0668, 52.3917], ["Potsdam Charlottenhof", 13.0378, 52.3922]] },
  { name: "Hannover", country: "DE", tz: "Europe/Berlin", pop: 540_000, stations: [["Hannover Hbf", 9.7413, 52.3767], ["Hannover ZOB", 9.743, 52.379]] },
  // smaller places on the way
  { name: "Erfurt", country: "DE", tz: "Europe/Berlin", pop: 215_000, stations: [["Erfurt Hbf", 11.0383, 50.9725]] },
  { name: "Nürnberg", country: "DE", tz: "Europe/Berlin", pop: 520_000, stations: [["Nürnberg Hbf", 11.0826, 49.4458]] },
  { name: "Brno", country: "CZ", tz: "Europe/Prague", pop: 380_000, stations: [["Brno hl.n.", 16.6127, 49.1904], ["Brno ÚAN Zvonařka", 16.6178, 49.1855]] },
  { name: "Győr", country: "HU", tz: "Europe/Budapest", pop: 130_000, stations: [["Győr", 17.6324, 47.6814]] },
  { name: "Linz", country: "AT", tz: "Europe/Vienna", pop: 210_000, stations: [["Linz Hbf", 14.2913, 48.29]] },
  { name: "Salzburg", country: "AT", tz: "Europe/Vienna", pop: 155_000, stations: [["Salzburg Hbf", 13.0458, 47.8128]] },
  { name: "Lille", country: "FR", tz: "Europe/Paris", pop: 1_000_000, stations: [["Lille Europe", 3.0753, 50.6393], ["Lille Flandres", 3.0707, 50.6365]] },
  { name: "Torino", country: "IT", tz: "Europe/Rome", pop: 850_000, stations: [["Torino Porta Susa", 7.6653, 45.0718]] },
  { name: "Poznań", country: "PL", tz: "Europe/Warsaw", pop: 540_000, stations: [["Poznań Główny", 16.9122, 52.4019]] },
  { name: "Eskişehir", country: "TR", tz: "Europe/Istanbul", pop: 900_000, stations: [["Eskişehir", 30.5175, 39.7766]] },
  { name: "Magdeburg", country: "DE", tz: "Europe/Berlin", pop: 240_000, stations: [["Magdeburg Hbf", 11.6271, 52.1302]] },
  { name: "Brandenburg an der Havel", country: "DE", tz: "Europe/Berlin", pop: 73_000, stations: [["Brandenburg Hbf", 12.5664, 52.4006]] },
  { name: "Werder (Havel)", country: "DE", tz: "Europe/Berlin", pop: 27_000, stations: [["Werder (Havel) Bf", 12.9339, 52.3787]] },
  { name: "Zakopane", country: "PL", tz: "Europe/Warsaw", pop: 27_000, stations: [["Zakopane Dworzec Autobusowy", 19.9575, 49.2997]] },
  { name: "Wrocław", country: "PL", tz: "Europe/Warsaw", pop: 670_000, stations: [["Wrocław Główny", 17.0365, 51.0981]] },
];

const stations: Station[] = [];
const stationByName = new Map<string, number>();
const cities: City[] = CITY_DEFS.map((d, id) => {
  const ids = d.stations.map(([name, lon, lat]) => {
    const sid = stations.length;
    stations.push({ id: sid, city: id, name, lon, lat, cats: 0 });
    if (stationByName.has(name)) throw new Error(`dup station ${name}`);
    stationByName.set(name, sid);
    return sid;
  });
  const main = d.stations[0]!;
  return {
    id,
    name: d.name,
    country: d.country,
    lon: main[1],
    lat: main[2],
    population: d.pop,
    importance: 0,
    cats: 0,
    stations: ids,
    tz: TZ.indexOf(d.tz),
  };
});
for (const c of cities) if (c.tz < 0) throw new Error(`tz ${c.name}`);

const st = (name: string): number => {
  const id = stationByName.get(name);
  if (id === undefined) throw new Error(`unknown station ${name}`);
  return id;
};
const cityOf = (sid: number) => stations[sid]!.city;
const cityId = (name: string) => {
  const c = cities.find((x) => x.name === name);
  if (!c) throw new Error(`unknown city ${name}`);
  return c.id;
};

// ---------------------------------------------------------------------------
// Calendars

const today = new Date();
const startUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 3);
const startDate = new Date(startUtc).toISOString().slice(0, 10);
const weekdayOf = (day: number) => new Date(startUtc + day * 86400000).getUTCDay(); // 0 = Sun

function mask(pred: (day: number, wd: number) => boolean): string {
  const bytes = new Uint8Array(Math.ceil(DAYS / 8));
  for (let d = 0; d < DAYS; d++) if (pred(d, weekdayOf(d))) bytes[d >> 3]! |= 1 << (d & 7);
  return Buffer.from(bytes).toString("base64");
}
const CAL = {
  daily: 0,
  monFri: 1,
  weekend: 2,
  friSun: 3,
  worksGap: 4,
  monSat: 5,
  satOnly: 6,
  seasonal: 7,
  notSat: 8,
};
const calendars: CalendarsFile = {
  startDate,
  days: DAYS,
  masks: [
    mask(() => true),
    mask((_, wd) => wd >= 1 && wd <= 5),
    mask((_, wd) => wd === 0 || wd === 6),
    mask((_, wd) => wd === 5 || wd === 0),
    mask((d) => d < 6 || d > 9), // engineering works: no service on days 6–9
    mask((_, wd) => wd !== 0),
    mask((_, wd) => wd === 6),
    mask((d) => d >= 20),
    mask((_, wd) => wd !== 6),
  ],
};

// ---------------------------------------------------------------------------
// Routes & lines

const routes: Route[] = [];
function route(name: string, agency: string, cat: CatBit, flags = 0, color?: string): number {
  routes.push({ name, agency, cat, flags, ...(color ? { color } : {}) });
  return routes.length - 1;
}

interface LineDef {
  route: number;
  tz: string;
  /** [station, run minutes from previous stop] */
  stops: [string, number][];
  dwell?: number;
  fwd: { starts: number[]; cal: number | ((i: number) => number); num?: (i: number) => string };
  rev?: { starts: number[]; cal: number | ((i: number) => number); num?: (i: number) => string };
  headsign?: [string, string];
}

const every = (from: string, to: string, step: number): number[] => {
  const p = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return h! * 60 + m!;
  };
  const out: number[] = [];
  for (let t = p(from); t <= p(to); t += step) out.push(t);
  return out;
};
const at = (...times: string[]) =>
  times.map((s) => {
    const [h, m] = s.split(":").map(Number);
    return h! * 60 + m!;
  });

const lines: LineDef[] = [];
const L = (d: LineDef) => lines.push(d);

const R = {
  ICE: route("ICE", "DB Fernverkehr", Cat.LongDistance, 0, "EC0016"),
  IC: route("IC", "DB Fernverkehr", Cat.LongDistance, 0, "EC0016"),
  EC: route("EC", "České dráhy", Cat.LongDistance),
  RJ: route("RJ", "ÖBB", Cat.LongDistance, 0, "C3002F"),
  TGV: route("TGV INOUI", "SNCF Voyageurs", Cat.LongDistance),
  FR: route("Frecciarossa", "Trenitalia France", Cat.LongDistance, 0, "C8102E"),
  EST: route("Eurostar", "Eurostar", Cat.LongDistance, 0, "FFD500"),
  YHT: route("YHT", "TCDD Taşımacılık", Cat.LongDistance),
  ES: route("European Sleeper", "European Sleeper", Cat.LongDistance, Flag.Night),
  EIP: route("EIP", "PKP Intercity", Cat.LongDistance),
  ECPL: route("EC Berlin–Warszawa-Express", "PKP Intercity", Cat.LongDistance),
  ECCH: route("EC", "SBB", Cat.LongDistance),
  ICEDK: route("ICE-L", "DB Fernverkehr / DSB", Cat.LongDistance),
  RE1: route("RE1", "ODEG", Cat.Regional, Flag.DTicket),
  RE50: route("RE50", "DB Regio", Cat.Regional, Flag.DTicket),
  ME: route("RE3 metronom", "metronom", Cat.Regional, Flag.DTicket),
  IR: route("IR36", "SBB", Cat.Regional),
  OSPL: route("REGIO", "Koleje Śląskie", Cat.Regional),
  FLIX: route("FlixBus", "FlixBus", Cat.Coach, 0, "73D700"),
  KK: route("Kamil Koç", "Kamil Koç", Cat.Coach),
  BB: route("BlaBlaCar Bus", "BlaBlaCar", Cat.Coach),
  B631: route("Bus 631", "Havelbus", Cat.Bus, Flag.DTicket),
  SZW: route("Szwagropol", "Szwagropol", Cat.Bus),
};

// Long distance -------------------------------------------------------------
L({ route: R.ICE, tz: "Europe/Berlin",
  stops: [["Hamburg Hbf", 0], ["Berlin Hbf", 104], ["Berlin Südkreuz", 8], ["Leipzig Hbf", 66], ["Erfurt Hbf", 43], ["Nürnberg Hbf", 64], ["München Hbf", 66]],
  fwd: { starts: every("05:24", "19:24", 120), cal: (i) => (i === 0 ? CAL.monFri : CAL.daily), num: (i) => String(1001 + 2 * i) },
  rev: { starts: every("05:55", "19:55", 120), cal: (i) => (i === 0 ? CAL.monSat : CAL.daily), num: (i) => String(1000 + 2 * i) } });
L({ route: R.ICE, tz: "Europe/Berlin",
  stops: [["Köln Hbf", 0], ["Frankfurt Flughafen Fernbf", 56], ["Frankfurt (Main) Hbf", 13], ["Nürnberg Hbf", 124], ["München Hbf", 66]],
  fwd: { starts: every("06:10", "18:10", 120), cal: CAL.daily, num: (i) => String(521 + 2 * i) },
  rev: { starts: every("06:16", "18:16", 120), cal: CAL.daily, num: (i) => String(520 + 2 * i) } });
L({ route: R.ICE, tz: "Europe/Berlin",
  stops: [["Berlin Ostbahnhof", 0], ["Berlin Hbf", 8], ["Hannover Hbf", 98], ["Köln Hbf", 160]],
  fwd: { starts: every("05:49", "19:49", 60), cal: CAL.daily, num: (i) => String(841 + 2 * i) },
  rev: { starts: every("05:48", "19:48", 60), cal: CAL.daily, num: (i) => String(840 + 2 * i) } });
L({ route: R.ICE, tz: "Europe/Berlin",
  stops: [["Hamburg Hbf", 0], ["Hannover Hbf", 78], ["Frankfurt (Main) Hbf", 140], ["Basel Bad Bf", 162], ["Basel SBB", 7], ["Zürich HB", 56]],
  fwd: { starts: every("06:01", "16:01", 120), cal: CAL.daily, num: (i) => String(71 + 2 * i) },
  rev: { starts: every("06:33", "16:33", 120), cal: CAL.daily, num: (i) => String(70 + 2 * i) } });
L({ route: R.ICE, tz: "Europe/Berlin",
  stops: [["Amsterdam Centraal", 0], ["Köln Hbf", 160], ["Frankfurt Flughafen Fernbf", 56], ["Frankfurt (Main) Hbf", 13]],
  fwd: { starts: every("06:38", "18:38", 120), cal: CAL.daily, num: (i) => String(121 + 2 * i) },
  rev: { starts: every("06:29", "18:29", 120), cal: CAL.daily, num: (i) => String(120 + 2 * i) } });
L({ route: R.EC, tz: "Europe/Berlin",
  stops: [["Hamburg Hbf", 0], ["Berlin Hbf", 110], ["Dresden Hbf", 116], ["Praha hl.n.", 140], ["Brno hl.n.", 165], ["Wien Hbf", 95]],
  fwd: { starts: every("04:46", "14:46", 120), cal: CAL.daily, num: (i) => String(171 + 2 * i) },
  rev: { starts: every("06:10", "16:10", 120), cal: CAL.daily, num: (i) => String(170 + 2 * i) },
  headsign: ["Wien Hbf", "Hamburg-Altona"] });
L({ route: R.RJ, tz: "Europe/Vienna",
  stops: [["München Hbf", 0], ["Salzburg Hbf", 88], ["Linz Hbf", 72], ["Wien Meidling", 72], ["Wien Hbf", 7], ["Győr", 64], ["Budapest-Keleti", 82]],
  fwd: { starts: every("05:27", "17:27", 120), cal: CAL.worksGap, num: (i) => String(41 + 2 * i) },
  rev: { starts: every("05:40", "17:40", 120), cal: CAL.worksGap, num: (i) => String(40 + 2 * i) } });
L({ route: R.RJ, tz: "Europe/Vienna",
  stops: [["Wien Hbf", 0], ["Győr", 64], ["Budapest-Kelenföld", 70], ["Budapest-Keleti", 12]],
  fwd: { starts: every("06:42", "20:42", 120), cal: CAL.daily, num: (i) => String(361 + 2 * i) },
  rev: { starts: every("07:10", "21:10", 120), cal: CAL.daily, num: (i) => String(360 + 2 * i) } });
L({ route: R.TGV, tz: "Europe/Paris",
  stops: [["Paris Gare de Lyon", 0], ["Lyon Part-Dieu", 116]],
  fwd: { starts: [...every("06:00", "21:00", 60)], cal: (i) => (i % 3 === 2 ? CAL.monFri : CAL.daily), num: (i) => String(6601 + 2 * i) },
  rev: { starts: [...every("05:30", "20:30", 60)], cal: (i) => (i % 3 === 2 ? CAL.monFri : CAL.daily), num: (i) => String(6600 + 2 * i) } });
L({ route: R.FR, tz: "Europe/Paris",
  stops: [["Paris Gare de Lyon", 0], ["Lyon Part-Dieu", 120], ["Torino Porta Susa", 225], ["Milano Centrale", 60]],
  fwd: { starts: at("06:24", "14:24"), cal: CAL.daily, num: (i) => String(9241 + 2 * i) },
  rev: { starts: at("06:25", "15:25"), cal: CAL.daily, num: (i) => String(9240 + 2 * i) } });
L({ route: R.EST, tz: "Europe/London",
  stops: [["London St Pancras International", 0], ["Paris Gare du Nord", 136]],
  fwd: { starts: every("07:01", "20:01", 60), cal: CAL.daily, num: (i) => String(9007 + 4 * i) },
  rev: { starts: every("06:13", "19:13", 60), cal: CAL.daily, num: (i) => String(9008 + 4 * i) } });
L({ route: R.EST, tz: "Europe/London",
  stops: [["London St Pancras International", 0], ["Lille Europe", 82], ["Bruxelles-Midi / Brussel-Zuid", 35], ["Amsterdam Centraal", 110]],
  fwd: { starts: at("08:16", "11:04", "14:04", "17:04"), cal: CAL.daily, num: (i) => String(9114 + 2 * i) },
  rev: { starts: at("07:00", "10:00", "13:30", "16:00"), cal: CAL.daily, num: (i) => String(9115 + 2 * i) } });
L({ route: R.EST, tz: "Europe/Paris",
  stops: [["Paris Gare du Nord", 0], ["Bruxelles-Midi / Brussel-Zuid", 82], ["Köln Hbf", 113]],
  fwd: { starts: every("06:25", "20:25", 120), cal: CAL.daily, num: (i) => String(9311 + 2 * i) },
  rev: { starts: every("06:44", "20:44", 120), cal: CAL.daily, num: (i) => String(9310 + 2 * i) } });
L({ route: R.YHT, tz: "Europe/Istanbul",
  stops: [["İstanbul Halkalı", 0], ["İstanbul Söğütlüçeşme", 50], ["İstanbul Pendik", 26], ["Eskişehir", 135], ["Ankara Garı", 92]],
  fwd: { starts: at("06:00", "08:40", "11:20", "13:30", "16:10", "18:40", "21:00"), cal: CAL.daily, num: (i) => String(81001 + 2 * i) },
  rev: { starts: at("06:00", "08:35", "10:50", "13:30", "15:45", "18:10", "20:45"), cal: CAL.daily, num: (i) => String(81002 + 2 * i) } });
L({ route: R.ES, tz: "Europe/Brussels", dwell: 5,
  stops: [["Bruxelles-Midi / Brussel-Zuid", 0], ["Amsterdam Centraal", 160], ["Hannover Hbf", 270], ["Berlin Hbf", 230], ["Dresden Hbf", 170], ["Praha hl.n.", 160]],
  fwd: { starts: at("19:22"), cal: CAL.friSun, num: () => "453" },
  rev: { starts: at("18:04"), cal: CAL.friSun, num: () => "452" },
  headsign: ["Praha hl.n.", "Bruxelles-Midi"] });
L({ route: R.ECPL, tz: "Europe/Berlin",
  stops: [["Berlin Hbf", 0], ["Berlin Ostbahnhof", 8], ["Poznań Główny", 160], ["Warszawa Zachodnia", 155], ["Warszawa Centralna", 7], ["Warszawa Wschodnia", 9]],
  fwd: { starts: at("06:37", "10:37", "14:37", "18:37"), cal: CAL.daily, num: (i) => String(41 + 2 * i) },
  rev: { starts: at("06:10", "10:10", "14:10", "17:10"), cal: CAL.daily, num: (i) => String(40 + 2 * i) },
  headsign: ["Warszawa Wschodnia", "Berlin Hbf"] });
L({ route: R.EIP, tz: "Europe/Warsaw",
  stops: [["Warszawa Wschodnia", 0], ["Warszawa Centralna", 8], ["Warszawa Zachodnia", 6], ["Kraków Główny", 140]],
  fwd: { starts: every("05:50", "20:50", 60), cal: (i) => (i % 4 === 3 ? CAL.notSat : CAL.daily), num: (i) => String(1301 + 2 * i) },
  rev: { starts: every("05:30", "20:30", 60), cal: CAL.daily, num: (i) => String(1300 + 2 * i) } });
L({ route: R.EIP, tz: "Europe/Warsaw",
  stops: [["Warszawa Centralna", 0], ["Wrocław Główny", 225]],
  fwd: { starts: at("06:15", "10:15", "15:15", "18:15"), cal: CAL.daily, num: (i) => String(6501 + 2 * i) },
  rev: { starts: at("05:58", "09:58", "14:58", "17:58"), cal: CAL.daily, num: (i) => String(6500 + 2 * i) } });
L({ route: R.ECCH, tz: "Europe/Zurich",
  stops: [["Zürich HB", 0], ["Milano Centrale", 197]],
  fwd: { starts: every("06:33", "20:33", 120), cal: CAL.daily, num: (i) => String(311 + 2 * i) },
  rev: { starts: every("07:10", "19:10", 120), cal: CAL.daily, num: (i) => String(310 + 2 * i) } });
L({ route: R.ICEDK, tz: "Europe/Copenhagen",
  stops: [["Hamburg Hbf", 0], ["København H", 275]],
  fwd: { starts: at("07:21", "11:21", "15:21"), cal: CAL.daily, num: (i) => String(380 + 2 * i) },
  rev: { starts: at("06:57", "10:57", "16:57"), cal: CAL.daily, num: (i) => String(381 + 2 * i) } });

// Regional ----------------------------------------------------------------------
L({ route: R.RE1, tz: "Europe/Berlin",
  stops: [["Berlin Ostbahnhof", 0], ["Berlin Hbf", 9], ["Potsdam Hbf", 24], ["Brandenburg Hbf", 22], ["Magdeburg Hbf", 54]],
  fwd: { starts: every("04:52", "23:22", 30), cal: (i) => (i % 2 ? CAL.monFri : CAL.daily), num: (i) => String(3101 + 2 * i) },
  rev: { starts: every("04:31", "22:31", 30), cal: (i) => (i % 2 ? CAL.monFri : CAL.daily), num: (i) => String(3100 + 2 * i) } });
L({ route: R.RE1, tz: "Europe/Berlin",
  stops: [["Berlin Ostbahnhof", 0], ["Berlin Hbf", 9], ["Potsdam Hbf", 24]],
  fwd: { starts: every("23:52", "25:22", 30), cal: CAL.daily, num: (i) => String(3201 + 2 * i) },
  rev: { starts: every("23:31", "25:01", 30), cal: CAL.daily, num: (i) => String(3200 + 2 * i) } });
L({ route: R.RE50, tz: "Europe/Berlin",
  stops: [["Leipzig Hbf", 0], ["Dresden Hbf", 98], ["Dresden-Neustadt", 6]],
  fwd: { starts: every("04:35", "22:35", 60), cal: CAL.daily, num: (i) => String(16001 + 2 * i) },
  rev: { starts: every("04:10", "22:10", 60), cal: CAL.daily, num: (i) => String(16000 + 2 * i) } });
L({ route: R.ME, tz: "Europe/Berlin",
  stops: [["Hamburg Hbf", 0], ["Hamburg-Harburg", 12], ["Hannover Hbf", 125]],
  fwd: { starts: every("05:15", "21:15", 60), cal: CAL.daily, num: (i) => String(82101 + 2 * i) },
  rev: { starts: every("04:39", "21:39", 60), cal: CAL.daily, num: (i) => String(82100 + 2 * i) } });
L({ route: R.IR, tz: "Europe/Zurich",
  stops: [["Basel SBB", 0], ["Zürich HB", 63], ["Zürich Flughafen", 12]],
  fwd: { starts: every("05:37", "23:37", 30), cal: CAL.daily, num: (i) => String(1951 + 2 * i) },
  rev: { starts: every("05:47", "23:17", 30), cal: CAL.daily, num: (i) => String(1950 + 2 * i) } });
L({ route: R.OSPL, tz: "Europe/Warsaw",
  stops: [["Kraków Główny", 0], ["Wrocław Główny", 215]],
  fwd: { starts: at("05:10", "09:10", "13:10", "17:10"), cal: CAL.monSat, num: (i) => String(40601 + 2 * i) },
  rev: { starts: at("04:52", "08:52", "12:52", "16:52"), cal: CAL.monSat, num: (i) => String(40600 + 2 * i) } });

// Coach -------------------------------------------------------------------------
L({ route: R.FLIX, tz: "Europe/Berlin", dwell: 10,
  stops: [["Berlin ZOB", 0], ["Dresden Hbf", 150], ["Praha ÚAN Florenc", 140], ["Brno ÚAN Zvonařka", 150], ["Wien Erdberg (VIB)", 125]],
  fwd: { starts: at("06:30", "09:00", "12:30", "16:00", "23:15"), cal: CAL.daily, num: (i) => `N${340 + i}` },
  rev: { starts: at("07:00", "10:30", "14:30", "22:00"), cal: CAL.daily, num: (i) => `N${350 + i}` } });
L({ route: R.FLIX, tz: "Europe/Berlin",
  stops: [["Hamburg ZOB", 0], ["Berlin ZOB", 195]],
  fwd: { starts: every("05:00", "23:00", 90), cal: CAL.daily, num: (i) => `${1500 + i}` },
  rev: { starts: every("05:30", "23:30", 90), cal: CAL.daily, num: (i) => `${1600 + i}` } });
L({ route: R.FLIX, tz: "Europe/Berlin",
  stops: [["München ZOB", 0], ["Praha ÚAN Florenc", 300]],
  fwd: { starts: at("07:15", "12:15", "23:55"), cal: CAL.daily, num: (i) => `N${90 + i}` },
  rev: { starts: at("06:45", "13:45", "23:30"), cal: CAL.daily, num: (i) => `N${95 + i}` } });
L({ route: R.FLIX, tz: "Europe/Vienna",
  stops: [["Wien Erdberg (VIB)", 0], ["Budapest Népliget", 170]],
  fwd: { starts: at("06:00", "10:00", "15:00", "19:30"), cal: CAL.daily, num: (i) => `N${700 + i}` },
  rev: { starts: at("06:30", "11:30", "16:30", "20:30"), cal: CAL.daily, num: (i) => `N${710 + i}` } });
L({ route: R.FLIX, tz: "Europe/Paris",
  stops: [["Paris Bercy Seine", 0], ["Lyon Perrache", 390]],
  fwd: { starts: at("07:30", "13:00", "23:00"), cal: CAL.daily, num: (i) => `N${1700 + i}` },
  rev: { starts: at("08:00", "14:30", "23:30"), cal: CAL.daily, num: (i) => `N${1710 + i}` } });
L({ route: R.FLIX, tz: "Europe/Amsterdam", dwell: 10,
  stops: [["Amsterdam Sloterdijk", 0], ["Bruxelles-Nord / Brussel-Noord", 200], ["Paris Bercy Seine", 240]],
  fwd: { starts: at("07:00", "11:00", "22:30"), cal: CAL.daily, num: (i) => `N${1100 + i}` },
  rev: { starts: at("08:15", "12:00", "23:00"), cal: CAL.daily, num: (i) => `N${1110 + i}` } });
L({ route: R.BB, tz: "Europe/London",
  stops: [["London Victoria Coach Station", 0], ["Paris Bercy Seine", 490]],
  fwd: { starts: at("08:00", "21:30"), cal: CAL.daily, num: (i) => `${2000 + i}` },
  rev: { starts: at("09:00", "22:15"), cal: CAL.daily, num: (i) => `${2010 + i}` } });
L({ route: R.KK, tz: "Europe/Istanbul",
  stops: [["Büyük İstanbul Otogarı", 0], ["Ankara AŞTİ", 330]],
  fwd: { starts: every("06:00", "23:30", 90), cal: CAL.daily },
  rev: { starts: every("06:30", "23:00", 90), cal: CAL.daily } });
L({ route: R.FLIX, tz: "Europe/Warsaw",
  stops: [["Warszawa Zachodnia", 0], ["Kraków MDA", 255]],
  fwd: { starts: at("06:20", "11:20", "17:20"), cal: CAL.seasonal, num: (i) => `${700 + i}` },
  rev: { starts: at("07:10", "12:10", "18:10"), cal: CAL.seasonal, num: (i) => `${710 + i}` } });
L({ route: R.FLIX, tz: "Europe/Rome",
  stops: [["Milano Lampugnano", 0], ["Zürich Sihlquai", 260]],
  fwd: { starts: at("08:30", "15:00"), cal: CAL.weekend, num: (i) => `N${1800 + i}` },
  rev: { starts: at("09:00", "16:00"), cal: CAL.weekend, num: (i) => `N${1810 + i}` } });
L({ route: R.FLIX, tz: "Europe/Berlin",
  stops: [["Köln Hbf", 0], ["Frankfurt (Main) Süd", 150]],
  fwd: { starts: at("07:45", "12:45", "17:45"), cal: CAL.daily, num: (i) => `${100 + i}` },
  rev: { starts: at("08:30", "13:30", "18:30"), cal: CAL.daily, num: (i) => `${110 + i}` } });

// Regional bus --------------------------------------------------------------------
L({ route: R.B631, tz: "Europe/Berlin",
  stops: [["Potsdam Hbf", 0], ["Werder (Havel) Bf", 25]],
  fwd: { starts: every("05:10", "21:10", 60), cal: CAL.monSat },
  rev: { starts: every("05:40", "21:40", 60), cal: CAL.monSat } });
L({ route: R.SZW, tz: "Europe/Warsaw",
  stops: [["Kraków MDA", 0], ["Zakopane Dworzec Autobusowy", 120]],
  fwd: { starts: every("05:00", "21:00", 30), cal: CAL.daily },
  rev: { starts: every("05:15", "21:45", 30), cal: CAL.daily } });

// ---------------------------------------------------------------------------
// Corridor geometry: hand-made waypoints, smoothed with Catmull–Rom.

const VIA: Record<string, [number, number][]> = {
  "Hamburg|Berlin": [[11.0, 53.38], [11.85, 53.0], [12.6, 52.7]],
  "Berlin|Leipzig": [[13.0, 52.1], [12.65, 51.87], [12.4, 51.55]],
  "Leipzig|Erfurt": [[11.95, 51.2], [11.5, 51.12]],
  "Erfurt|Nürnberg": [[11.05, 50.5], [11.0, 50.15], [10.95, 49.8]],
  "Nürnberg|München": [[11.35, 49.0], [11.43, 48.76], [11.5, 48.4]],
  "Köln|Frankfurt am Main": [[7.4, 50.75], [7.85, 50.45], [8.2, 50.2]],
  "Frankfurt am Main|Nürnberg": [[9.15, 49.95], [9.93, 49.8], [10.5, 49.55]],
  "Berlin|Hannover": [[12.3, 52.6], [11.85, 52.6], [10.79, 52.43], [10.2, 52.38]],
  "Hannover|Köln": [[9.1, 52.15], [8.53, 52.02], [7.8, 51.68], [7.46, 51.52], [7.15, 51.25]],
  "Hamburg|Hannover": [[10.2, 53.25], [10.15, 52.9], [10.07, 52.62]],
  "Hannover|Frankfurt am Main": [[9.93, 51.54], [9.48, 51.3], [9.68, 50.55], [9.15, 50.2]],
  "Frankfurt am Main|Basel": [[8.47, 49.48], [8.4, 49.01], [8.0, 48.5], [7.84, 47.99]],
  "Basel|Zürich": [[8.0, 47.47], [8.25, 47.42]],
  "Amsterdam|Köln": [[5.12, 52.09], [5.9, 51.98], [6.5, 51.6], [6.78, 51.22]],
  "Berlin|Dresden": [[13.45, 52.2], [13.55, 51.75], [13.65, 51.35]],
  "Dresden|Praha": [[14.0, 50.92], [14.19, 50.77], [14.04, 50.6], [14.3, 50.3]],
  "Praha|Brno": [[15.2, 50.0], [15.78, 50.03], [16.3, 49.75]],
  "Brno|Wien": [[16.75, 48.85], [16.55, 48.5]],
  "München|Salzburg": [[12.12, 47.86], [12.6, 47.85]],
  "Salzburg|Linz": [[13.45, 48.0], [13.85, 48.15]],
  "Linz|Wien": [[14.9, 48.15], [15.62, 48.2], [16.0, 48.2]],
  "Wien|Győr": [[16.75, 48.05], [17.2, 47.85]],
  "Győr|Budapest": [[18.05, 47.62], [18.4, 47.58], [18.75, 47.5]],
  "Wien|Budapest": [[16.95, 47.95], [17.75, 47.75], [18.45, 47.6]],
  "Paris|Lyon": [[2.9, 48.45], [3.6, 47.6], [4.43, 46.8]],
  "Lyon|Torino": [[5.4, 45.6], [5.92, 45.57], [6.4, 45.25], [6.85, 45.15]],
  "Torino|Milano": [[8.1, 45.25], [8.62, 45.45]],
  "London|Paris": [[0.5, 51.3], [0.87, 51.15], [1.6, 51.0], [2.2, 50.6], [2.6, 49.6]],
  "London|Lille": [[0.5, 51.3], [0.87, 51.15], [1.6, 51.0], [2.4, 50.8]],
  "Lille|Bruxelles / Brussel": [[3.6, 50.65], [4.0, 50.75]],
  "Paris|Bruxelles / Brussel": [[2.6, 49.6], [3.0, 50.2], [3.75, 50.55]],
  "Bruxelles / Brussel|Amsterdam": [[4.42, 51.22], [4.47, 51.92], [4.7, 52.2]],
  "Bruxelles / Brussel|Köln": [[5.0, 50.8], [5.57, 50.62], [6.1, 50.78]],
  "Hamburg|København": [[9.6, 54.5], [9.43, 54.78], [9.47, 55.25], [10.39, 55.4], [11.5, 55.42]],
  "Berlin|Poznań": [[14.55, 52.34], [15.5, 52.3], [16.2, 52.38]],
  "Poznań|Warszawa": [[17.6, 52.25], [18.25, 52.22], [19.4, 52.25], [20.4, 52.22]],
  "Warszawa|Kraków": [[20.55, 51.8], [20.3, 51.2], [20.0, 50.5]],
  "Warszawa|Wrocław": [[20.0, 51.8], [19.45, 51.75], [18.0, 51.4]],
  "Kraków|Wrocław": [[19.0, 50.25], [18.4, 50.55], [17.7, 50.7]],
  "Zürich|Milano": [[8.6, 46.95], [8.65, 46.65], [8.95, 46.2], [8.95, 46.0], [9.08, 45.81]],
  "İstanbul|Eskişehir": [[29.5, 40.8], [29.95, 40.76], [30.25, 40.45], [30.1, 40.0]],
  "Eskişehir|Ankara": [[31.2, 39.6], [31.85, 39.6], [32.4, 39.82]],
  "İstanbul|Ankara": [[29.5, 40.8], [29.95, 40.77], [31.0, 40.8], [31.6, 40.73], [32.2, 40.35]],
  "Berlin|Potsdam": [[13.2, 52.47]],
  "Potsdam|Brandenburg an der Havel": [[12.85, 52.42]],
  "Brandenburg an der Havel|Magdeburg": [[12.25, 52.28], [11.9, 52.2]],
  "Leipzig|Dresden": [[12.8, 51.33], [13.29, 51.3], [13.55, 51.12]],
  "Kraków|Zakopane": [[19.85, 49.85], [19.9, 49.55]],
  "München|Praha": [[12.1, 48.55], [12.15, 49.02], [12.9, 49.45], [13.38, 49.75]],
  "Amsterdam|Bruxelles / Brussel": [[4.6, 52.1], [4.47, 51.92], [4.42, 51.22]],
  "Bruxelles / Brussel|Paris": [[3.75, 50.55], [3.0, 50.2], [2.6, 49.6]],
  "Milano|Zürich": [[9.08, 45.81], [8.95, 46.0], [8.95, 46.2], [8.65, 46.65], [8.6, 46.95]],
};

function catmullRom(pts: [number, number][], seg = 10): [number, number][] {
  if (pts.length < 3) return pts;
  const out: [number, number][] = [];
  const p = [pts[0]!, ...pts, pts[pts.length - 1]!];
  for (let i = 1; i < p.length - 2; i++) {
    const [p0, p1, p2, p3] = [p[i - 1]!, p[i]!, p[i + 1]!, p[i + 2]!];
    for (let k = 0; k < seg; k++) {
      const t = k / seg;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

function corridorGeometry(a: City, b: City): [number, number][] {
  let via = VIA[`${a.name}|${b.name}`];
  if (via === undefined) {
    const r = VIA[`${b.name}|${a.name}`];
    via = r ? [...r].reverse() : undefined;
  }
  if (!via || via.length === 0) {
    // gentle bulge: 6% of the length, perpendicular
    const dx = b.lon - a.lon;
    const dy = b.lat - a.lat;
    via = [[(a.lon + b.lon) / 2 - dy * 0.06, (a.lat + b.lat) / 2 + dx * 0.06]];
  }
  const pts = catmullRom([[a.lon, a.lat], ...via, [b.lon, b.lat]], 8);
  return pts.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]);
}

// ---------------------------------------------------------------------------
// Build patterns, trips and corridors

interface PatternRec extends Pattern {
  tz: number;
}
const patterns: PatternRec[] = [];
const trips: Trip[] = [];
const corridors: Corridor[] = [];
const corridorIdx = new Map<string, number>();

function getCorridor(ca: number, cb: number): number {
  const [a, b] = ca < cb ? [ca, cb] : [cb, ca];
  const key = `${a}-${b}`;
  let id = corridorIdx.get(key);
  if (id === undefined) {
    id = corridors.length;
    corridors.push({ id, a, b, coords: corridorGeometry(cities[a]!, cities[b]!), cats: 0, tpd: {}, snapped: false });
    corridorIdx.set(key, id);
  }
  return id;
}

function addPattern(line: LineDef, stopNames: string[], runs: number[], headsign: string): number {
  const dwell = line.dwell ?? 2;
  const ids = stopNames.map(st);
  const arr: number[] = [];
  const dep: number[] = [];
  let t = 0;
  ids.forEach((_, i) => {
    if (i > 0) t += runs[i]!;
    arr.push(t);
    if (i > 0 && i < ids.length - 1) t += dwell;
    dep.push(t);
  });
  const pcs: number[] = [];
  for (let i = 1; i < ids.length; i++) {
    const c0 = cityOf(ids[i - 1]!);
    const c1 = cityOf(ids[i]!);
    if (c0 !== c1) pcs.push(getCorridor(c0, c1));
  }
  patterns.push({ route: line.route, stations: ids, arr, dep, corridors: pcs, headsign, tz: TZ.indexOf(line.tz) });
  return patterns.length - 1;
}

for (const line of lines) {
  const names = line.stops.map((s) => s[0]);
  const runs = line.stops.map((s) => s[1]);
  const fwdHead = line.headsign?.[0] ?? names[names.length - 1]!;
  const revHead = line.headsign?.[1] ?? names[0]!;
  const pf = addPattern(line, names, runs, fwdHead);
  // reverse: run time to previous stop becomes run time to next
  const rnames = [...names].reverse();
  const rruns = [0, ...runs.slice(1).reverse()];
  const pr = addPattern(line, rnames, rruns, revHead);
  for (const [p, dir] of [[pf, line.fwd], [pr, line.rev]] as const) {
    if (!dir) continue;
    dir.starts.forEach((s, i) => {
      const cal = typeof dir.cal === "function" ? dir.cal(i) : dir.cal;
      const num = dir.num?.(i);
      trips.push(num ? [p, s, cal, num] : [p, s, cal]);
    });
  }
}

// corridor cats / trips-per-day, station & city cats
const calDays = calendars.masks.map((m) => {
  const b = Buffer.from(m, "base64");
  let n = 0;
  for (let d = 0; d < DAYS; d++) if (b[d >> 3]! & (1 << (d & 7))) n++;
  return n;
});
const cityService = new Array(cities.length).fill(0) as number[];
for (const [pi, , cal] of trips) {
  const p = patterns[pi]!;
  const r = routes[p.route]!;
  const perDay = calDays[cal]! / DAYS;
  for (const cid of p.corridors) {
    const c = corridors[cid]!;
    c.cats |= r.cat;
    c.tpd[r.cat] = (c.tpd[r.cat] ?? 0) + perDay;
  }
  for (const s of p.stations) {
    stations[s]!.cats |= r.cat;
    cities[stations[s]!.city]!.cats |= r.cat;
    cityService[stations[s]!.city]! += perDay;
  }
}
for (const c of corridors) for (const k of Object.keys(c.tpd)) c.tpd[Number(k) as CatBit] = Math.round(c.tpd[Number(k) as CatBit]! * 10) / 10;

// Deutschlandticket cats per corridor (proposed schema extension `dtCats`)
const dtCats = new Map<number, number>();
for (const p of patterns) {
  const r = routes[p.route]!;
  if (r.flags & Flag.DTicket) for (const cid of p.corridors) dtCats.set(cid, (dtCats.get(cid) ?? 0) | r.cat);
}

// importance: population + service, normalised to 0..1
const maxPop = Math.log10(Math.max(...cities.map((c) => c.population)));
const maxSvc = Math.log1p(Math.max(...cityService));
for (const c of cities) {
  const p = Math.max(0, (Math.log10(c.population) - 4) / (maxPop - 4));
  const s = Math.log1p(cityService[c.id]!) / maxSvc;
  c.importance = Math.round((0.5 * p + 0.5 * s) ** 1.6 * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// City files

function haversineKm(a: Station, b: Station): number {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

function cityFile(city: City): CityFile {
  const pIdx = patterns.map((p, i) => (p.stations.some((s) => cityOf(s) === city.id) ? i : -1)).filter((i) => i >= 0);
  const routeMap = new Map<number, number>();
  const outRoutes: Route[] = [];
  const pMap = new Map<number, number>();
  const outPatterns: Pattern[] = [];
  const patternTz: number[] = [];
  for (const pi of pIdx) {
    const p = patterns[pi]!;
    let r = routeMap.get(p.route);
    if (r === undefined) {
      r = outRoutes.length;
      outRoutes.push(routes[p.route]!);
      routeMap.set(p.route, r);
    }
    pMap.set(pi, outPatterns.length);
    outPatterns.push({ route: r, stations: p.stations, arr: p.arr, dep: p.dep, corridors: p.corridors, headsign: p.headsign });
    patternTz.push(p.tz);
  }
  const outTrips: Trip[] = trips
    .filter((t) => pMap.has(t[0]))
    .map((t) => {
      const n: Trip = [pMap.get(t[0])!, t[1], t[2]];
      if (t[3] !== undefined) n[3] = t[3];
      return n;
    })
    .sort((a, b) => a[1] - b[1]);
  const transfers: [number, number, number][] = [];
  for (const a of city.stations)
    for (const b of city.stations) {
      if (a === b) continue;
      const km = haversineKm(stations[a]!, stations[b]!);
      const min = km < 1.5 ? Math.round(km * 14 + 4) : Math.round(km * 3 + 14); // walk, or local transit
      transfers.push([a, b, min]);
    }
  return { city: city.id, routes: outRoutes, patterns: outPatterns, patternTz, trips: outTrips, transfers, minTransfer: city.stations.length > 2 ? 8 : 5 };
}

// ---------------------------------------------------------------------------
// Write

const network: NetworkFile = {
  schema: SCHEMA_VERSION,
  build: BUILD,
  timezones: TZ,
  cities,
  stations,
  corridors: corridors.map((c) => ({ ...c, ...(dtCats.has(c.id) ? { dtCats: dtCats.get(c.id) } : {}) })),
};
const manifest: Manifest = {
  schema: SCHEMA_VERSION,
  build: BUILD,
  generatedAt: new Date().toISOString(),
  startDate,
  days: DAYS,
  stats: { cities: cities.length, stations: stations.length, corridors: corridors.length, patterns: patterns.length, trips: trips.length },
};
const attribution: AttributionFile = {
  sources: [
    { name: "Demo timetable (fixture)", license: "CC0-1.0", attribution: "Synthetic data for development, not a real timetable" },
    { name: "Natural Earth", license: "Public domain", url: "https://www.naturalearthdata.com/" },
  ],
};

const dir = join(OUT, BUILD);
await rm(dir, { recursive: true, force: true });
await mkdir(join(dir, "city"), { recursive: true });
const w = (p: string, v: unknown) => writeFile(join(dir, p), JSON.stringify(v));
await w("network.json", network);
await w("calendars.json", calendars);
await w("attribution.json", attribution);
for (const c of cities) await w(`city/${c.id}.json`, cityFile(c));
await writeFile(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`fixture: ${cities.length} cities, ${stations.length} stations, ${corridors.length} corridors, ${patterns.length} patterns, ${trips.length} trips, start ${startDate}`);

if (!process.argv.includes("--no-basemap")) {
  await buildBasemap({ outDir: join(dir, "basemap"), cacheDir: join(HERE, "..", "node_modules", ".cache", "natural-earth") });
}
