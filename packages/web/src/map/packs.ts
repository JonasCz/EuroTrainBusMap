/**
 * Tiles from the tile packs (@etbm/shared tilepack.ts). MapLibre sources stay plain vector sources with the URL
 * template `etbmgz://pack/<layer>/{z}/{x}/{y}` (protocol.ts); this store finds the pack that holds a tile in the
 * manifest's pack index, downloads the pack once (in-flight requests shared, an LRU of parsed packs) and cuts the
 * tile out of it. Fill tiles of the basemap (entirely land) are answered with a one-square land tile, tiles without
 * an entry (sea, no lines) with an empty tile – no request either way.
 */
import { PackLookup, TilePack, type TilePacks } from "@etbm/shared";

/** MVT, extent 4096, layer "land": one square from -256 to 4352 (covers the tile and its buffer). */
const LAND_TILE_B64 = "GiN4AgoEbGFuZCiAIBIWEgAYAyIQCf8D/wMagEgAAIBI/0cADw==";
let landTile: Uint8Array | null = null;
export const landBytes = (): ArrayBuffer => {
  landTile ??= Uint8Array.from(atob(LAND_TILE_B64), (c) => c.charCodeAt(0));
  return landTile.slice().buffer;
};

/** Parsed packs kept in memory (bytes); the least recently used ones are dropped beyond it. */
const CACHE_BYTES = 64 * 1024 * 1024;

export type TileResult = { kind: "data"; gz: Uint8Array } | { kind: "fill" } | { kind: "empty" };

export class PackStore {
  private lookup: PackLookup;
  /** url → parsed pack, in least-recently-used order */
  private cache = new Map<string, TilePack>();
  private cached = 0;
  private inflight = new Map<string, Promise<TilePack>>();

  /**
   * `root`: URL of the build directory (ending in "/"); `fetcher` for tests.
   */
  constructor(
    readonly packs: TilePacks,
    private root: string,
    private fetcher: (url: string) => Promise<ArrayBuffer> = defaultFetch,
    private maxBytes = CACHE_BYTES,
  ) {
    this.lookup = new PackLookup(packs);
  }

  async tile(layer: string, z: number, x: number, y: number): Promise<TileResult> {
    const ref = this.lookup.find(layer, z, x, y);
    if (!ref) return { kind: "empty" };
    if (!ref.file) return ref.set.fill === layer ? { kind: "fill" } : { kind: "empty" };
    const pack = await this.pack(`${this.root}${this.packs.dir}${ref.file}.pack`);
    const t = pack.get(layer, z, x, y);
    if (t === "fill") return { kind: "fill" };
    return t ? { kind: "data", gz: t } : { kind: "empty" };
  }

  /** Number of packs in memory (tests, debugging). */
  get size(): number {
    return this.cache.size;
  }

  private pack(url: string): Promise<TilePack> {
    const hit = this.cache.get(url);
    if (hit) {
      this.cache.delete(url);
      this.cache.set(url, hit);
      return Promise.resolve(hit);
    }
    let p = this.inflight.get(url);
    if (!p) {
      p = this.fetcher(url)
        .then((buf) => {
          const pack = new TilePack(buf);
          this.cache.set(url, pack);
          this.cached += pack.bytes.byteLength;
          for (const [u, old] of this.cache) {
            if (this.cached <= this.maxBytes || u === url) break;
            this.cache.delete(u);
            this.cached -= old.bytes.byteLength;
          }
          return pack;
        })
        .finally(() => this.inflight.delete(url));
      this.inflight.set(url, p);
    }
    return p;
  }
}

async function defaultFetch(url: string): Promise<ArrayBuffer> {
  // the request is shared by every tile of the pack: not tied to one tile's AbortSignal
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.arrayBuffer();
}

/** `pack/<layer>/<z>/<x>/<y>` (the part after `etbmgz://`). */
export const PACK_URL_RE = /^pack\/([a-z-]+)\/(\d+)\/(\d+)\/(\d+)$/;

export const packTileUrl = (layer: string) => `etbmgz://pack/${layer}/{z}/{x}/{y}`;
