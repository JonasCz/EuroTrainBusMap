/**
 * `etbmgz://<url>` – fetches a gzip-compressed static file and inflates it in
 * the browser (DecompressionStream). Static hosts such as Cloudflare do not
 * compress protobuf, so vector tiles and glyphs are stored pre-gzipped. Tiles
 * missing from the tile index are answered with an empty tile without a
 * request (no 404s for empty sea/land areas).
 */
import maplibregl from "maplibre-gl";
import { inflate } from "../data/gz.ts";

export { inflate };

let registered = false;
let known: Set<string> | null = null;

/**
 * A second tile set for the network under mode filters (`TileIndex.modes`): up to `maxzoom` its own
 * tiles (`keys`), beyond it the URLs are redirected to the plain tile directory, which serves every filter.
 */
export interface ModeTiles {
  /** URL path parts of the two tile directories, e.g. "/tiles-m/" and "/tiles/" */
  dir: string;
  plainDir: string;
  maxzoom: number;
  keys: Set<string>;
}
let modeTiles: ModeTiles | null = null;
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

const TILE_RE = /\/(\d+)\/(\d+)\/(\d+)\.pbf\.gz$/;

export function registerGzProtocol(tiles?: Set<string>, modes?: ModeTiles | null): void {
  if (tiles) known = tiles;
  if (modes !== undefined) modeTiles = modes;
  if (registered) return;
  registered = true;
  maplibregl.addProtocol("etbmgz", async (params, abort) => {
    let url = params.url.slice("etbmgz://".length);
    const m = TILE_RE.exec(url);
    const mt = modeTiles;
    if (m && mt && url.includes(mt.dir)) {
      if (+m[1]! > mt.maxzoom) url = url.replace(mt.dir, mt.plainDir);
      else if (!mt.keys.has(`${m[1]}/${m[2]}/${m[3]}`)) return { data: new ArrayBuffer(0) };
    }
    if (m && known && !(mt && url.includes(mt.dir)) && !known.has(`${m[1]}/${m[2]}/${m[3]}`)) return { data: new ArrayBuffer(0) };
    const pre = prefetched.get(key(url));
    if (pre) {
      prefetched.delete(key(url)); // one use: MapLibre may transfer (detach) the buffer
      return { data: await pre };
    }
    const data = await fetchGz(url, abort.signal);
    if (!data && !m) throw new Error(`404 ${url}`);
    return { data: data ?? new ArrayBuffer(0) };
  });
}
