/**
 * Registry of the operator adapters (packages/etl/operators/*.ts; interface in types.ts, documentation in the
 * README of that directory). It
 *  - loads every adapter file, sorted by id (= file name), so hooks always run in the same order;
 *  - applies the declarative parts to the feeds config once, when it is loaded (extra feeds, feed options,
 *    exclusive operators), refusing an option or feed that two sources set;
 *  - hands each feed only the adapters whose scope covers it, and each route only those whose agencies match;
 *  - fails the build when two adapters set the same field of the same row (or could, by their scopes);
 *  - records which adapter changed how many rows (log, build report, operator_log table).
 * Everything an adapter does is applied again on every build from the unchanged source files (re-runnable).
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Classification, RouteHooks, RouteInfo } from "../core/classify.ts";
import type { DedicatedOperator, FeedDef, FeedOptions, FeedsConfig, ModeClass } from "../feeds.ts";
import type { FeedRef, OperatorAdapter, RouteExtras, RouteFacts, RouteOverride } from "./types.ts";

export class OperatorConflictError extends Error {
  constructor(message: string) {
    super(`operator adapters: ${message}`);
    this.name = "OperatorConflictError";
  }
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Adapter files: lower-case names; files starting with "_" (the template) and tests are not adapters. */
const FILE_RE = /^([a-z0-9][a-z0-9-]*)\.ts$/;

/** Load all adapters of a directory, sorted by file name; each file default-exports one adapter whose id is its name. */
export async function loadOperatorFiles(dir: string): Promise<{ adapters: OperatorAdapter[]; sources: Map<string, string> }> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => FILE_RE.test(n) && !n.endsWith(".test.ts")).sort();
  } catch {
    return { adapters: [], sources: new Map() };
  }
  const adapters: OperatorAdapter[] = [];
  const sources = new Map<string, string>();
  for (const n of names) {
    const path = join(dir, n);
    const mod = (await import(pathToFileURL(path).href)) as { default?: OperatorAdapter };
    const a = mod.default;
    const stem = FILE_RE.exec(n)![1]!;
    if (!a || typeof a !== "object") throw new OperatorConflictError(`${n} has no default export (export default defineOperator({...}))`);
    if (a.id !== stem) throw new OperatorConflictError(`${n}: id "${a.id}" must equal the file name "${stem}"`);
    adapters.push(a);
    sources.set(a.id, await readFile(path, "utf8"));
  }
  return { adapters, sources };
}

type HookKind = "classify.before" | "classify.after" | "onLoad" | "route";
const HOOK_KINDS: HookKind[] = ["classify.before", "classify.after", "onLoad", "route"];
function hasHook(a: OperatorAdapter, k: HookKind): boolean {
  if (k === "classify.before") return !!a.classify?.before;
  if (k === "classify.after") return !!a.classify?.after;
  if (k === "onLoad") return !!a.onLoad;
  return !!a.route;
}

function inFeedScope(a: OperatorAdapter, f: { id: string; country: string }): boolean {
  const { feeds, countries } = a.appliesTo;
  if (!feeds?.length && !countries?.length) return true;
  return !!feeds?.includes(f.id) || !!countries?.includes(f.country);
}

function agencyMatch(a: OperatorAdapter, agency: string): boolean {
  const ags = a.appliesTo.agencies;
  return !ags?.length || ags.some((re) => re.test(agency));
}

function hash(s: string): number {
  return s.split("").reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);
}

/** Whether an adapter changes what the loader stores (then it is part of the --reuse-db key). */
function affectsLoad(a: OperatorAdapter): boolean {
  return !!(a.feedOptions || a.extraFeeds?.length || a.exclusive || a.classify || a.onLoad);
}

export class OperatorRegistry {
  /** Adapters in id order. */
  readonly adapters: OperatorAdapter[];
  /** adapter id → number of rows it changed, per feed and field ("classify.before", "route.brand", …) */
  private readonly counts = new Map<string, number>();
  private readonly routeCache = new Map<string, RouteExtras>();

