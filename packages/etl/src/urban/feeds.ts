import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { Db } from "../db.ts";
import { downloadWithFallback } from "../download.ts";
import { resolveFeeds, type FeedDef, type FeedsConfig, type ResolvedFeed } from "../feeds.ts";
import { loadPlaces } from "../geonames.ts";
import { log, warn } from "../util/log.ts";
import { cityDiscs, DiscIndex, type MainBusRule } from "./classify.ts";
import { extractFeed } from "./extract.ts";
import { STALE_MAX_DAYS, zipState } from "../gtfs/validity.ts";
import { EXTRACT_VERSION, type UrbanFeed } from "./types.ts";

/** Cities from this population on are left out of their stops' names (stripCityName). */
export const NAME_CITY_MIN_POP = 100_000;

export interface UrbanFeedsFile {
  feeds: FeedDef[];
}

export interface GatherOptions {
  cfg: FeedsConfig;
  urbanFeeds: FeedDef[];
  workDir: string;
  assetsDir: string;
  startDate: string;
  /** Download extra feeds that are not cached yet. */
  download: boolean;
  only?: string[];
  maxAgeH?: number;
  /** Cap on stale feeds (gtfs/validity.ts; default STALE_MAX_DAYS). */
  staleMaxDays?: number;
}

/** Wednesday at least a week after `start`: a typical weekday inside the calendar horizon. */
export function refWeekday(start: string): string {
  const d = new Date(start + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 7);
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** A stale feed's reference day: the Wednesday of the last full week before its end (`end`: its last service day). */
export function staleRefWeekday(end: string): string {
  const d = new Date(end + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 7);
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * From which span the intercity network carries a feeds.json feed's buses (classify.ts busExclusion): the feeds that
 * load buses, with their `minBusKm` and the agency filters of the intercity loader (gtfs/load.ts, core/classify.ts).
 */
export function mainBusRule(def: FeedDef, cfg: FeedsConfig): MainBusRule | null {
  const o = def.options ?? {};
  if (!def.keep.includes("bus") && !(o.allCoach && def.keep.includes("coach"))) return null;
  const drop = [cfg.urbanAgencies, o.dropAgencies].filter(Boolean).map((r) => `(?:${r})`).join("|");
  return { minKm: o.minBusKm ?? cfg.minBusKm, dropAgency: drop ? new RegExp(drop, "i") : null, onlyAgency: o.onlyAgencies ? new RegExp(o.onlyAgencies, "i") : null };
}

const ruleStamp = (r: MainBusRule | null) => (r ? `${r.minKm}/${r.dropAgency?.source ?? ""}/${r.onlyAgency?.source ?? ""}` : "local");

/** A feed that contributed lines (attribution). */
export interface GatheredFeed {
  key: string;
  expired?: string;
}

/**
 * Extract the local lines of every feed: the intercity feeds of feeds.json (re-using their cached zips)
 * and the extra local feeds of urban-feeds.json (downloaded into the same cache). Extractions are cached
 * per feed in work/urban/ keyed by zip size, extractor version, reference day and bus rule. The feeds are handed to
 * `onFeed` one by one, in a fixed order (its index), and not kept: the layer is built region by region (regions.ts).
 */
export async function gatherFeeds(o: GatherOptions, onFeed: (feed: UrbanFeed, index: number) => Promise<void> | void): Promise<{ feeds: GatheredFeed[]; cities: DiscIndex }> {
  const cacheDir = join(o.workDir, "cache");
  const outDir = join(o.workDir, "urban");
  await mkdir(join(outDir, "feeds"), { recursive: true });
  const tmpDir = join(o.workDir, "tmp");
  await mkdir(tmpDir, { recursive: true });
  const base = await resolveFeeds(o.cfg, { tiers: ["core", "bus"], cacheDir, ...(o.only ? { only: o.only } : {}) });
  // coach-only feeds (FlixBus, BlaBlaCar…) have no local transport
  const baseFeeds = base.filter((f) => f.def.keep.some((k) => k !== "coach"));
  const extra = await resolveFeeds({ ...o.cfg, feeds: o.urbanFeeds }, { tiers: ["core"], cacheDir });
  const places = await loadPlaces(cacheDir, o.cfg.userAgent, o.assetsDir);
  const cityIdx = new DiscIndex(cityDiscs(places, NAME_CITY_MIN_POP));
  const coachRe = new RegExp(o.cfg.coachOperators, "i");
  const refDate = refWeekday(o.startDate);
  const db = await Db.open(":memory:", { threads: 4, memoryLimit: process.env.ETL_DUCKDB_MEMORY ?? "4GB", tempDir: join(tmpDir, "duckdb-urban") });
  const result: GatheredFeed[] = [];
  const todo: { rf: ResolvedFeed; main: MainBusRule | null }[] = [...baseFeeds.map((rf) => ({ rf, main: mainBusRule(rf.def, o.cfg) })), ...extra.map((rf) => ({ rf, main: null }))];
  // downloads of extra feeds run a few ahead of the extraction
  const dl = new Map<string, Promise<string | null>>();
  const extraKeys = new Set(extra.map((e) => e.key));
  const startDl = (rf: ResolvedFeed) => {
    if (dl.has(rf.key)) return;
    const dest = join(cacheDir, "feeds", rf.key + ".zip");
    dl.set(
      rf.key,
      (existsSync(dest) && !o.maxAgeH
        ? Promise.resolve(dest)
        : o.download && extraKeys.has(rf.key) // the intercity feeds were downloaded by the main stage (cache/feeds)
          ? downloadWithFallback(rf.urls, dest, o.cfg.userAgent, o.maxAgeH).then(() => dest)
          : Promise.resolve(existsSync(dest) ? dest : null)
      ).catch((e) => {
        warn(`urban feed ${rf.key}: download failed: ${(e as Error).message}`);
        return null;
      }),
    );
  };
  let nextDl = 0;
  for (let i = 0; i < todo.length; i++) {
    const { rf, main } = todo[i]!;
    while (nextDl < todo.length && nextDl < i + 4) startDl(todo[nextDl++]!.rf);
    const zip = await dl.get(rf.key);
    if (!zip) continue;
    // a feed whose service has ended is read on a weekday of its last weeks and its lines are marked out of date;
    // one that ended more than staleMaxDays ago is left out (gtfs/validity.ts; the main stage warns for its own feeds)
    const state = await zipState(zip, o.startDate, o.staleMaxDays ?? STALE_MAX_DAYS);
    if (state.kind === "too-old") {
      if (extraKeys.has(rf.key)) warn(`urban feed ${rf.key}: out of date (${state.reason}), skipped`);
      continue;
    }
    if (state.kind === "stale" && extraKeys.has(rf.key)) warn(`urban feed ${rf.key}: out of date (${state.reason}): kept, its lines read from ${staleRefWeekday(state.end)} and labelled`);
    const ref = state.kind === "stale" ? staleRefWeekday(state.end) : refDate;
    const st = await stat(zip);
    const cacheFile = join(outDir, "feeds", `${rf.key}.json.gz`);
    const stamp = `${st.size}:${EXTRACT_VERSION}:${ref}:${ruleStamp(main)}`;
    let feed: UrbanFeed | null = null;
    if (existsSync(cacheFile)) {
      try {
        const j = JSON.parse(gunzipSync(await readFile(cacheFile)).toString("utf8")) as UrbanFeed & { stamp?: string };
        if (j.stamp === stamp) feed = j;
      } catch {
        /* re-extract */
      }
    }
    if (!feed) {
      const t0 = Date.now();
      feed = await extractFeed(db, rf.key, zip, { refDate: ref, coachRe, mainBus: main, tmpDir });
      if (feed) await writeFile(cacheFile, gzipSync(JSON.stringify({ ...feed, stamp })));
      else await writeFile(cacheFile, gzipSync(JSON.stringify({ key: rf.key, version: EXTRACT_VERSION, lines: [], stops: [], stats: { routes: 0, kept: 0, shaped: 0, dropped: {} }, stamp })));
      if (feed) log(`urban ${rf.key}: ${feed.lines.length} lines (${feed.stats.shaped} shaped patterns), ${feed.stops.length} stops, ${feed.stats.routes} candidate routes, ${JSON.stringify(feed.stats.dropped)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    if (feed && feed.lines.length) {
      const expired = state.kind === "stale" ? { expired: state.end } : {};
      await onFeed({ ...feed, key: rf.key, ...expired }, i);
      result.push({ key: rf.key, ...expired });
    }
  }
  db.close();
  return { feeds: result, cities: cityIdx };
}
