/**
 * `etbmgz://<url>` – fetches a gzip-compressed static file and inflates it in
 * the browser (DecompressionStream). Static hosts such as Cloudflare do not
 * compress protobuf, so vector tiles and glyphs are stored pre-gzipped. Tiles
 * missing from the tile index are answered with an empty tile without a
 * request (no 404s for empty sea/land areas).
 */
import maplibregl from "maplibre-gl";

let registered = false;
let known: Set<string> | null = null;
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

export async function inflate(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (b[0] !== 0x1f || b[1] !== 0x8b) return buf; // already decoded (host sent Content-Encoding)
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

export function registerGzProtocol(tiles?: Set<string>): void {
  if (tiles) known = tiles;
  if (registered) return;
  registered = true;
  maplibregl.addProtocol("etbmgz", async (params, abort) => {
    const url = params.url.slice("etbmgz://".length);
    const m = TILE_RE.exec(url);
    if (m && known && !known.has(`${m[1]}/${m[2]}/${m[3]}`)) return { data: new ArrayBuffer(0) };
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
