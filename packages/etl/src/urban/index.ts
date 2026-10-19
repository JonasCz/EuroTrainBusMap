/**
 * Local transport (metro / tram / city bus) display layer: lines and stops from the GTFS feeds as
 * vector tiles of their own. Independent of the intercity pipeline (own DuckDB, own tiles), so it can
 * be rebuilt on an existing build directory:
 *
 *   node --import tsx src/urban/index.ts <outDir>/<build> [--work <dir>] [--assets <dir>]
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandNetwork, type AttributionFile, type Manifest, type NetworkFile, type UrbanInfo } from "@etbm/shared";
import { todayIn } from "../core/time.ts";
import { loadFeedsConfig, type FeedDef } from "../feeds.ts";
import { log as defaultLog, warn } from "../util/log.ts";
import { alignFeed, loadAligners, type AlignStats } from "./align.ts";
import { gatherFeeds } from "./feeds.ts";
import { buildUrban } from "./model.ts";
import { writeUrbanTiles } from "./tiles.ts";
import { UMODE_NAME, type UrbanFeed } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));

export interface UrbanOptions {
  buildDir: string;
  work: string;
  assets: string;
  startDate: string;
  /** Cap on stale feeds (gtfs/validity.ts; default feeds.json staleMaxDays). */
  staleMaxDays?: number;
  /** intercity stations (urban stops at them get no dot of their own) */
  stations: { lon: number; lat: number; name?: string }[];
  licenses?: unknown[];
  log?: (m: string) => void;
}

export interface UrbanResult {
  info: UrbanInfo;
  files: number;
  bytes: number;
  stats: Record<string, number>;
}

export async function loadUrbanFeedDefs(): Promise<FeedDef[]> {
  const defs = (JSON.parse(await readFile(join(here, "../../urban-feeds.json"), "utf8")) as { feeds: Partial<FeedDef>[] }).feeds;
  // the file lists only id, country, name and sources; the rest is what resolveFeeds expects
  return defs.map((d) => ({ tier: "core", keep: ["bus"], ...d }) as FeedDef);
}

export async function writeUrbanLayer(o: UrbanOptions): Promise<UrbanResult> {
  const log = o.log ?? defaultLog;
  const cfg = await loadFeedsConfig(join(here, "../../feeds.json"));
  const urbanFeeds = await loadUrbanFeedDefs();
  const gathered = await gatherFeeds({ cfg, urbanFeeds, workDir: o.work, assetsDir: o.assets, startDate: o.startDate, download: true, staleMaxDays: o.staleMaxDays ?? cfg.staleMaxDays });
  const feeds = gathered.feeds;
  const cities = gathered.cities;
  log(`urban: ${feeds.length} feeds with local lines`);
  const al = loadAligners(o.work, o.assets, log);
  const astats: AlignStats = { patterns: {} };
  for (const f of feeds) alignFeed(f, al, astats);
  log(`urban: alignment ${JSON.stringify(astats.patterns)}`);
  const built = buildUrban(feeds, o.stations, cities);
  const w = await writeUrbanTiles(o.buildDir, built, log);
  const stats: Record<string, number> = { urbanFeeds: feeds.length, urbanLines: built.lines.length, urbanStations: built.stations.length, urbanFiles: w.files, urbanBytes: w.bytes };
  for (const m of [0, 1, 2, 3]) stats[`urban_${UMODE_NAME[m]}`] = built.lines.filter((l) => l.mode === m).length;
  for (const g of ["shape", "rail", "road", "stops"]) stats[`urbanGeom_${g}`] = built.lines.filter((l) => l.geom === g).length;
  log(`urban: ${built.lines.length} alignments, ${built.stations.length} stations (${built.stations.filter((s) => s.ix).length} at intercity stations), ${w.files} files, ${(w.bytes / 1e6).toFixed(1)} MB`);
  await addAttribution(o.buildDir, feeds, urbanFeeds, o.licenses ?? []);
  return { info: w.info, files: w.files, bytes: w.bytes, stats };
}

