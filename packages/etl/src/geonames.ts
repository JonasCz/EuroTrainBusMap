import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { join } from "node:path";
import { downloadCached, mapLimit } from "./download.ts";
import type { Place } from "./core/cities.ts";
import { log, warn } from "./util/log.ts";

const BASE = "https://download.geonames.org/export/dump/";

/** Countries considered part of the map (Europe incl. TR, UA, Caucasus edge cases excluded). */
export const EURO_COUNTRIES = new Set(
  (
    "AD AL AT BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM TR UA VA XK AX"
  ).split(" "),
);
export const BBOX = { minLon: -25, minLat: 34, maxLon: 45, maxLat: 72 };

const DROP_FCODES = new Set(["PPLH", "PPLQ", "PPLW", "PPLCH", "PPLR", "STLMT"]);

function unzipText(zip: string, entry: string): string {
  return execFileSync("unzip", ["-p", zip, entry], { maxBuffer: 1 << 30 }).toString("utf8");
}

/** R2 asset key of the compact places file. */
export const PLACES_ASSET = "geonames/places-europe.tsv.gz";

/**
 * Compact pruned places file (Europe only, used columns only):
 * id, name, lat, lon, country, population, tz, fcode, admin1..4, altNames ("|"-joined).
 */
export function serializePlaces(places: Place[]): Buffer {
  const clean = (x: string) => x.replace(/[\t\n|]/g, " ");
  const lines = places.map((p) =>
    [p.id, clean(p.name), p.lat, p.lon, p.country, p.population, p.tz, p.fcode, ...p.admin, (p.altNames ?? []).map(clean).join("|")].join("\t"),
  );
  return gzipSync(lines.join("\n") + "\n", { level: 9 });
}

export function parsePlaces(buf: Buffer): Place[] {
  const out: Place[] = [];
  for (const line of gunzipSync(buf).toString("utf8").split("\n")) {
    if (!line) continue;
    const c = line.split("\t");
    const p: Place = {
      id: Number(c[0]),
      name: c[1]!,
      lat: Number(c[2]),
      lon: Number(c[3]),
      country: c[4]!,
      population: Number(c[5]),
      tz: c[6]!,
      fcode: c[7]!,
      admin: [c[8] ?? "", c[9] ?? "", c[10] ?? "", c[11] ?? ""],
    };
    if (c[12]) p.altNames = c[12].split("|");
    out.push(p);
  }
  return out;
}

/**
 * European places with local names. Uses the pre-built asset `<assetsDir>/geonames/places-europe.tsv.gz`
 * when present (downloaded from R2 in CI); otherwise builds it from download.geonames.org and
 * writes it there (so it can be uploaded as the asset).
 */
export async function loadPlaces(cacheDir: string, ua: string, assetsDir?: string): Promise<Place[]> {
  if (assetsDir) {
    const f = join(assetsDir, PLACES_ASSET);
    if (existsSync(f)) {
      try {
        const places = parsePlaces(await readFile(f));
        if (places.length > 10_000) {
          log(`geonames: ${places.length} places from asset ${f}`);
          return places;
        }
        warn(`geonames asset ${f} looks truncated (${places.length} places), rebuilding from source`);
      } catch (e) {
        warn(`geonames asset ${f} unreadable: ${(e as Error).message}`);
      }
    }
  }
  const places = await loadPlacesFromSource(cacheDir, ua);
  if (assetsDir) {
    await mkdir(join(assetsDir, "geonames"), { recursive: true });
    await writeFile(join(assetsDir, PLACES_ASSET), serializePlaces(places));
  }
  return places;
}

