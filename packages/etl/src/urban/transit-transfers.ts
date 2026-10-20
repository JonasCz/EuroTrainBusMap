/**
 * The "transit" stage: transfer times between the stations of a city by local public transport (TransitPair,
 * packages/shared/src/transit.ts): the rail-bound profiles (transit.ts) merged with the local buses (bus-transfer.ts).
 *
 * As a command it recomputes them for an existing build directory, rewrites the city files (shard/, city/) and the
 * transfer timetable (tt/, the chunks carry the pairs) and updates the manifest, without re-running anything else:
 *
 *   node --import tsx src/urban/transit-transfers.ts <outDir>/<build> [--work <dir>] [--assets <dir>]
 */
import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TransitMode, ensureSegments, expandNetwork, type CityFile, type CityShardFile, type Manifest, type NetworkFile } from "@etbm/shared";
import { loadFeedsConfig, type FeedsConfig } from "../feeds.ts";
import { TransferCollector } from "../transfers.ts";
import { log as defaultLog } from "../util/log.ts";
import { computeBusTransfers, mergeBusPairs } from "./bus-transfer.ts";
import { loadUrbanFeedDefs } from "./index.ts";
import { computeTransit, gatherTransitFeeds } from "./transit.ts";

const here = dirname(fileURLToPath(import.meta.url));

export interface TransitTransferOptions {
  cfg: FeedsConfig;
  work: string;
  assets: string;
  startDate: string;
  staleMaxDays?: number;
  cities: { id: number; name: string; stations: number[] }[];
  stations: { lon: number; lat: number; cats: number; tpd?: number }[];
  log?: (m: string) => void;
}

/** Transit pairs (rail-bound and bus) per city. */
export async function computeTransitTransfers(o: TransitTransferOptions): Promise<{ byCity: Map<number, number[][]>; stats: Record<string, number> }> {
  const log = o.log ?? defaultLog;
  const urbanFeeds = await loadUrbanFeedDefs();
  const staleMaxDays = o.staleMaxDays ?? o.cfg.staleMaxDays;
  const tfeeds = await gatherTransitFeeds({ cfg: o.cfg, urbanFeeds, workDir: o.work, assetsDir: o.assets, startDate: o.startDate, download: true, staleMaxDays, log });
  const rail = computeTransit(tfeeds, o.cities, o.stations, log);
  const bus = await computeBusTransfers({ cfg: o.cfg, urbanFeeds, workDir: o.work, assetsDir: o.assets, startDate: o.startDate, download: true, staleMaxDays }, o.cities, o.stations, log);
  const byCity = new Map<number, number[][]>();
  let pairs = 0, busPairs = 0;
  for (const c of new Set([...rail.byCity.keys(), ...bus.byCity.keys()])) {
    const m = mergeBusPairs(rail.byCity.get(c), bus.byCity.get(c));
    if (!m.length) continue;
    byCity.set(c, m);
    pairs += m.length;
    busPairs += m.filter((p) => p[2]! & TransitMode.Bus).length;
  }
  log(`transit: ${pairs} station pairs in ${byCity.size} cities, ${busPairs} of them by local bus in some hour`);
  return { byCity, stats: { ...rail.stats, ...bus.stats, transitCities: byCity.size, transitPairs: pairs, transitBusPairs: busPairs } };
}

// CLI: recompute the transit transfers of an existing build
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2).filter((x) => x !== "--");
  const get = (n: string) => (a.indexOf(n) >= 0 ? a[a.indexOf(n) + 1] : undefined);
  const dir = a.find((x) => !x.startsWith("--") && x !== get("--work") && x !== get("--assets"));
  if (!dir) {
    console.error("usage: urban/transit-transfers.ts <buildDir> [--work <dir>] [--assets <dir>]");
    process.exit(1);
  }
  const t0 = Date.now();
  const buildDir = resolve(dir);
  const work = resolve(get("--work") ?? join(here, "../../../../work"));
  const assets = resolve(get("--assets") ?? join(work, "assets"));
  const network = expandNetwork(JSON.parse(await readFile(join(buildDir, "network.json"), "utf8")) as NetworkFile);
  const mf = join(buildDir, "..", "manifest.json");
  const manifest = existsSync(mf) ? (JSON.parse(await readFile(mf, "utf8")) as Manifest) : null;
  if (!manifest?.startDate) throw new Error("no manifest with the build's start date next to the build directory");
  const cfg = await loadFeedsConfig(join(here, "../../feeds.json"));
  const r = await computeTransitTransfers({ cfg, work, assets, startDate: manifest.startDate, cities: network.cities, stations: network.stations });
  // city files: replace the transit pairs, collect the transfer timetable
  const tt = new TransferCollector();
  const patch = (cf: CityFile) => {
    const t = r.byCity.get(cf.city);
    if (t) cf.transit = t;
    else delete cf.transit;
    tt.add(cf);
  };
  for (const sub of ["shard", "city"]) {
    const d = join(buildDir, sub);
    if (!existsSync(d)) continue;
    for (const f of await readdir(d)) {
      if (!f.endsWith(".json")) continue;
      const j = JSON.parse(await readFile(join(d, f), "utf8")) as CityShardFile | CityFile;
      if ("cities" in j) for (const cf of Object.values(j.cities)) patch(cf);
      else patch(j);
      await writeFile(join(d, f), JSON.stringify(j));
    }
  }
  await rm(join(buildDir, "tt"), { recursive: true, force: true });
  const w = await tt.write(network.cities, ensureSegments(network), network.corridors, async (rel, data) => {
    await mkdir(dirname(join(buildDir, rel)), { recursive: true });
    await writeFile(join(buildDir, rel), data);
  });
  if (manifest.build === network.build) {
    Object.assign(manifest.stats, r.stats);
    manifest.transfers = { version: w.index.version, index: "tt/index.json" };
    await writeFile(mf, JSON.stringify(manifest, null, 2));
    console.log("manifest updated");
  }
  console.log(`transit transfers rewritten in ${Math.round((Date.now() - t0) / 1000)} s`);
}
