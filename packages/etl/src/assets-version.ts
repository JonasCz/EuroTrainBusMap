/**
 * Version of the build assets in R2 (see assets.ts and .github/workflows/refresh-assets.yml): which assets the code
 * expects and whether the bucket holds them.
 *
 * The **stamp** of the current code is ASSETS_VERSION (bump it whenever the code that builds an asset changes what
 * it builds – a new graph cost or road class, another simplification of the basemap tiles, new GeoNames columns),
 * the coverage (`COVERAGE_ID` and the boxes, packages/shared/src/coverage.ts) and the asset keys (their names carry
 * the file format versions, `RAIL_FORMAT`, `BASEMAP_TILES_KEY`). refresh-assets writes the stamp of the code it ran
 * as `version.json` into the bucket, as its very last step after a successful upload and pruning, and only when every
 * part was rebuilt by that code (or the bucket already matched it). build-deploy compares the bucket's
 * `version.json` with the stamp of its own code before building: missing or different → it runs the refresh first
 * (the refresh-assets workflow as a reusable workflow), then rebuilds the data. So no one has to remember to run
 * refresh-assets by hand.
 *
 * A guard keeps the version honest: ASSET_SOURCES lists the files that define the assets and ASSETS_SOURCE_HASH their
 * hash; test/assets-version.test.ts fails when they change without the hash being updated, so a change to them is a
 * conscious decision – bump ASSETS_VERSION when the assets change, or only update the hash for a change that does not
 * touch them (comments, build-time-only code).
 *
 * CLI (the workflows):
 *   node --import tsx src/assets-version.ts --stamp                 print the stamp of the code (JSON)
 *   node --import tsx src/assets-version.ts --write <file>          write version.json (stamp + builtAt, commit, parts)
 *   node --import tsx src/assets-version.ts --check <file|missing>  compare the bucket's version.json with the code:
 *       prints the verdict, writes `current=true|false` and `reason=…` to $GITHUB_OUTPUT; exit code 0 either way
 *   node --import tsx src/assets-version.ts --hash                  print the hash of ASSET_SOURCES (to update the guard)
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COVERAGE_BOXES, COVERAGE_ID } from "@etbm/shared";
import { RAIL_GRAPH_KEY, ROAD_GRAPH_KEY, URBAN_RAIL_GRAPH_KEY } from "./geometry/refresh-rail.ts";
import { PLACES_ASSET, VILLAGES_ASSET } from "./geonames.ts";
import { BASEMAP_TILES_KEY } from "./basemap/tiles.ts";

/** Bump when what an asset contains changes (see the header). */
export const ASSETS_VERSION = 2;

/** Borders and country labels (basemap part), built by packages/web/scripts/basemap.ts. */
export const BASEMAP_FILES = ["borders.json", "labels.json"];

/** Every asset key the current code reads (the bucket's manifest.json lists exactly these). */
export const ASSET_KEYS = [
  PLACES_ASSET,
  VILLAGES_ASSET,
  ...BASEMAP_FILES.map((f) => `basemap/${f}`),
  BASEMAP_TILES_KEY,
  RAIL_GRAPH_KEY,
  URBAN_RAIL_GRAPH_KEY,
  ROAD_GRAPH_KEY,
];

/** All parts of refresh-assets (`--only`). */
export const ASSET_PARTS = ["geonames", "basemap", "tiles", "rail", "urbanrail", "road"];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The files that define what the assets contain (repository paths); guarded by ASSETS_SOURCE_HASH. */
export const ASSET_SOURCES = [
  "packages/shared/src/coverage.ts",
  "packages/etl/src/assets.ts",
  "packages/etl/src/assets-version.ts",
  "packages/etl/src/geonames.ts",
  "packages/etl/src/basemap/geom.ts",
  "packages/etl/src/basemap/shp.ts",
  "packages/etl/src/basemap/tar.ts",
  "packages/etl/src/basemap/tiles.ts",
  "packages/etl/src/geometry/graph.ts",
  "packages/etl/src/geometry/overture.ts",
  "packages/etl/src/geometry/railbin.ts",
  "packages/etl/src/geometry/refresh-rail.ts",
  "packages/web/scripts/basemap.ts",
];

/** Hash of ASSET_SOURCES as last reviewed (`--hash`); the version line of this file is left out of it. */
export const ASSETS_SOURCE_HASH = "a3b4a7feb6280a73";

