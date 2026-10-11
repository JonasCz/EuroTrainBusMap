/** Reading the stop-name mapping and exporting review candidates (see core/stopnames.ts). */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { Cat } from "@etbm/shared";
import { FOREIGN_NAME_RE, lookupStopName, type StopNamesFile } from "./core/stopnames.ts";
import { GridIndex, fastDist } from "./util/geo.ts";
import { warn } from "./util/log.ts";

export async function loadStopNames(path: string): Promise<StopNamesFile | null> {
  if (!existsSync(path)) return null;
  try {
    const f = JSON.parse(await readFile(path, "utf8")) as StopNamesFile;
    if (f.version !== 1 || typeof f.entries !== "object") throw new Error("unsupported format");
    return f;
  } catch (e) {
    warn(`stop-names: ignoring ${path}: ${(e as Error).message}`);
    return null;
  }
}

export interface CandidateInput {
  stopRows: { stop_id: string; feed_key: string; agency: string | null; name: string; lon: number; lat: number; cats: number; rail: boolean; n: number }[];
  stopKeys: { key: string; altKey: string }[];
  stopCity: Int32Array;
  stationOf: Int32Array;
  stations: { name: string; lon: number; lat: number; cats: number; rail: boolean; city: number }[];
  cities: { name: string; country: string; population: number }[];
  mapping: StopNamesFile | null;
  minBusCityPop: number;
}

export interface StopCandidate {
  key: string;
  altKey: string;
  feed: string;
  stopId: string;
  name: string;
  operator: string | null;
  cats: number;
  /** trips (stop events) in the build horizon */
  weight: number;
  lon: number;
  lat: number;
  city: string;
  country: string;
  /** name of the station the stop is currently merged into */
  station: string;
  /** stations within 1.5 km, nearest first (other than the stop's own) */
  nearby: { name: string; distM: number; cats: number; rail: boolean }[];
  reason: string;
}

const round5 = (x: number) => Math.round(x * 1e5) / 1e5;

/** Coach feeds that name stops in English / for an international audience (all their stops are reviewed). */
const INTL_COACH_FEED = /^(eu-|gb-flixbus|tr-flixbus|al-showmebus|cy-intercity)/;
/** Where English names are the local names. */
const ENGLISH_COUNTRIES = new Set(["GB", "IE", "MT", "CY"]);
/** Names that refer to a (rail or bus) station, in the main European languages. */
const STATIONISH_RE =
  /\b(hbf|hauptbahnhof|bahnhof|bf|bhf|zob|station|stn|gare|stazione|estaci[oó]n|esta[cç][aã]o|dworzec|n[aá]dra[zž][ií]|stanica|pályaudvar|pu|kolodvor|stanica|stasjon|stationen|asema|jaam|terminal|busterminal|autogara|autobusni|autobusov[eé]|bus)\b/i;

/**
 * Candidates not yet decided in the mapping, one JSON object per line:
 *  - all stops of international coach feeds (FlixBus, BlaBlaCar, …),
 *  - other coach/bus stops with English/exonym names (outside English-speaking countries),
 *  - other coach/bus stops named like a station that lie within 300 m of a rail station.
 */
export async function writeStopCandidates(path: string, inp: CandidateInput): Promise<number> {
  const { stopRows, stopKeys, stopCity, stationOf, stations, cities } = inp;
  const live = stations.map((s, i) => (s.name ? i : -1)).filter((i) => i >= 0);
  const grid = new GridIndex(live.map((i) => stations[i]!.lon), live.map((i) => stations[i]!.lat), 0.05);
  const lines: string[] = [];
  for (let i = 0; i < stopRows.length; i++) {
    const r = stopRows[i]!;
    if (r.rail || !(r.cats & (Cat.Coach | Cat.Bus))) continue;
    const k = stopKeys[i]!;
    if (lookupStopName(inp.mapping, k.key, k.altKey)) continue;
    const city = cities[stopCity[i]!]!;
    const own = stationOf[i]!;
    const near = grid
      .within(r.lon, r.lat, 1500)
      .map((j) => live[j]!)
      .filter((j) => j !== own)
      .map((j) => ({ j, d: fastDist(r.lon, r.lat, stations[j]!.lon, stations[j]!.lat) }))
      .sort((a, b) => a.d - b.d);
    let reason = "";
    if (r.cats & Cat.Coach && INTL_COACH_FEED.test(r.feed_key)) reason = "intl-coach";
    else {
      if (!(r.cats & Cat.Coach) && city.population < inp.minBusCityPop) continue; // bus stops in small places are not shown
      if (!ENGLISH_COUNTRIES.has(city.country) && FOREIGN_NAME_RE.test(r.name)) reason = "foreign-name";
      else if (STATIONISH_RE.test(r.name) && near.some((x) => x.d <= 300 && stations[x.j]!.rail)) reason = "near-rail";
      else continue;
    }
    const c: StopCandidate = {
      key: k.key,
      altKey: k.altKey,
      feed: r.feed_key,
      stopId: r.stop_id,
      name: r.name,
      operator: r.agency,
      cats: r.cats,
      weight: r.n,
      lon: round5(r.lon),
      lat: round5(r.lat),
      city: city.name,
      country: city.country,
      station: stations[own]!.name,
      nearby: near.slice(0, 5).map((x) => ({ name: stations[x.j]!.name, distM: Math.round(x.d), cats: stations[x.j]!.cats, rail: stations[x.j]!.rail })),
      reason,
    };
    lines.push(JSON.stringify(c));
  }
  await writeFile(path, lines.join("\n") + (lines.length ? "\n" : ""));
  return lines.length;
}