  constructor(
    adapters: OperatorAdapter[],
    /** Feeds of the effective config (after extraFeeds), for scope checks. */
    feeds: Pick<FeedDef, "id" | "country">[],
    private readonly sources: Map<string, string> = new Map(),
  ) {
    this.adapters = [...adapters].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.validate(feeds);
  }

  private validate(feeds: Pick<FeedDef, "id" | "country">[]): void {
    const ids = new Set<string>();
    const known = new Set(feeds.map((f) => f.id));
    for (const a of this.adapters) {
      if (!ID_RE.test(a.id)) throw new OperatorConflictError(`invalid id "${a.id}" (lower-case letters, digits and "-")`);
      if (ids.has(a.id)) throw new OperatorConflictError(`two adapters with the id "${a.id}"`);
      ids.add(a.id);
      const s = a.appliesTo ?? {};
      if (!s.feeds?.length && !s.countries?.length && !s.agencies?.length)
        throw new OperatorConflictError(`${a.id}: appliesTo names no feeds, countries or agencies (a rule for every feed is a generic rule)`);
      for (const f of s.feeds ?? []) if (!known.has(f)) throw new OperatorConflictError(`${a.id}: unknown feed "${f}" in appliesTo.feeds`);
      if (a.feedOptions && (!s.feeds?.length || s.countries?.length || s.agencies?.length))
        throw new OperatorConflictError(`${a.id}: feedOptions need appliesTo.feeds only (options are per feed)`);
      for (const x of a.extraFeeds ?? [])
        if (!s.feeds?.includes(x.def.id)) throw new OperatorConflictError(`${a.id}: extra feed "${x.def.id}" is not in appliesTo.feeds`);
      if (a.exclusive) {
        if (!a.exclusive.feeds.length) throw new OperatorConflictError(`${a.id}: exclusive.feeds is empty`);
        for (const f of a.exclusive.feeds) {
          if (!known.has(f)) throw new OperatorConflictError(`${a.id}: unknown feed "${f}" in exclusive.feeds`);
          if (s.feeds?.length && !s.feeds.includes(f)) throw new OperatorConflictError(`${a.id}: exclusive feed "${f}" is not in appliesTo.feeds`);
        }
      }
    }
    // Two adapters with the same hook whose scopes overlap on whole feeds (at least one without an agency filter)
    // would both decide the same rows: refused here. With agency filters on both sides the overlap depends on the
    // data and is checked per row.
    const feedSet = (a: OperatorAdapter) => new Set(feeds.filter((f) => inFeedScope(a, f)).map((f) => f.id));
    for (let i = 0; i < this.adapters.length; i++)
      for (let j = i + 1; j < this.adapters.length; j++) {
        const a = this.adapters[i]!, b = this.adapters[j]!;
        const fa = feedSet(a);
        const common = [...feedSet(b)].filter((f) => fa.has(f));
        if (common.length && (!a.appliesTo.agencies?.length || !b.appliesTo.agencies?.length))
          for (const k of HOOK_KINDS)
            if (hasHook(a, k) && hasHook(b, k))
              throw new OperatorConflictError(`${a.id} and ${b.id} both have a ${k} hook for feed ${common[0]} (narrow one of them with appliesTo.agencies)`);
        if (a.exclusive && b.exclusive) {
          const shared = a.exclusive.feeds.filter((f) => b.exclusive!.feeds.includes(f));
          if (shared.length) throw new OperatorConflictError(`${a.id} and ${b.id} both claim feed ${shared[0]} as exclusive`);
        }
      }
  }

  /** Count a change by an adapter (shown in the log and the build report). */
  record(adapter: string, feed: string, field: string, n = 1): void {
    const k = `${adapter}\u0001${feed}\u0001${field}`;
    this.counts.set(k, (this.counts.get(k) ?? 0) + n);
  }

