import { existsSync } from "node:fs";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Db } from "./db.ts";
import { downloadWithFallback, fetchText, mapLimit } from "./download.ts";
import { loadFeedsConfig, resolveFeeds, type ResolvedFeed, type Tier } from "./feeds.ts";
import { LOAD_VERSION, initSchema, loadFeed, type FeedLoadStats } from "./gtfs/load.ts";
import { zipExpired } from "./gtfs/validity.ts";
import { runBuild } from "./build.ts";
import { runGenerator } from "./generators/registry.ts";
import type { GeneratorReport } from "./generators/types.ts";
import { todayIn } from "./core/time.ts";
import { StageTimer, log, warn } from "./util/log.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

export interface CliArgs {
  out: string;
  work: string;
  feeds?: string[];
  tiers: Tier[];
  days: number;
  startDate: string;
  reuseDb: boolean;
  geometry: boolean;
  basemap: boolean;
  /** Build the local-transport layer (metro / tram / city bus tiles). */
  urban: boolean;
  /** Compute transit transfer times from the local timetables (metro / tram / suburban rail, urban/transit.ts). */
  transit: boolean;
  maxAgeH?: number;
  build?: string;
  /** Directory mirroring the R2 asset bucket (GeoNames places, basemap, rail graph). */
  assets: string;
  /** Allow the slow Overture rail extraction when no rail asset is present. */
  extractRail: boolean;
  /** Only export coach/bus stop-name review candidates (JSONL) and stop. */
  stopCandidates?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const a = argv.filter((x) => x !== "--");
  const get = (name: string) => {
    const i = a.indexOf(name);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const has = (name: string) => a.includes(name);
  const subset = get("--subset") ?? "full";
  const tiers = (get("--tiers")?.split(",") ?? (subset === "core" ? ["core"] : ["core", "bus"])) as Tier[];
  const stopCandidates = get("--stop-candidates");
  const out = get("--out") ?? (stopCandidates ? join(repoRoot, "work", "out-unused") : undefined);
  if (!out) {
    console.error(
      "usage: build-data --out <dir> [--feeds id1,id2] [--work <dir>] [--subset full|core] [--days 60] [--start YYYY-MM-DD]\n" +
        "                  [--reuse-db] [--no-geometry] [--no-basemap] [--no-urban] [--no-transit] [--max-age-h N] [--assets <dir>] [--extract-rail]",
    );
    process.exit(2);
  }
  return {
    out: resolve(out),
    work: resolve(get("--work") ?? join(repoRoot, "work")),
    feeds: get("--feeds")?.split(",").map((s) => s.trim()).filter(Boolean),
    tiers,
    days: Number(get("--days") ?? 60),
    // Start one day before "today in Berlin" so viewers west of Berlin (still on the
    // previous date) and trains running past midnight stay inside the timetable.
    startDate: get("--start") ?? todayIn("Europe/Berlin", new Date(Date.now() - 86_400_000)),
    reuseDb: has("--reuse-db"),
    geometry: !has("--no-geometry"),
    basemap: !has("--no-basemap"),
    urban: !has("--no-urban"),
    transit: !has("--no-transit"),
    maxAgeH: get("--max-age-h") ? Number(get("--max-age-h")) : undefined,
    build: get("--build"),
    assets: resolve(get("--assets") ?? join(resolve(get("--work") ?? join(repoRoot, "work")), "assets")),
    extractRail: has("--extract-rail"),
    stopCandidates: stopCandidates ? resolve(stopCandidates) : undefined,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const timer = new StageTimer();
  const t0 = Date.now();
  const cacheDir = join(args.work, "cache");
  const tmpDir = join(args.work, "tmp");
  const dbPath = join(args.work, "etl.duckdb");
  await mkdir(cacheDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });
  log(`build-data: out=${args.out} work=${args.work} start=${args.startDate} days=${args.days} tiers=${args.tiers.join(",")}`);

  const cfg = await loadFeedsConfig(join(here, "..", "feeds.json"));

  timer.start("resolve");
  const feeds = await resolveFeeds(cfg, { only: args.feeds, tiers: args.tiers, cacheDir });
  log(`${feeds.length} feed files to process`);
  let licenses: unknown[] = [];
  try {
    licenses = JSON.parse(await fetchText(cfg.transitousBase + "license.json", cfg.userAgent, join(cacheDir, "transitous-license.json")));
  } catch (e) {
    warn(`license.json: ${(e as Error).message}`);
  }

  const feedStats: FeedLoadStats[] = [];
  const failed: string[] = [];
  /** feeds whose service ended before the build's first day (gtfs/validity.ts): skipped */
  const expired: { key: string; reason: string }[] = [];
  const stateFile = join(args.work, "db-state.json");
  const cfgText = await readFile(join(here, "..", "feeds.json"), "utf8");
  const stateKey = JSON.stringify({ feeds: feeds.map((f) => f.key), start: args.startDate, days: args.days, tiers: args.tiers, load: LOAD_VERSION, cfgLen: cfgText.length, cfgHash: cfgText.split("").reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7), ops: cfg.operators?.loadFingerprint() ?? 0, gens: cfg.generators?.fingerprint ?? 0 });
  let reuse = false;
  if (args.reuseDb && existsSync(dbPath) && existsSync(stateFile)) {
    const st = JSON.parse(await readFile(stateFile, "utf8"));
    if (st.key === stateKey) {
      reuse = true;
      feedStats.push(...st.feedStats);
      expired.push(...(st.expired ?? []));
      log("reusing existing DuckDB database (--reuse-db)");
    } else warn("--reuse-db: database was built with different inputs, rebuilding");
  }

