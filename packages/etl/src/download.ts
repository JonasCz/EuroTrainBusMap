import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { log, warn } from "./util/log.ts";

export interface CacheMeta {
  url: string;
  etag?: string;
  lastModified?: string;
  size: number;
  fetchedAt: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Download `url` to `dest`, re-using the cached copy when the server says it
 * is unchanged (ETag / Last-Modified) or when it is younger than `maxAgeH`.
 * Returns true when the file was (re)downloaded.
 */
export async function downloadCached(
  url: string,
  dest: string,
  ua: string,
  opts: { retries?: number; maxAgeH?: number; timeoutMs?: number } = {},
): Promise<{ fresh: boolean; meta: CacheMeta }> {
  const metaPath = dest + ".meta.json";
  let meta: CacheMeta | null = null;
  if (existsSync(dest) && existsSync(metaPath)) {
    try {
      meta = JSON.parse(await readFile(metaPath, "utf8")) as CacheMeta;
      if (meta.url !== url) meta = null;
      else if ((await stat(dest)).size !== meta.size) meta = null;
    } catch {
      meta = null;
    }
  }
  if (meta && opts.maxAgeH && Date.now() - Date.parse(meta.fetchedAt) < opts.maxAgeH * 3600_000) {
    return { fresh: false, meta };
  }
  const retries = opts.retries ?? 4;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(2000 * 2 ** (attempt - 1));
    try {
      const headers: Record<string, string> = { "user-agent": ua };
      if (meta?.etag) headers["if-none-match"] = meta.etag;
      if (meta?.lastModified) headers["if-modified-since"] = meta.lastModified;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30 * 60_000);
      try {
        const res = await fetch(url, { headers, redirect: "follow", signal: ctrl.signal });
        if (res.status === 304 && meta) {
          meta.fetchedAt = new Date().toISOString();
          await writeFile(metaPath, JSON.stringify(meta));
          return { fresh: false, meta };
        }
        if (!res.ok || !res.body) {
          const err = new Error(`HTTP ${res.status} for ${url}`);
          if (res.status === 404 || res.status === 403 || res.status === 410) {
            (err as Error & { fatal?: boolean }).fatal = true;
          }
          throw err;
        }
        await mkdir(dirname(dest), { recursive: true });
        const tmp = dest + ".part";
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
        const size = (await stat(tmp)).size;
        const expected = Number(res.headers.get("content-length") ?? NaN);
        if (Number.isFinite(expected) && expected !== size && !res.headers.get("content-encoding")) {
          throw new Error(`truncated download ${url}: ${size} of ${expected}`);
        }
        await rename(tmp, dest);
        const m: CacheMeta = {
          url,
          etag: res.headers.get("etag") ?? undefined,
          lastModified: res.headers.get("last-modified") ?? undefined,
          size,
          fetchedAt: new Date().toISOString(),
        };
        await writeFile(metaPath, JSON.stringify(m));
        return { fresh: true, meta: m };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      lastErr = e;
      warn(`download attempt ${attempt + 1} failed: ${(e as Error).message}`);
      if ((e as { fatal?: boolean }).fatal) break;
    }
  }
  await rm(dest + ".part", { force: true });
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Fetch small text resource with cache fallback (used for listings, license.json). */
export async function fetchText(url: string, ua: string, cachePath: string): Promise<string> {
  try {
    await downloadCached(url, cachePath, ua, { retries: 3, maxAgeH: 6, timeoutMs: 120_000 });
  } catch (e) {
    if (!existsSync(cachePath)) throw e;
    warn(`using stale cache for ${url}`);
  }
  return readFile(cachePath, "utf8");
}

/**
 * Fetch a web page (GET, or POST of a urlencoded `form`) with the build's User-Agent, a timeout and retries with
 * backoff (as downloadCached; 403 / 404 / 410 are not retried); `expect`: a pattern the complete answer contains
 * (e.g. /<\/html>/), an answer without it is retried. Not cached: used by the feed generators, which must
 * see the page as it is now. Throws after the last attempt.
 */
export async function fetchPage(
  url: string,
  ua: string,
  opts: { form?: Record<string, string>; retries?: number; timeoutMs?: number; expect?: RegExp } = {},
): Promise<string> {
  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(2000 * 2 ** (attempt - 1));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
    try {
      const init: RequestInit = { headers: { "user-agent": ua, accept: "text/html,*/*" }, redirect: "follow", signal: ctrl.signal };
      if (opts.form) {
        init.method = "POST";
        init.body = new URLSearchParams(opts.form).toString();
        (init.headers as Record<string, string>)["content-type"] = "application/x-www-form-urlencoded";
      }
      const res = await fetch(url, init);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        if (res.status === 404 || res.status === 403 || res.status === 410) (err as Error & { fatal?: boolean }).fatal = true;
        throw err;
      }
      const body = await res.text();
      // a page cut off by the server (HTTP 200, half the HTML) is retried like an error
      if (opts.expect && !opts.expect.test(body)) throw new Error(`incomplete answer from ${url} (${body.length} bytes, no ${opts.expect})`);
      return body;
    } catch (e) {
      lastErr = ctrl.signal.aborted ? new Error(`timeout fetching ${url}`) : e;
      warn(`fetch attempt ${attempt + 1} of ${url} failed: ${(lastErr as Error).message}`);
      if ((e as { fatal?: boolean }).fatal) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Run async tasks with limited concurrency, preserving result order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Try each URL in order until one succeeds. */
export async function downloadWithFallback(
  urls: string[],
  dest: string,
  ua: string,
  maxAgeH?: number,
): Promise<{ url: string; meta: CacheMeta; fresh: boolean }> {
  let lastErr: unknown;
  for (const url of urls) {
    try {
      const r = await downloadCached(url, dest, ua, { maxAgeH });
      if (r.fresh) log(`downloaded ${url} (${(r.meta.size / 1e6).toFixed(1)} MB)`);
      return { url, ...r };
    } catch (e) {
      lastErr = e;
      warn(`source failed ${url}: ${(e as Error).message}`);
    }
  }
  if (existsSync(dest) && existsSync(dest + ".meta.json")) {
    const meta = JSON.parse(await readFile(dest + ".meta.json", "utf8")) as CacheMeta;
    warn(`all sources failed, using stale cached copy of ${meta.url} from ${meta.fetchedAt}`);
    return { url: meta.url, meta, fresh: false };
  }
  throw lastErr instanceof Error ? lastErr : new Error("no sources");
}