  /** Changes so far: adapter → "field@feed" → rows, in id order. */
  summary(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const k of [...this.counts.keys()].sort()) {
      const [a, f, field] = k.split("\u0001") as [string, string, string];
      (out[a] ??= {})[`${field}@${f}`] = this.counts.get(k)!;
    }
    return out;
  }

  /** Rows of the summary for the operator_log table: [adapter, feed, field, n]. */
  summaryRows(): [string, string, string, number][] {
    return [...this.counts.keys()].sort().map((k) => [...(k.split("\u0001") as [string, string, string]), this.counts.get(k)!]);
  }

  /** Fingerprint of everything that changes what the loader stores (part of the --reuse-db key). */
  loadFingerprint(): number {
    const parts = this.adapters.filter(affectsLoad).map((a) => [a.id, this.sources.get(a.id) ?? describe(a)]);
    return hash(JSON.stringify(parts));
  }

  /** The adapters for one feed (load stage). */
  forFeed(feed: FeedRef): FeedOperators {
    return new FeedOperators(this, feed, this.adapters.filter((a) => inFeedScope(a, feed)));
  }

  /**
   * Build-time extras of a route (brand, high speed) from the adapters in scope. Two adapters giving the same
   * field for the same route fail the build. Cached per (feed, agency, names, category, route type).
   */
  routeExtras(r: RouteFacts): RouteExtras {
    const key = [r.feed.key, r.agency, r.name, r.short, r.long, r.cat, r.routeType ?? ""].join("\u0001");
    const hit = this.routeCache.get(key);
    if (hit) return hit;
    const out: RouteExtras = {};
    const by: Partial<Record<keyof RouteExtras, string>> = {};
    for (const a of this.adapters) {
      if (!a.route || !inFeedScope(a, r.feed) || !agencyMatch(a, r.agency)) continue;
      const x = a.route(r);
      if (!x) continue;
      for (const f of Object.keys(x) as (keyof RouteExtras)[]) {
        if (x[f] === undefined) continue;
        if (by[f]) throw new OperatorConflictError(`${by[f]} and ${a.id} both set route.${f} for "${r.name}" (${r.agency}) of feed ${r.feed.key}`);
        by[f] = a.id;
        (out as Record<string, unknown>)[f] = x[f];
        this.record(a.id, r.feed.key, `route.${f}`);
      }
    }
    this.routeCache.set(key, out);
    return out;
  }
}

/** The adapters whose feed scope covers one feed. */
export class FeedOperators {
  private readonly hooks = new Map<string, RouteHooks | undefined>();
  constructor(
    readonly registry: OperatorRegistry,
    readonly feed: FeedRef,
    /** in id order */
    readonly adapters: OperatorAdapter[],
  ) {}

  /** Adapters with an onLoad hook. */
  get loaders(): OperatorAdapter[] {
    return this.adapters.filter((a) => a.onLoad);
  }

  /** Whether an adapter's scope covers a route of this feed with this agency. */
  covers(a: OperatorAdapter, agency: string): boolean {
    return agencyMatch(a, agency);
  }

  /** Classification hooks for the routes of one agency (undefined when no adapter applies). */
  classifyHooks(agency: string): RouteHooks | undefined {
    if (this.hooks.has(agency)) return this.hooks.get(agency);
    const list = this.adapters.filter((a) => a.classify && agencyMatch(a, agency));
    const feed = this.feed;
    const reg = this.registry;
    const one = <T>(field: "classify.before" | "classify.after", r: RouteInfo, call: (a: OperatorAdapter) => T | undefined): { v: T | undefined; by?: string } => {
      let v: T | undefined, by: string | undefined;
      for (const a of list) {
        const x = call(a);
        if (x === undefined) continue;
        if (by) throw new OperatorConflictError(`${by} and ${a.id} both set ${field} for route "${r.shortName || r.longName}" (${r.agency}, trip category "${r.tripPrefix}") of feed ${feed.key}`);
        [v, by] = [x, a.id];
      }
      if (by) reg.record(by, feed.key, field);
      return { v, by };
    };
    const h: RouteHooks | undefined = list.length
      ? {
          before: list.some((a) => a.classify!.before)
            ? (r: RouteInfo, mode: ModeClass): RouteOverride | undefined => one("classify.before", r, (a) => a.classify!.before?.(r, mode, feed)).v
            : undefined,
          after: list.some((a) => a.classify!.after)
            ? (r: RouteInfo, cl: Classification): Classification | null | undefined => one("classify.after", r, (a) => a.classify!.after?.(r, cl, feed)).v
            : undefined,
        }
      : undefined;
    this.hooks.set(agency, h);
    return h;
  }
}