interface LicenseEntry {
  filename?: string;
  spdx_license_identifier?: string | null;
  license_url?: string | null;
  publisher?: { name?: string; url?: string } | null;
}

/** Add the extra local feeds that contributed lines to attribution.json (once). */
async function addAttribution(buildDir: string, feeds: UrbanFeed[], defs: FeedDef[], licenses: unknown[]): Promise<void> {
  const f = join(buildDir, "attribution.json");
  if (!existsSync(f)) return;
  const att = JSON.parse(await readFile(f, "utf8")) as AttributionFile;
  const lic = new Map<string, LicenseEntry>();
  for (const e of licenses as LicenseEntry[]) if (e.filename) lic.set(e.filename, e);
  const have = new Set(att.sources.map((s) => s.name));
  const used = new Set(feeds.map((x) => x.key));
  const expired = new Map(feeds.filter((x) => x.expired).map((x) => [x.key, x.expired!]));
  for (const d of defs) {
    if (!used.has(d.id) || have.has(d.name)) continue;
    const tf = d.sources.map((s) => ("transitous" in s ? s.transitous : "")).find(Boolean);
    const e = tf ? lic.get(tf) : undefined;
    const src: AttributionFile["sources"][number] = {
      name: d.name,
      license: e?.spdx_license_identifier ?? (e?.license_url ? "see terms" : d.license ?? "see source"),
      ...(e?.license_url ?? e?.publisher?.url ?? d.licenseUrl ? { url: (e?.license_url ?? e?.publisher?.url ?? d.licenseUrl)! } : {}),
      ...(e?.publisher?.name && !d.name.toLowerCase().includes(e.publisher.name.toLowerCase()) ? { attribution: e.publisher.name } : {}),
      ...(expired.has(d.id) ? { expired: expired.get(d.id)! } : {}),
    };
    att.sources.push(src);
  }
  att.sources.push({ name: "OpenStreetMap via Overture Maps (tram / metro track, roads)", license: "ODbL-1.0", url: "https://www.openstreetmap.org/copyright", attribution: "© OpenStreetMap contributors" });
  const seen = new Set<string>();
  att.sources = att.sources.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
  await writeFile(f, JSON.stringify(att));
}

// CLI: (re)build the layer for an existing build directory
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2).filter((x) => x !== "--");
  const get = (n: string) => (a.indexOf(n) >= 0 ? a[a.indexOf(n) + 1] : undefined);
  const dir = a.find((x) => !x.startsWith("--") && x !== get("--work") && x !== get("--assets"));
  if (!dir) {
    console.error("usage: urban/index.ts <buildDir> [--work <dir>] [--assets <dir>] [--start YYYY-MM-DD]");
    process.exit(1);
  }
  const buildDir = resolve(dir);
  const work = resolve(get("--work") ?? join(here, "../../../../work"));
  const assets = resolve(get("--assets") ?? join(work, "assets"));
  const net = expandNetwork(JSON.parse(await readFile(join(buildDir, "network.json"), "utf8")) as NetworkFile);
  const mf = join(buildDir, "..", "manifest.json");
  const manifest = existsSync(mf) ? (JSON.parse(await readFile(mf, "utf8")) as Manifest) : null;
  const start = get("--start") ?? manifest?.startDate ?? todayIn("Europe/Berlin", new Date(Date.now() - 86_400_000));
  let licenses: unknown[] = [];
  try {
    licenses = JSON.parse(await readFile(join(work, "cache", "transitous-license.json"), "utf8"));
  } catch {
    warn("no cached Transitous license.json");
  }
  const r = await writeUrbanLayer({ buildDir, work, assets, startDate: start, stations: net.stations, licenses });
  if (manifest && manifest.build === net.build) {
    manifest.urban = r.info;
    Object.assign(manifest.stats, r.stats);
    await writeFile(mf, JSON.stringify(manifest));
    console.log("manifest updated");
  }
}
