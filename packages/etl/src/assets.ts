/**
 * Builds the slow-changing build inputs that live in the R2 bucket
 * `eurotrainbusmap-assets` (see .github/workflows/refresh-assets.yml):
 *
 *   geonames/places-europe.tsv.gz   pruned GeoNames places with local names
 *   geonames/villages-europe.tsv.gz every GeoNames populated place (villages below cities1000, to name bus places)
 *   basemap/{borders,labels}.json   Natural Earth 1:10m borders + country labels (GeoJSON)
 *   basemap/tiles-v2.tar            OSM land polygons + NE lakes as gzipped vector tiles (ONE object, unpacked by every build)
 *   rail/rail-graph-v1.bin          rail graph for corridor geometry (Overture → pruned graph)
 *   rail/urbanrail-graph-v1.bin     tram / metro / light-rail track graph (aligns local-transport lines without shapes)
 *   road/road-graph-v1.bin          major-road graph for coach/bus corridor geometry (same format)
 *   manifest.json                   list of the keys above (read by the weekly build)
 *
 * `--out` may already hold the current R2 assets (the workflow downloads them first, so the parts not rebuilt are kept).
 * Every file in it that is not one of the current keys above (an older format version such as rail-graph-v0.bin, the
 * retired basemap land.json / lakes.json) is deleted and left out of the manifest; the workflow then deletes the R2
 * objects that are no longer in the manifest, so the bucket holds the current assets only.
 *
 * Usage: node --import tsx src/assets.ts --out <assetsDir> [--work <dir>] [--only geonames,basemap,tiles,rail,urbanrail,road]
 * The weekly build reads the same directory layout via `build-data --assets <dir>`.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { RAIL_GRAPH_KEY, ROAD_GRAPH_KEY, URBAN_RAIL_GRAPH_KEY, buildRailAsset, buildRoadAsset, buildUrbanRailAsset } from "./geometry/refresh-rail.ts";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLACES_ASSET, VILLAGES_ASSET, loadPlaces, loadVillages } from "./geonames.ts";
import { loadFeedsConfig } from "./feeds.ts";
import { BASEMAP_FILES } from "./build.ts";
import { BASEMAP_TILES_KEY, buildBasemapTiles } from "./basemap/tiles.ts";
import { log, warn } from "./util/log.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

/** Every asset key the current code reads (the manifest lists exactly these, when present). */
export const ASSET_KEYS = [
  PLACES_ASSET,
  VILLAGES_ASSET,
  ...BASEMAP_FILES.map((f) => `basemap/${f}`),
  BASEMAP_TILES_KEY,
  RAIL_GRAPH_KEY,
  URBAN_RAIL_GRAPH_KEY,
  ROAD_GRAPH_KEY,
];

export interface AssetsManifest {
  generatedAt: string;
  files: string[];
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p, base)));
    else if (e.name !== "manifest.json") out.push(relative(base, p).split("\\").join("/"));
  }
  return out.sort();
}

