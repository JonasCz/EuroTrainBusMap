/**
 * Registry of the feed generators (packages/etl/generators/*.ts; interface in types.ts, documentation in the README
 * of that directory). It loads every generator file, checks that feeds.json and the generators refer to each other
 * (a `{ "generated": "<id>" }` source names an existing generator, every generator is used by exactly one feed) and
 * runs a generator for the build: the feed is validated and written as a zip into the feed cache, where the loader
 * picks it up like a downloaded one. A failing generator never fails the build: its source is logged and skipped,
 * and a zip of an earlier run is deleted so no stage (load, local transport, transit) uses outdated data.
 */
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchPage } from "../download.ts";
import type { FeedDef } from "../feeds.ts";
import { log as defaultLog, warn as defaultWarn } from "../util/log.ts";
import { addDays, feedCounts, retrievalTime, validateGtfs, writeGtfsZip, type GtfsFeed } from "./gtfs.ts";
import type { FeedGenerator, GeneratorContext, GeneratorReport } from "./types.ts";

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Generator files: lower-case names; files starting with "_" (the template) and tests are not generators. */
const FILE_RE = /^([a-z0-9][a-z0-9-]*)\.ts$/;

export class GeneratorConfigError extends Error {
  constructor(message: string) {
    super(`feed generators: ${message}`);
    this.name = "GeneratorConfigError";
  }
}

export interface GeneratorSet {
  /** by id */
  generators: Map<string, FeedGenerator>;
  /** Fingerprint of the generators' source text (part of the --reuse-db key). */
  fingerprint: number;
}

function hash(s: string): number {
  return s.split("").reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);
}

/** Load all generators of a directory, sorted by file name; each file default-exports one generator whose id is its name. */
export async function loadGeneratorFiles(dir: string): Promise<GeneratorSet> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => FILE_RE.test(n) && !n.endsWith(".test.ts")).sort();
  } catch {
    return { generators: new Map(), fingerprint: 0 };
  }
  const generators = new Map<string, FeedGenerator>();
  const texts: string[] = [];
  for (const n of names) {
    const path = join(dir, n);
    const g = ((await import(pathToFileURL(path).href)) as { default?: FeedGenerator }).default;
    const stem = FILE_RE.exec(n)![1]!;
    if (!g || typeof g !== "object" || typeof g.generate !== "function") throw new GeneratorConfigError(`${n} has no default export (export default defineGenerator({...}))`);
    if (g.id !== stem || !ID_RE.test(g.id)) throw new GeneratorConfigError(`${n}: id "${g.id}" must equal the file name "${stem}"`);
    if (!/^https?:\/\//.test(g.sourceUrl ?? "")) throw new GeneratorConfigError(`${n}: sourceUrl must be the http(s) URL of the timetable page`);
    generators.set(g.id, g);
    texts.push(n, await readFile(path, "utf8"));
  }
  return { generators, fingerprint: texts.length ? hash(texts.join("\u0001")) : 0 };
}

/** The generator a feed definition uses (`{ "generated": id }` source), or undefined. */
export function generatedSource(def: Pick<FeedDef, "sources">): string | undefined {
  for (const s of def.sources) if ("generated" in s) return s.generated;
  return undefined;
}

/**
 * Check feeds.json against the generators and fill in each generated feed's `timetableUrl` (the generator's
 * sourceUrl, unless the feed sets one). A generated feed has exactly one source; a generator not used by any
 * feed is an error too (a forgotten feeds.json entry would silently never run).
 */
export function applyGenerators(feeds: FeedDef[], set: GeneratorSet): void {
  const used = new Map<string, string>();
  for (const f of feeds) {
    const id = generatedSource(f);
    if (!id) continue;
    if (f.sources.length !== 1) throw new GeneratorConfigError(`feed ${f.id}: a generated feed has exactly one source`);
    const g = set.generators.get(id);
    if (!g) throw new GeneratorConfigError(`feed ${f.id}: no generator "${id}" (packages/etl/generators/${id}.ts)`);
    if (used.has(id)) throw new GeneratorConfigError(`generator ${id} is used by feeds ${used.get(id)} and ${f.id}`);
    used.set(id, f.id);
    f.timetableUrl ??= g.sourceUrl;
  }
  for (const id of set.generators.keys()) if (!used.has(id)) throw new GeneratorConfigError(`generator ${id} is not used by any feed of feeds.json (add a feed with "sources": [{ "generated": "${id}" }])`);
}

export interface RunOptions {
  userAgent: string;
  startDate: string;
  days: number;
  /** Where the zip goes (the feed cache: work/cache/feeds/<key>.zip). */
  dest: string;
  tmpDir: string;
  log?: (m: string) => void;
  warn?: (m: string) => void;
}

/** Context handed to a generator (also used by tests with a fake fetch). */
export function generatorContext(o: Pick<RunOptions, "userAgent" | "startDate" | "days"> & { id: string; warnings: string[]; log?: (m: string) => void; warn?: (m: string) => void; fetchText?: GeneratorContext["fetchText"] }): GeneratorContext {
  const lg = o.log ?? defaultLog, wn = o.warn ?? defaultWarn;
  return {
    startDate: o.startDate,
    days: o.days,
    fetchText: o.fetchText ?? ((url, opts) => fetchPage(url, o.userAgent, { ...(opts?.form ? { form: opts.form } : {}), ...(opts?.expect ? { expect: opts.expect } : {}) })),
    log: (m) => lg(`generator ${o.id}: ${m}`),
    warn: (m) => {
      o.warnings.push(m);
      wn(`generator ${o.id}: ${m}`);
    },
  };
}

/** The build's service window as dates (the loader reads days −1 … days of the start). */
export function serviceWindow(startDate: string, days: number): { from: string; to: string } {
  return { from: addDays(startDate, -1), to: addDays(startDate, days) };
}

/**
 * Run one generator: generate, validate, write the zip. Never throws: on failure the error is logged, the zip of an
 * earlier run is removed and the report says why (ok = false); the caller then skips the feed.
 */
export async function runGenerator(g: FeedGenerator, feedKey: string, o: RunOptions): Promise<{ report: GeneratorReport; feed?: GtfsFeed }> {
  const t0 = Date.now();
  const warnings: string[] = [];
  const ctx = generatorContext({ ...o, id: g.id, warnings });
  const retrievedAt = retrievalTime(new Date(t0));
  const report: GeneratorReport = { id: g.id, feed: feedKey, sourceUrl: g.sourceUrl, ok: false, warnings, seconds: 0, retrievedAt };
  try {
    ctx.log(`fetching ${g.sourceUrl}`);
    const feed = await g.generate(ctx);
    feed.info.retrievedAt ??= retrievedAt;
    validateGtfs(feed, serviceWindow(o.startDate, o.days));
    await writeGtfsZip(feed, o.dest, o.tmpDir);
    report.ok = true;
    report.counts = feedCounts(feed);
    const c = report.counts;
    ctx.log(`ok: ${c.trips} trips, ${c.stops} stops, ${c.stopTimes} stop times, service ${c.firstDate} … ${c.lastDate}`);
    return { report: { ...report, seconds: Math.round((Date.now() - t0) / 100) / 10 }, feed };
  } catch (e) {
    report.error = (e as Error).message ?? String(e);
    (o.warn ?? defaultWarn)(`generator ${g.id} FAILED, feed ${feedKey} skipped: ${report.error}`);
    if (existsSync(o.dest)) await rm(o.dest, { force: true });
    await rm(o.dest + ".meta.json", { force: true });
    return { report: { ...report, seconds: Math.round((Date.now() - t0) / 100) / 10 } };
  }
}