function describe(a: OperatorAdapter): string {
  return JSON.stringify({
    appliesTo: { ...a.appliesTo, agencies: a.appliesTo.agencies?.map(String) },
    feedOptions: a.feedOptions,
    extraFeeds: a.extraFeeds,
    exclusive: a.exclusive,
    before: a.classify?.before?.toString(),
    after: a.classify?.after?.toString(),
    onLoad: a.onLoad?.toString(),
  });
}

/**
 * Apply the adapters' declarative parts to a feeds config (a new object; the input is not changed): extra feeds
 * inserted after their anchor feed, feed options merged (an option set by feeds.json and an adapter, or by two
 * adapters, is a conflict), exclusive operators appended to dedicatedOperators. Attaches the registry.
 */
export function applyOperators(cfg: FeedsConfig, adapters: OperatorAdapter[], sources?: Map<string, string>): FeedsConfig {
  const sorted = [...adapters].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const feeds: FeedDef[] = cfg.feeds.map((f) => ({ ...f, ...(f.options ? { options: { ...f.options } } : {}) }));
  const addedBy = new Map<string, string>();
  for (const a of sorted)
    for (const x of a.extraFeeds ?? []) {
      if (feeds.some((f) => f.id === x.def.id))
        throw new OperatorConflictError(`${a.id}: extra feed "${x.def.id}" already exists${addedBy.has(x.def.id) ? ` (added by ${addedBy.get(x.def.id)})` : " in feeds.json"}`);
      const at = feeds.findIndex((f) => f.id === x.after);
      if (at < 0) throw new OperatorConflictError(`${a.id}: extra feed "${x.def.id}" goes after unknown feed "${x.after}"`);
      feeds.splice(at + 1, 0, structuredClone(x.def));
      addedBy.set(x.def.id, a.id);
    }
  const optionBy = new Map<string, string>();
  for (const a of sorted) {
    if (!a.feedOptions) continue;
    for (const id of a.appliesTo.feeds ?? []) {
      const f = feeds.find((d) => d.id === id);
      if (!f) continue; // reported by the registry
      const opts: FeedOptions = (f.options ??= {});
      for (const [k, v] of Object.entries(a.feedOptions) as [keyof FeedOptions, unknown][]) {
        const ok = `${id}.${k}`;
        if (optionBy.has(ok)) throw new OperatorConflictError(`${optionBy.get(ok)} and ${a.id} both set option ${k} of feed ${id}`);
        if (opts[k] !== undefined) throw new OperatorConflictError(`${a.id} sets option ${k} of feed ${id}, which ${addedBy.has(id) ? `extra feed of ${addedBy.get(id)}` : "feeds.json"} already sets`);
        (opts as Record<string, unknown>)[k] = structuredClone(v);
        optionBy.set(ok, a.id);
      }
    }
  }
  const dedicated: DedicatedOperator[] = [...(cfg.dedicatedOperators ?? [])];
  for (const a of sorted) if (a.exclusive) dedicated.push({ pattern: a.exclusive.pattern, feeds: [...a.exclusive.feeds] });
  const registry = new OperatorRegistry(sorted, feeds, sources);
  return { ...cfg, feeds, dedicatedOperators: dedicated, operators: registry };
}
