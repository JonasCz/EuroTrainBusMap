import { existsSync } from "node:fs";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Db } from "./db.ts";
import { downloadWithFallback, fetchText, mapLimit } from "./download.ts";
import { loadFeedsConfig, resolveFeeds, type ResolvedFeed, type Tier } from "./feeds.ts";
import { initSchema, loadFeed, type FeedLoadStats } from "./gtfs/load.ts";
import { runBuild } from "./build.ts";
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
  maxAgeH?: number;
  build?: string;
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
  const out = get("--out");
  if (!out) {
    console.error(
      "usage: build-data --out <dir> [--feeds id1,id2] [--work <dir>] [--subset full|core] [--days 60] [--start YYYY-MM-DD]\n" +
        "                  [--reuse-db] [--no-geometry] [--no-basemap] [--max-age-h N]",
    );
    process.exit(2);
  }
  return {
    out: resolve(out),
    work: resolve(get("--work") ?? join(repoRoot, "work")),
    feeds: get("--feeds")?.split(",").map((s) => s.trim()).filter(Boolean),
    tiers,
    days: Number(get("--days") ?? 60),
    startDate: get("--start") ?? todayIn("Europe/Berlin"),
    reuseDb: has("--reuse-db"),
    geometry: !has("--no-geometry"),
    basemap: !has("--no-basemap"),
    maxAgeH: get("--max-age-h") ? Number(get("--max-age-h")) : undefined,
    build: get("--build"),
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
  const stateFile = join(args.work, "db-state.json");
  const cfgText = await readFile(join(here, "..", "feeds.json"), "utf8");
  const stateKey = JSON.stringify({ feeds: feeds.map((f) => f.key), start: args.startDate, days: args.days, tiers: args.tiers, cfgLen: cfgText.length, cfgHash: cfgText.split("").reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7) });
  let reuse = false;
  if (args.reuseDb && existsSync(dbPath) && existsSync(stateFile)) {
    const st = JSON.parse(await readFile(stateFile, "utf8"));
    if (st.key === stateKey) {
      reuse = true;
      feedStats.push(...st.feedStats);
      log("reusing existing DuckDB database (--reuse-db)");
    } else warn("--reuse-db: database was built with different inputs, rebuilding");
  }

  if (!reuse) {
    await rm(dbPath, { force: true });
    await rm(dbPath + ".wal", { force: true });
  }
  const db = await Db.open(dbPath, { threads: 4, memoryLimit: process.env.ETL_DUCKDB_MEMORY ?? "6GB", tempDir: join(tmpDir, "duckdb") });

  if (!reuse) {
    timer.start("download+load");
    await initSchema(db);
    const present = new Set(feeds.map((f) => f.def.id));
    const dropBus = !args.tiers.includes("bus");
    // Downloads run 3 at a time ahead of processing; processing is sequential.
    const downloads = new Map<string, Promise<string | null>>();
    let started = 0;
    const startDownload = (rf: ResolvedFeed) => {
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
          warn(`feed ${rf.key}: no usable data from primary source, trying ${rf.urls[u]}`);
          st = await loadFeed(lctx, i, rf, dest);
        } catch (e) {
          warn(`feed ${rf.key}: fallback ${u} failed: ${(e as Error).message}`);
        }
      }
      if (st) feedStats.push(st);
      if (!st) failed.push(rf.key);
    }
    await db.run("CHECKPOINT");
    await writeFile(stateFile, JSON.stringify({ key: stateKey, feedStats }));
  }

  await runBuild({ db, args, cfg, feeds, feedStats, failed, licenses, timer, cacheDir, tmpDir, t0 });
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export { mapLimit };