  if (!reuse) {
    await rm(dbPath, { force: true });
    await rm(dbPath + ".wal", { force: true });
  }
  const db = await Db.open(dbPath, { threads: 4, memoryLimit: process.env.ETL_DUCKDB_MEMORY ?? "4GB", tempDir: join(tmpDir, "duckdb") });

  const generated: GeneratorReport[] = [];
  if (!reuse) {
    timer.start("download+load");
    await initSchema(db);
    const present = new Set(feeds.map((f) => f.def.id));
    const dropBus = !args.tiers.includes("bus");
    // Generated feeds (packages/etl/generators) all start right away, beside the downloads: they fetch and parse
    // the operators' pages (some take minutes) and write a zip into the cache; a failed one is skipped like a failed
    // download.
    const genRuns = new Map<string, Promise<string | null>>();
    for (const rf of feeds) {
      const g = rf.generator ? cfg.generators?.generators.get(rf.generator) : undefined;
      if (!g) continue;
      const dest = join(cacheDir, "feeds", rf.key + ".zip");
      genRuns.set(
        rf.key,
        runGenerator(g, rf.key, { userAgent: cfg.userAgent, startDate: args.startDate, days: args.days, dest, tmpDir }).then(({ report }) => {
          generated.push(report);
          return report.ok ? dest : null;
        }),
      );
    }
    // Downloads run 3 at a time ahead of processing; processing is sequential.
    const downloads = new Map<string, Promise<string | null>>();
    let started = 0;
    const startDownload = (rf: ResolvedFeed) => {
      const gen = genRuns.get(rf.key);
      if (gen) {
        downloads.set(rf.key, gen);
        return;
      }
      const dest = join(cacheDir, "feeds", rf.key + ".zip");
      const p = downloadWithFallback(rf.urls, dest, cfg.userAgent, args.maxAgeH)
        .then(() => dest)
        .catch((e) => {
          warn(`feed ${rf.key}: download failed: ${(e as Error).message}`);
          return null;
        });
      downloads.set(rf.key, p);
    };
    const pump = () => {
      // keep up to 3 downloads in flight beyond the one being processed
      while (started < feeds.length && [...downloads.keys()].length - processed < 4) startDownload(feeds[started++]!);
    };
    let processed = 0;
    pump();
    for (let i = 0; i < feeds.length; i++) {
      const rf = feeds[i]!;
      if (!downloads.has(rf.key)) startDownload(rf);
      const zip = await downloads.get(rf.key)!;
      processed++;
      pump();
      if (!zip) {
        failed.push(rf.key);
        continue;
      }
      const lctx = { db, cfg, startDate: args.startDate, days: args.days, tmpDir, presentFeedIds: present, dropBus };
      let st: FeedLoadStats | null = null;
      // A feed whose service has ended is not loaded at all (it drops out of the build and the attribution by
      // itself and comes back when its source publishes a new timetable); its fallbacks may be newer.
      let outOfDate = await zipExpired(zip, args.startDate);
      if (outOfDate) warn(`feed ${rf.key}: out of date (${outOfDate}), skipped`);
      else
        try {
          st = await loadFeed(lctx, i, rf, zip);
        } catch (e) {
          warn(`feed ${rf.key}: load failed: ${(e as Error).stack ?? e}`);
        }
      // Stale or broken primary source: try the fallbacks.
      for (let u = 1; (!st || st.trips === 0) && u < rf.urls.length; u++) {
        const dest = join(cacheDir, "feeds", `${rf.key}.fallback${u}.zip`);
        try {
          await downloadWithFallback([rf.urls[u]!], dest, cfg.userAgent, args.maxAgeH);
          const fx = await zipExpired(dest, args.startDate);
          if (fx) {
            warn(`feed ${rf.key}: fallback ${rf.urls[u]} out of date too (${fx})`);
            continue;
          }
          warn(`feed ${rf.key}: no usable data from primary source, trying ${rf.urls[u]}`);
          st = await loadFeed(lctx, i, rf, dest);
          outOfDate = null;
        } catch (e) {
          warn(`feed ${rf.key}: fallback ${u} failed: ${(e as Error).message}`);
        }
      }
      if (st) feedStats.push(st);
      else if (outOfDate) expired.push({ key: rf.key, reason: outOfDate });
      else failed.push(rf.key);
    }
    // what the operator adapters changed while loading (kept with the database for --reuse-db runs)
    const opRows = cfg.operators?.summaryRows() ?? [];
    if (opRows.length) await db.insertRows("operator_log", [{ name: "adapter", type: "VARCHAR" }, { name: "feed", type: "VARCHAR" }, { name: "field", type: "VARCHAR" }, { name: "n", type: "INTEGER" }], opRows, join(tmpDir, "operator_log.csv"));
    await db.run("CHECKPOINT");
    await writeFile(stateFile, JSON.stringify({ key: stateKey, feedStats, expired }));
  }

  if (generated.length) log(`feed generators: ${generated.map((g) => `${g.id} ${g.ok ? "ok" : "FAILED"}`).join(", ")}`);
  if (expired.length) log(`out-of-date feeds skipped: ${expired.map((e) => `${e.key} (${e.reason})`).join(", ")}`);
  await runBuild({ db, args, cfg, feeds, feedStats, failed, expired, generated, licenses, timer, cacheDir, tmpDir, t0 });
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export { mapLimit };
