/**
 * `etbmgz://` – two kinds of URLs:
 *  - `etbmgz://pack/<layer>/{z}/{x}/{y}`: a vector tile of the tile packs (packs.ts; every tile layer: basemap,
 *    network, local transport). Fill tiles are answered with the all-land tile, missing ones with an empty tile.
 *  - `etbmgz://<url>`: a gzip-compressed static file (glyphs), inflated in the browser (DecompressionStream).
 * Static hosts such as Cloudflare do not compress protobuf, so tiles and glyphs are stored pre-gzipped.
 */
import maplibregl from "maplibre-gl";
import { inflate } from "../data/gz.ts";
import { landBytes, PACK_URL_RE, type PackStore } from "./packs.ts";

export { inflate };

let registered = false;
let store: PackStore | null = null;
/** layer → [maxzoom, layer serving the zooms above it] (the mode-filter network beyond its own zooms) */
let redirects: Record<string, [number, string]> = {};
const prefetched = new Map<string, Promise<ArrayBuffer>>();

async function fetchGz(url: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`${res.status} ${url}`);
  }
  return inflate(await res.arrayBuffer());
}

/**
 * Start downloading resources MapLibre will ask for later (e.g. glyph ranges,
 * which it only requests after parsing the first tiles).
 */
export function prefetchGz(urls: string[]): void {
  for (const u of urls) if (!prefetched.has(key(u))) prefetched.set(key(u), fetchGz(u).then((b) => b ?? new ArrayBuffer(0)));
}

/** URLs may come encoded or not ("Noto Sans" vs "Noto%20Sans"). */
const key = (u: string) => {
  try {
    return decodeURI(u);
  } catch {
    return u;
  }
};

async function packTile(layer: string, z: number, x: number, y: number): Promise<ArrayBuffer> {
  const r = redirects[layer];
  if (r && z > r[0]) layer = r[1];
  if (!store) return new ArrayBuffer(0);
  const t = await store.tile(layer, z, x, y);
  if (t.kind === "fill") return landBytes();
  if (t.kind === "empty") return new ArrayBuffer(0);
  return inflate(t.gz.slice().buffer); // a copy: MapLibre may transfer (detach) the buffer
}

export function registerGzProtocol(packs?: PackStore, packRedirects: Record<string, [number, string]> = {}): void {
  if (packs) store = packs;
  redirects = packRedirects;
  if (registered) return;
  registered = true;
  maplibregl.addProtocol("etbmgz", async (params, abort) => {
    const url = params.url.slice("etbmgz://".length);
    const m = PACK_URL_RE.exec(url);
    if (m) return { data: await packTile(m[1]!, +m[2]!, +m[3]!, +m[4]!) };
    const pre = prefetched.get(key(url));
    if (pre) {
      prefetched.delete(key(url)); // one use: MapLibre may transfer (detach) the buffer
      return { data: await pre };
    }
    const data = await fetchGz(url, abort.signal);
    if (!data) throw new Error(`404 ${url}`);
    return { data };
  });
}
