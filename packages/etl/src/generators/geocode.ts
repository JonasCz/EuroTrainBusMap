/**
 * Geocode the stops a feed generator reports as missing (NeedsGeocodingError, geocodes.ts) and prepare them for review:
 *
 *   pnpm --filter @etbm/etl run geocode -- <generator id> [--accept] [--start YYYY-MM-DD]
 *
 *   1. runs the generator live; it names every stop that is not in data/geocodes/<id>.json (or not reviewed yet);
 *   2. looks each new stop up on OpenStreetMap (Nominatim: one request per 2 s, restricted to the country and to the
 *      area of the stops already in the file), picks the best hit and writes it as an UNCHECKED entry
 *      (`checked: null`, source "osm-auto", the note says why it is unsure); a stop with no hit is listed for manual work;
 *   3. runs the generator again with the unchecked entries allowed, and prints what a reviewer needs: every leg of every
 *      trip that touches a new stop with its distance, minutes and km/h (a wrong position shows as 150 km/h or as a
 *      zigzag), and the entries of the file the timetable no longer uses (removed stops: harmless).
 *   4. the reviewer (agent) corrects wrong entries in the JSON by hand (source "manual"), runs the command again until
 *      nothing is reported, then with `--accept`: every unchecked entry becomes checked (today's date, source "osm"),
 *      and the file is committed. Until then the build refuses the feed ("looked up but not reviewed yet").
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { todayIn } from "../core/time.ts";
import { loadFeedsConfig } from "../feeds.ts";
import { haversineKm, type GtfsFeed } from "./gtfs.ts";
import { GEOCODES_DIR, GeocodeStore, NeedsGeocodingError, boundsOf, geoKey, saveGeocodes, type GeocodeEntry, type GeocodeFile, type MissingStop } from "./geocodes.ts";
import { generatorContext } from "./registry.ts";

const here = dirname(fileURLToPath(import.meta.url));

interface Hit {
  lat: string;
  lon: string;
  name?: string;
  display_name: string;
  osm_type: string;
  osm_id: number;
  category?: string;
  class?: string;
  type?: string;
}
type Bounds = { west: number; south: number; east: number; north: number };

const inside = (h: Hit, b: Bounds | null) => !b || (Number(h.lon) >= b.west && Number(h.lon) <= b.east && Number(h.lat) >= b.south && Number(h.lat) <= b.north);
const PLACES = new Set(["place", "boundary", "amenity", "highway", "railway", "public_transport"]);

async function search(q: string, country: string | undefined, bounds: Bounds | null, bounded: boolean, ua: string): Promise<Hit[]> {
  const p = new URLSearchParams({ q, format: "jsonv2", limit: "6", namedetails: "0" });
  if (country) p.set("countrycodes", country);
  if (bounds) {
    p.set("viewbox", `${bounds.west},${bounds.north},${bounds.east},${bounds.south}`);
    if (bounded) p.set("bounded", "1");
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?${p}`, { headers: { "User-Agent": ua } });
    if (r.status === 429 || r.status >= 500) {
      await new Promise((ok) => setTimeout(ok, 6000 * (attempt + 1)));
      continue;
    }
    if (!r.ok) throw new Error(`Nominatim ${r.status}`);
    return (await r.json()) as Hit[];
  }
  throw new Error("Nominatim kept answering 429 / 5xx");
}

/** The best hit for a stop name and how sure we are. */
function pick(name: string, hits: Hit[], bounds: Bounds | null): { hit: Hit; note: string } | null {
  const scored = hits
    .filter((h) => inside(h, bounds))
    .map((h) => {
      const exact = geoKey(h.name ?? h.display_name.split(",")[0]!) === geoKey(name);
      const cat = h.category ?? h.class ?? "";
      // a place node (town / village / bus station) is where people board; a boundary relation only has a centroid,
      // which for a municipality lies 5–15 km from the town
      return { h, exact, score: (exact ? 4 : 0) + (PLACES.has(cat) ? 1 : 0) + (h.osm_type === "node" && cat === "place" ? 3 : 0) };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return null;
  const notes: string[] = [];
  if (!best.exact) notes.push(`name differs: "${best.h.name ?? best.h.display_name.split(",")[0]}"`);
  if (scored.length > 1 && scored[1]!.score === best.score) notes.push(`${scored.length} similar hits`);
  return { hit: best.h, note: [...notes, best.h.display_name.split(",").slice(0, 3).join(",")].join("; ") };
}

const titleCase = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s(-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase()) : s);

interface Leg {
  from: string;
  to: string;
  km: number;
  min: number;
  kmh: number;
  flag: string;
}
/** Legs of the feed that touch the given stop names, with speed: wrong coordinates show up here. */
function legsOf(feed: GtfsFeed, names: Set<string>): Leg[] {
  const stop = new Map(feed.stops.map((s) => [s.stop_id, s]));
  const legs = new Map<string, Leg>();
  const byTrip = new Map<string, typeof feed.stopTimes>();
  for (const st of feed.stopTimes) (byTrip.get(st.trip_id) ?? byTrip.set(st.trip_id, []).get(st.trip_id)!).push(st);
  for (const l of byTrip.values()) {
    l.sort((a, b) => a.stop_sequence - b.stop_sequence);
    for (let i = 1; i < l.length; i++) {
      const a = stop.get(l[i - 1]!.stop_id)!, b = stop.get(l[i]!.stop_id)!;
      if (!names.has(geoKey(a.stop_name)) && !names.has(geoKey(b.stop_name))) continue;
      const km = haversineKm(a.stop_lat, a.stop_lon, b.stop_lat, b.stop_lon), min = l[i]!.arr - l[i - 1]!.dep;
      const kmh = min > 0 ? km / (min / 60) : Infinity;
      const flag = kmh > 95 && km > 3 ? "too fast" : km < 0.3 && min > 15 ? "same place?" : kmh < 12 && km > 3 ? "too slow" : "";
      const key = `${a.stop_name} → ${b.stop_name}`;
      if (!legs.has(key) || flag) legs.set(key, { from: a.stop_name, to: b.stop_name, km, min, kmh, flag });
    }
  }
  return [...legs.values()];
}
const legText = (l: Leg) => `  ${l.from} → ${l.to}: ${l.km.toFixed(1)} km in ${l.min} min${Number.isFinite(l.kmh) ? ` = ${l.kmh.toFixed(0)} km/h` : ""}${l.flag ? `  <-- ${l.flag}` : ""}`;

async function main() {
  const argv = process.argv.slice(2).filter((x) => x !== "--");
  const get = (n: string) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : undefined);
  const id = argv.find((x, i) => !x.startsWith("--") && !(i > 0 && argv[i - 1]!.startsWith("--")));
  if (!id) {
    console.error("usage: geocode <generator id> [--accept] [--start YYYY-MM-DD]");
    process.exit(2);
  }
  const accept = argv.includes("--accept");
  const startDate = get("--start") ?? todayIn("Europe/Berlin", new Date(Date.now() - 86_400_000));
  const cfg = await loadFeedsConfig(join(here, "../../feeds.json"));
  const gen = cfg.generators!.generators.get(id);
  if (!gen) {
    console.error(`no generator "${id}"`);
    process.exit(2);
  }
  const path = join(GEOCODES_DIR, `${id}.json`);
  const readFileObj = async (): Promise<GeocodeFile> => (existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as GeocodeFile) : { version: 1, entries: {} });
  let file = await readFileObj();
  const today = new Date().toISOString().slice(0, 10);

  if (accept) {
    let n = 0;
    for (const e of Object.values(file.entries))
      if (!e.checked) {
        e.checked = today;
        if (e.source === "osm-auto") e.source = "osm";
        delete e.note;
        n++;
      }
    await saveGeocodes(id, file);
    console.log(`${n} entries of data/geocodes/${id}.json marked as checked (${today}). Commit the file.`);
    return;
  }

  const run = async (unchecked: boolean) => {
    if (unchecked) process.env.ETBM_GEOCODES_UNCHECKED = "1";
    else delete process.env.ETBM_GEOCODES_UNCHECKED;
    const warnings: string[] = [];
    const ctx = generatorContext({ id, userAgent: cfg.userAgent, startDate, days: 60, warnings, log: () => {}, warn: () => {} });
    try {
      return { feed: await gen.generate(ctx) };
    } catch (e) {
      return { error: e as Error };
    }
  };

  const first = await run(false);
  let missing: MissingStop[] = [];
  if (first.error instanceof NeedsGeocodingError) missing = first.error.missing;
  else if (first.error) {
    console.error(`the generator fails for another reason, fix that first: ${first.error.message}`);
    process.exit(1);
  }
  const fresh = missing.filter((m) => !m.unchecked);
  console.log(first.error ? `${missing.length} stops need geocoding (${fresh.length} new, ${missing.length - fresh.length} looked up earlier, not reviewed yet)` : "all stops have reviewed coordinates");

  const bounds = boundsOf(file);
  const notFound: string[] = [];
  const context = new Map<string, MissingStop>();
  const wait = () => new Promise((ok) => setTimeout(ok, 2000));
  const toEntry = (m: { name: string; context: string }, best: { hit: Hit; note: string }, outside: boolean): GeocodeEntry => ({
    name: best.hit.name && geoKey(best.hit.name) === geoKey(m.name) ? best.hit.name : titleCase(m.name),
    lat: Math.round(Number(best.hit.lat) * 1e4) / 1e4,
    lon: Math.round(Number(best.hit.lon) * 1e4) / 1e4,
    source: "osm-auto",
    checked: null,
    note: `${outside ? "OUTSIDE the known area; " : ""}${best.note} [${best.hit.osm_type}/${best.hit.osm_id}] (first seen: ${m.context})`,
  });
  for (const m of fresh) {
    let hits = await search(m.name, file.country, bounds, true, cfg.userAgent);
    await wait();
    let outside = false;
    if (!hits.some((h) => inside(h, bounds))) {
      hits = await search(m.name, file.country, null, false, cfg.userAgent);
      await wait();
      outside = true;
    }
    const best = pick(m.name, hits, outside ? null : bounds);
    if (!best) {
      notFound.push(m.name);
      continue;
    }
    const entry = toEntry(m, best, outside);
    file.entries[geoKey(m.name)] = entry;
    context.set(geoKey(m.name), m);
    console.log(`  + ${m.name} → ${entry.name} ${entry.lat},${entry.lon}  ${entry.note}`);
  }
  if (fresh.length) await saveGeocodes(id, file);
  if (notFound.length) console.log(`\nNOT FOUND on OSM, add by hand (name, lat, lon, source "manual"): ${notFound.join(", ")}`);

  // review pass: the feed with the unchecked entries allowed; a new stop whose legs are implausible is searched again
  // in a small area around its reviewed neighbours (the stop before / after it in the timetable)
  let second = await run(true);
  for (let round = 0; round < 2 && second.feed; round++) {
    file = await readFileObj();
    const pending = Object.entries(file.entries).filter(([, e]) => !e.checked && e.source === "osm-auto");
    const legs = legsOf(second.feed, new Set(pending.map(([, e]) => geoKey(e.name))));
    const bad = pending.filter(([, e]) => legs.some((l) => l.flag && (geoKey(l.from) === geoKey(e.name) || geoKey(l.to) === geoKey(e.name))));
    if (!bad.length) break;
    let moved = 0;
    for (const [key, e] of bad) {
      const near = legs
        .filter((l) => geoKey(l.from) === geoKey(e.name) || geoKey(l.to) === geoKey(e.name))
        .map((l) => file.entries[geoKey(geoKey(l.from) === geoKey(e.name) ? l.to : l.from)])
        .filter((n): n is GeocodeEntry => !!n && !!n.checked);
      if (!near.length) continue;
      const lat = near.reduce((a, n) => a + n.lat, 0) / near.length, lon = near.reduce((a, n) => a + n.lon, 0) / near.length;
      const box: Bounds = { west: lon - 0.35, east: lon + 0.35, south: lat - 0.3, north: lat + 0.3 };
      const m = context.get(key) ?? { name: e.name, context: "?" };
      const hits = await search(m.name, file.country, box, true, cfg.userAgent);
      await wait();
      const best = pick(m.name, hits, box);
      if (!best) {
        e.note = `no OSM hit near its neighbours (${near.map((n) => n.name).join(", ")}) – position is probably wrong, set it by hand; ${e.note ?? ""}`;
        continue;
      }
      const fixed = toEntry(m, best, false);
      fixed.note = `re-searched near ${near.map((n) => n.name).join(", ")}: ${fixed.note}`;
      console.log(`  ~ ${m.name}: ${e.lat},${e.lon} → ${fixed.lat},${fixed.lon}  (${fixed.note})`);
      file.entries[key] = fixed;
      moved++;
    }
    await saveGeocodes(id, file);
    if (!moved) break;
    second = await run(true);
  }
  if (!second.feed) {
    console.log(`\nthe generator still fails with the new entries: ${second.error!.message}`);
    process.exit(1);
  }
  file = await readFileObj();
  const pending = Object.entries(file.entries).filter(([, e]) => !e.checked);
  if (pending.length) {
    const names = new Set(pending.map(([, e]) => geoKey(e.name)));
    const legs = legsOf(second.feed, names);
    const odd = legs.filter((l) => l.flag || l.kmh > 90 || (l.kmh < 20 && l.km > 3));
    console.log(`\n${pending.length} unchecked entries; ${legs.length} legs touch them, ${odd.length} look unusual (>90 or <20 km/h, or flagged):`);
    for (const l of odd.sort((a, b) => a.from.localeCompare(b.from))) console.log(legText(l));
    for (const [, e] of pending) if (/OUTSIDE|name differs|similar hits|probably wrong/.test(e.note ?? "")) console.log(`  ? ${e.name}: ${e.note}`);
    console.log(`\nEdit data/geocodes/${id}.json where a position is wrong (source "manual"), rerun this command to see the legs again, then \`geocode -- ${id} --accept\` and commit.`);
  } else console.log("\nno unchecked entries");
  const usedNames = new Set(second.feed.stops.map((s) => geoKey(s.stop_name)));
  const unused = Object.values(file.entries).filter((e) => !usedNames.has(geoKey(e.name))).map((e) => e.name);
  if (unused.length) console.log(`\nentries the timetable does not use (any more; harmless, remove if the stop is gone for good): ${unused.join(", ")}`);
  process.exit(missing.length || pending.length ? 3 : 0);
}

await main();
