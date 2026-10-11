/**
 * Builds the slow-changing build inputs that live in the R2 bucket
 * `eurotrainbusmap-assets` (see .github/workflows/refresh-assets.yml):
 *
 *   geonames/places-europe.tsv.gz   pruned GeoNames places with local names
 *   basemap/{land,borders,lakes,labels}.json   Natural Earth basemap layers
 *   rail/rail-graph-v1.bin          rail graph for corridor geometry (Overture → pruned graph)
 *   manifest.json                   list of the keys above (read by the weekly build)
 *
 * Usage: node --import tsx src/assets.ts --out <assetsDir> [--work <dir>] [--only geonames,basemap,rail]
 * The weekly build reads the same directory layout via `build-data --assets <dir>`.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { RAIL_GRAPH_KEY, buildRailAsset } from "./geometry/refresh-rail.ts";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLACES_ASSET, loadPlaces } from "./geonames.ts";
import { loadFeedsConfig } from "./feeds.ts";
import { BASEMAP_FILES } from "./build.ts";
import { log, warn } from "./util/log.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

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
  const only = new Set((get("--only") ?? "geonames,basemap,rail").split(","));
  const cacheDir = join(work, "cache");
  await mkdir(out, { recursive: true });
  const cfg = await loadFeedsConfig(join(here, "..", "feeds.json"));
  let failed = false;

  if (only.has("geonames")) {
    await rm(join(out, PLACES_ASSET), { force: true });
    const places = await loadPlaces(cacheDir, cfg.userAgent, out);
    log(`assets: ${PLACES_ASSET} (${places.length} places)`);
  }

  if (only.has("basemap")) {
    const mod = (await import("../../web/scripts/basemap.ts")) as {
      buildBasemap: (o: { outDir: string; cacheDir?: string; log?: (s: string) => void }) => Promise<void>;
    };
    await mod.buildBasemap({ outDir: join(out, "basemap"), log });
    const missing = BASEMAP_FILES.filter((f) => !existsSync(join(out, "basemap", f)));
    if (missing.length) {
      warn(`assets: basemap files missing: ${missing.join(", ")}`);
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

  const manifest: AssetsManifest = { generatedAt: new Date().toISOString(), files: await listFiles(out) };
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 1));
  log(`assets: manifest with ${manifest.files.length} files: ${manifest.files.join(", ")}`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
