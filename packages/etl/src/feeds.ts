import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchText } from "./download.ts";
import { warn } from "./util/log.ts";

export type ModeClass = "rail" | "coach" | "bus";
export type Tier = "core" | "bus";

export type FeedSource =
  | { transitous: string }
  | { transitousMatch: string }
  | { url: string };

export interface FeedOptions {
  /** Force category of all rail routes in this feed. */
  railCat?: "LongDistance" | "Regional";
  /** Category for rail routes the classifier cannot decide (instead of the per-trip heuristic). */
  railCatDefault?: "LongDistance" | "Regional";
  /** Treat every bus route (3, 7xx, 2xx) of this feed as Coach. */
  allCoach?: boolean;
  /** Treat route_type 200–209 as regular Bus (e.g. HU Volánbusz uses 200 for everything). */
  coachTypesAsBus?: boolean;
  /** Set Flag.DTicket on Regional rail and Bus. */
  dticket?: boolean;
  /** Set Flag.Night on all trips. */
  night?: boolean;
  /** Load shapes.txt for kept rail trips (default true). */
  shapes?: boolean;
  /** Regex (case-insensitive) on agency name: drop these routes. */
  dropAgencies?: string;
  /** Regex on agency name: keep only these routes. */
  onlyAgencies?: string;
  /** Minimum straight-line span (km) of a bus route (default from config). */
  minBusKm?: number;
  /** Regex with one capture group applied to trip_id to get the train category when trip_short_name is missing. */
  tripPrefixRegex?: string;
  /** Display names for train categories (prefix → name), e.g. {"OUI": "TGV INOUI"}. */
  prefixNames?: Record<string, string>;
  /** trip_headsign holds the train number (SNCF): use it as number, derive headsign from the last stop. */
  headsignIsNumber?: boolean;
  /** Priority in cross-feed dedup (higher wins ties). Default 0. */
  priority?: number;
}

export interface FeedDef {
  id: string;
  country: string;
  name: string;
  tier: Tier;
  keep: ModeClass[];
  /** First = primary; the rest are fallbacks, tried in order. */
  sources: FeedSource[];
  options?: FeedOptions;
  /** Attribution for non-Transitous sources (Transitous ones come from license.json). */
  license?: string;
  attribution?: string;
  licenseUrl?: string;
  notes?: string;
  approxMB?: number;
  disabled?: boolean;
}

export interface DedicatedOperator {
  /** Regex (case-insensitive) matched against agency name, route short & long name. */
  pattern: string;
  /** Feeds that are the authoritative source for this operator. */
  feeds: string[];
}

export interface FeedsConfig {
  userAgent: string;
  transitousBase: string;
  minBusKm: number;
  dedicatedOperators: DedicatedOperator[];
  coachOperators: string;
  urbanAgencies: string;
  feeds: FeedDef[];
}

/** A concrete file to download and process (multi-file feeds expand into several). */
export interface ResolvedFeed {
  /** Unique id (feed id, or feed id + "~" + file stem for multi-file feeds). */
  key: string;
  def: FeedDef;
  urls: string[];
  /** Transitous filename if from Transitous (for license lookup). */
  transitousFile?: string;
}

export async function loadFeedsConfig(path: string): Promise<FeedsConfig> {
  return JSON.parse(await readFile(path, "utf8")) as FeedsConfig;
}

/** Parse the nginx autoindex HTML of the Transitous mirror into a list of file names. */
export function parseListing(html: string): string[] {
  const out: string[] = [];
  const re = /<a href="([^"?/]+\.gtfs\.zip)">/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(decodeURIComponent(m[1]!));
  return out;
}

export function slug(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\.gtfs\.zip$/, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function transitousUrl(base: string, file: string): string {
  return base + encodeURIComponent(file).replace(/%2C/g, ",");
}

export async function resolveFeeds(
  cfg: FeedsConfig,
  opts: { only?: string[]; tiers: Tier[]; cacheDir: string },
): Promise<ResolvedFeed[]> {
  let listing: string[] | null = null;
  const getListing = async () => {
    if (listing) return listing;
    try {
      const html = await fetchText(cfg.transitousBase, cfg.userAgent, join(opts.cacheDir, "transitous-index.html"));
      listing = parseListing(html);
    } catch (e) {
      warn(`could not fetch Transitous listing: ${(e as Error).message}`);
      listing = [];
    }
    return listing;
  };

  const out: ResolvedFeed[] = [];
  for (const def of cfg.feeds) {
    if (def.disabled) continue;
    if (opts.only && opts.only.length) {
      if (!opts.only.includes(def.id)) continue;
    } else if (!opts.tiers.includes(def.tier)) continue;

    const multi = def.sources.find((s): s is { transitousMatch: string } => "transitousMatch" in s);
    if (multi) {
      const re = new RegExp(multi.transitousMatch);
      const files = (await getListing()).filter((f) => re.test(f));
      if (!files.length) warn(`feed ${def.id}: no Transitous file matches ${multi.transitousMatch}`);
      for (const f of files) {
        out.push({
          key: files.length === 1 ? def.id : `${def.id}~${slug(f.replace(/^[a-z]{2}_/, ""))}`,
          def,
          urls: [transitousUrl(cfg.transitousBase, f)],
          transitousFile: f,
        });
      }
      continue;
    }
    const urls: string[] = [];
    let transitousFile: string | undefined;
    for (const s of def.sources) {
      if ("url" in s) urls.push(s.url);
      else if ("transitous" in s) {
        // Year-suffixed names may change; resolve a missing one by stem match.
        let f = s.transitous;
        const l = await getListing();
        if (l.length && !l.includes(f)) {
          const stem = f.replace(/-?\d{2,4}(\.gtfs\.zip)$/, "");
          const alt = l.find((x) => x.startsWith(stem) && /\d{2,4}\.gtfs\.zip$/.test(x));
          if (alt) f = alt;
          else warn(`feed ${def.id}: ${f} not in Transitous listing`);
        }
        urls.push(transitousUrl(cfg.transitousBase, f));
        transitousFile ??= f;
      }
    }
    out.push({ key: def.id, def, urls, transitousFile });
  }
  return out;
}