async function loadPlacesFromSource(cacheDir: string, ua: string): Promise<Place[]> {
  const dir = join(cacheDir, "geonames");
  await mkdir(dir, { recursive: true });
  const get = (f: string, sub = "") => downloadCached(BASE + sub + f, join(dir, sub.replace(/\//g, "_") + f), ua, { maxAgeH: 24 * 6 });
  await get("cities1000.zip");
  await get("countryInfo.txt");

  const countryLangs = new Map<string, string[]>();
  for (const line of (await readFile(join(dir, "countryInfo.txt"), "utf8")).split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const c = line.split("\t");
    const langs = (c[15] ?? "").split(",").map((l) => l.split("-")[0]!.trim()).filter((l) => /^[a-z]{2,3}$/.test(l));
    countryLangs.set(c[0]!, [...new Set(langs)]);
  }
  countryLangs.set("XK", ["sq", "sr"]);

  const places: Place[] = [];
  const text = unzipText(join(dir, "cities1000.zip"), "cities1000.txt");
  for (const line of text.split("\n")) {
    if (!line) continue;
    const c = line.split("\t");
    const cc = c[8]!;
    if (!EURO_COUNTRIES.has(cc)) continue;
    const lat = Number(c[4]), lon = Number(c[5]);
    if (lon < BBOX.minLon || lon > BBOX.maxLon || lat < BBOX.minLat || lat > BBOX.maxLat) continue;
    const fcode = c[7]!;
    if (DROP_FCODES.has(fcode)) continue;
    places.push({
      id: Number(c[0]),
      name: c[1]!,
      lon,
      lat,
      country: cc,
      population: Number(c[14]) || 0,
      tz: c[17] || "Europe/Berlin",
      fcode,
      admin: [c[10] ?? "", c[11] ?? "", c[12] ?? "", c[13] ?? ""],
    });
  }
  log(`geonames: ${places.length} European places`);

  // Local-language names from per-country alternate name files.
  const byId = new Map(places.map((p, i) => [p.id, i]));
  const countries = [...new Set(places.map((p) => p.country))].sort();
  await mapLimit(countries, 3, async (cc) => {
    try {
      await get(`${cc}.zip`, "alternatenames/");
    } catch (e) {
      warn(`geonames alternatenames ${cc}: ${(e as Error).message}`);
    }
  });
  for (const cc of countries) {
    const zip = join(dir, `alternatenames_${cc}.zip`);
    if (!existsSync(zip)) continue;
    const langs = countryLangs.get(cc) ?? [];
    const pref = new Map<number, { rank: number; name: string }[]>();
    let txt: string;
    try {
      txt = unzipText(zip, `${cc}.txt`);
    } catch {
      continue;
    }
    for (const line of txt.split("\n")) {
      if (!line) continue;
      const c = line.split("\t");
      const gid = Number(c[1]);
      if (!byId.has(gid)) continue;
      const lang = c[2] ?? "";
      const li = langs.indexOf(lang);
      if (li < 0) continue;
      if (c[6] === "1" || c[7] === "1") continue; // colloquial / historic
      if (c[9]) continue; // has an end date ("to")
      const name = c[3]!;
      if (!name || name.length > 60) continue;
      const rank = li * 10 + (c[4] === "1" ? 0 : c[5] === "1" ? 1 : 3);
      let arr = pref.get(gid);
      if (!arr) pref.set(gid, (arr = []));
      arr.push({ rank, name });
    }
    for (const [gid, arr] of pref) {
      arr.sort((a, b) => a.rank - b.rank);
      const p = places[byId.get(gid)!]!;
      p.altNames = [...new Set(arr.map((a) => a.name))];
    }
  }
  return places;
}

/** R2 asset key of the villages file: every European GeoNames populated place, whatever its population. */
export const VILLAGES_ASSET = "geonames/villages-europe.tsv.gz";
/** Feature codes left out of the villages: city sections (they belong to their town) besides the dropped ones. */
const VILLAGE_DROP_FCODES = new Set([...DROP_FCODES, "PPLX"]);
/** At most this many alternate names per village (Latin-script spellings of its name, for matching stop names). */
const VILLAGE_MAX_ALT = 6;

/**
 * Villages: every populated place (feature class P) of the European countries, also those below the 1000 inhabitants of
 * cities1000 (Scarriff, 770; Feakle, 113; Bodyke, 0). They are not places of their own in the city assignment (that
 * would let every hamlet take the stops of the town next to it); a synthetic town (a stop cluster outside every
 * place, core/cities.ts matchVillage) whose name is a village's name becomes that village: a named place, so its bus
 * stop is a destination. Alternate names are kept only in Latin script and only a few, enough to match stop names.
 * Uses `<assetsDir>/geonames/villages-europe.tsv.gz` when present, otherwise builds it from the per-country dumps of
 * download.geonames.org (~110 MB) and writes it there.
 */
export async function loadVillages(cacheDir: string, ua: string, assetsDir?: string): Promise<Place[]> {
  if (assetsDir) {
    const f = join(assetsDir, VILLAGES_ASSET);
    if (existsSync(f)) {
      try {
        const v = parsePlaces(await readFile(f));
        if (v.length > 100_000) {
          log(`geonames: ${v.length} villages from asset ${f}`);
          return v;
        }
        warn(`geonames villages asset ${f} looks truncated (${v.length} places), rebuilding from source`);
      } catch (e) {
        warn(`geonames villages asset ${f} unreadable: ${(e as Error).message}`);
      }
    }
  }
  const dir = join(cacheDir, "geonames");
  await mkdir(dir, { recursive: true });
  const countries = [...EURO_COUNTRIES].sort();
  const files = await mapLimit(countries, 4, async (cc) => {
    const dest = join(dir, `countries_${cc}.zip`);
    try {
      await downloadCached(`${BASE}${cc}.zip`, dest, ua, { maxAgeH: 24 * 6 });
      return dest;
    } catch (e) {
      warn(`geonames villages ${cc}: ${(e as Error).message}`);
      return null;
    }
  });
  const latin = /^[\p{Script=Latin}\p{N}\s'’.\-()]+$/u;
  const out: Place[] = [];
  countries.forEach((cc, i) => {
    const zip = files[i];
    if (!zip) return;
    let text: string;
    try {
      text = unzipText(zip, `${cc}.txt`);
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      const c = line.split("\t");
      if (c[6] !== "P" || VILLAGE_DROP_FCODES.has(c[7]!)) continue;
      const lat = Number(c[4]), lon = Number(c[5]);
      if (lon < BBOX.minLon || lon > BBOX.maxLon || lat < BBOX.minLat || lat > BBOX.maxLat) continue;
      const name = c[1]!;
      const alt = [c[2] ?? "", ...(c[3] ? c[3].split(",") : [])].filter((n) => n && n !== name && n.length <= 40 && latin.test(n));
      out.push({
        id: Number(c[0]),
        name,
        lon,
        lat,
        country: c[8] || cc,
        population: Number(c[14]) || 0,
        tz: c[17] || "Europe/Berlin",
        fcode: c[7]!,
        admin: [c[10] ?? "", c[11] ?? "", c[12] ?? "", c[13] ?? ""],
        ...(alt.length ? { altNames: [...new Set(alt)].slice(0, VILLAGE_MAX_ALT) } : {}),
      });
    }
  });
  out.sort((a, b) => a.id - b.id);
  log(`geonames: ${out.length} villages from the country dumps`);
  if (assetsDir && out.length > 100_000) {
    await mkdir(join(assetsDir, "geonames"), { recursive: true });
    await writeFile(join(assetsDir, VILLAGES_ASSET), serializePlaces(out));
  }
  return out;
}