/** What the bucket's version.json holds. */
export interface AssetsStamp {
  assetsVersion: number;
  coverage: string;
  coverageBoxes: number[][];
  keys: string[];
}
export interface AssetsVersionFile extends AssetsStamp {
  /** When refresh-assets wrote it (ISO), the commit it ran, the parts it rebuilt. */
  builtAt?: string;
  commit?: string;
  parts?: string[];
}

/** The stamp of the current code. */
export function assetsStamp(): AssetsStamp {
  return { assetsVersion: ASSETS_VERSION, coverage: COVERAGE_ID, coverageBoxes: COVERAGE_BOXES.map((b) => [...b]), keys: [...ASSET_KEYS].sort() };
}

/** Whether the bucket's version.json (null: missing / unreadable) matches the code; the reasons when not. */
export function compareStamp(expected: AssetsStamp, actual: Partial<AssetsVersionFile> | null): { current: boolean; reasons: string[] } {
  if (!actual) return { current: false, reasons: ["no version.json in the bucket"] };
  const reasons: string[] = [];
  if (actual.assetsVersion !== expected.assetsVersion) reasons.push(`assets version ${actual.assetsVersion ?? "?"} in the bucket, ${expected.assetsVersion} in the code`);
  if (actual.coverage !== expected.coverage || JSON.stringify(actual.coverageBoxes) !== JSON.stringify(expected.coverageBoxes))
    reasons.push(`coverage ${actual.coverage ?? "?"} ${JSON.stringify(actual.coverageBoxes ?? null)} in the bucket, ${expected.coverage} ${JSON.stringify(expected.coverageBoxes)} in the code`);
  const have = [...(actual.keys ?? [])].sort();
  if (JSON.stringify(have) !== JSON.stringify(expected.keys)) {
    const missing = expected.keys.filter((k) => !have.includes(k));
    const extra = have.filter((k) => !expected.keys.includes(k));
    reasons.push(`asset keys differ (${[missing.length ? `missing ${missing.join(", ")}` : "", extra.length ? `retired ${extra.join(", ")}` : ""].filter(Boolean).join("; ")})`);
  }
  return { current: reasons.length === 0, reasons };
}

/** Hash of the asset-defining sources (line endings normalised; the ASSETS_SOURCE_HASH line itself left out). */
export function assetSourcesHash(root = repoRoot): string {
  const h = createHash("sha256");
  for (const f of ASSET_SOURCES) {
    const p = join(root, f);
    const text = existsSync(p) ? readFileSync(p, "utf8").replace(/\r\n/g, "\n") : "(missing)";
    h.update(f + "\0" + text.split("\n").filter((l) => !l.startsWith("export const ASSETS_SOURCE_HASH")).join("\n") + "\0");
  }
  return h.digest("hex").slice(0, 16);
}

function readJson(file: string): Partial<AssetsVersionFile> | null {
  if (!existsSync(file)) return null;
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return j && typeof j === "object" ? (j as Partial<AssetsVersionFile>) : null;
  } catch {
    return null;
  }
}

function main(argv: string[]): void {
  const a = argv.filter((x) => x !== "--");
  const get = (n: string) => (a.indexOf(n) >= 0 ? a[a.indexOf(n) + 1] : undefined);
  const stamp = assetsStamp();
  if (a.includes("--stamp")) console.log(JSON.stringify(stamp));
  else if (a.includes("--hash")) console.log(assetSourcesHash());
  else if (get("--write")) {
    const parts = (get("--parts") ?? ASSET_PARTS.join(",")).split(",").filter(Boolean);
    const out: AssetsVersionFile = { ...stamp, builtAt: new Date().toISOString(), ...(process.env.GITHUB_SHA ? { commit: process.env.GITHUB_SHA } : {}), parts };
    writeFileSync(get("--write")!, JSON.stringify(out, null, 1) + "\n");
    console.log(JSON.stringify(out));
  } else if (get("--check")) {
    const r = compareStamp(stamp, readJson(get("--check")!));
    const reason = r.current ? "assets match the code" : r.reasons.join("; ");
    console.log(`${r.current ? "current" : "STALE"}: ${reason}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `current=${r.current}\nreason=${reason.replace(/\n/g, " ")}\n`);
  } else {
    console.error("usage: assets-version.ts --stamp | --hash | --write <file> [--parts a,b] | --check <file>");
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