async function main() {
  const a = process.argv.slice(2).filter((x) => x !== "--");
  const get = (n: string) => (a.indexOf(n) >= 0 ? a[a.indexOf(n) + 1] : undefined);
  const out = resolve(get("--out") ?? join(repoRoot, "work", "assets"));
  const work = resolve(get("--work") ?? join(repoRoot, "work"));
  const only = new Set((get("--only") ?? "geonames,basemap,tiles,rail,urbanrail,road").split(","));
  const cacheDir = join(work, "cache");
  await mkdir(out, { recursive: true });
  const cfg = await loadFeedsConfig(join(here, "..", "feeds.json"));
  let failed = false;

  if (only.has("geonames")) {
    try {
      // strict: a download that fails is an error here (the build's own fallback tolerates it, an asset must not)
      await rm(join(out, PLACES_ASSET), { force: true });
      const places = await loadPlaces(cacheDir, cfg.userAgent, out, { strict: true });
      log(`assets: ${PLACES_ASSET} (${places.length} places)`);
      await rm(join(out, VILLAGES_ASSET), { force: true });
      const villages = await loadVillages(cacheDir, cfg.userAgent, out, { strict: true });
      log(`assets: ${VILLAGES_ASSET} (${villages.length} villages)`);
    } catch (e) {
      warn(`assets: geonames failed: ${(e as Error).stack ?? e}`);
      failed = true;
    }
  }

  if (only.has("basemap")) {
    const mod = (await import("../../web/scripts/basemap.ts")) as {
      buildBasemap: (o: { outDir: string; cacheDir?: string; log?: (s: string) => void }) => Promise<void>;
    };
    await mod.buildBasemap({ outDir: join(out, "basemap"), cacheDir: join(cacheDir, "basemap-src"), log });
    // superseded by the vector tiles (kept out of the manifest, so the weekly build no longer downloads them)
    for (const f of ["land.json", "lakes.json"]) await rm(join(out, "basemap", f), { force: true });
    const missing = BASEMAP_FILES.filter((f) => !existsSync(join(out, "basemap", f)));
    if (missing.length) {
      warn(`assets: basemap files missing: ${missing.join(", ")}`);
      failed = true;
    }
  }

  if (only.has("tiles")) {
    try {
      // Land polygons (~0.9 GB download, 5-10 min) → tiles; one tar so R2 gets a single object
      const r = await buildBasemapTiles({ cacheDir: join(cacheDir, "basemap-src"), log });
      await mkdir(join(out, "basemap"), { recursive: true });
      await writeFile(join(out, BASEMAP_TILES_KEY), r.tar);
      log(`assets: ${BASEMAP_TILES_KEY} (${(r.tar.length / 1e6).toFixed(1)} MB)`);
    } catch (e) {
      warn(`assets: basemap tiles failed: ${(e as Error).stack ?? e}`);
      failed = true;
    }
  }

  if (only.has("rail")) {
    await mkdir(join(out, "rail"), { recursive: true });
    try {
      // Compact rail graph binary (Overture rail → pruned graph), built by the geometry module.
      const r = await buildRailAsset(work, join(out, RAIL_GRAPH_KEY), log);
      log(`assets: ${r.key} (${(r.bytes / 1e6).toFixed(1)} MB, Overture ${r.release})`);
    } catch (e) {
      warn(`assets: rail asset failed: ${(e as Error).stack ?? e}`);
      failed = true;
    }
  }

  if (only.has("urbanrail")) {
    await mkdir(join(out, "rail"), { recursive: true });
    try {
      // Tram / metro / light-rail track graph: aligns local-transport lines that come without shapes.
      const r = await buildUrbanRailAsset(work, join(out, URBAN_RAIL_GRAPH_KEY), log);
      log(`assets: ${r.key} (${(r.bytes / 1e6).toFixed(1)} MB, Overture ${r.release})`);
    } catch (e) {
      warn(`assets: urban rail asset failed: ${(e as Error).stack ?? e}`);
      failed = true;
    }
  }

  if (only.has("road")) {
    await mkdir(join(out, "road"), { recursive: true });
    try {
      // Major-road graph (Overture motorway…secondary + links → pruned graph) for coach/bus corridors.
      const r = await buildRoadAsset(work, join(out, ROAD_GRAPH_KEY), log);
      log(`assets: ${r.key} (${(r.bytes / 1e6).toFixed(1)} MB, Overture ${r.release})`);
    } catch (e) {
      warn(`assets: road asset failed: ${(e as Error).stack ?? e}`);
      failed = true;
    }
  }

  // superseded files (older format versions, retired layers) are removed, so neither the manifest nor R2 keeps them
  const current = new Set(ASSET_KEYS);
  const files: string[] = [];
  for (const f of await listFiles(out)) {
    if (current.has(f)) files.push(f);
    else {
      await rm(join(out, f), { force: true });
      log(`assets: removed superseded ${f}`);
    }
  }
  const absent = ASSET_KEYS.filter((k) => !files.includes(k));
  if (absent.length) warn(`assets: not built and not in --out: ${absent.join(", ")} (the weekly build falls back to source / runs without them)`);
  const manifest: AssetsManifest = { generatedAt: new Date().toISOString(), files };
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 1));
  log(`assets: manifest with ${manifest.files.length} files: ${manifest.files.join(", ")}`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
