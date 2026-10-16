/**
 * `etbmbase://<root>tiles/{z}/{x}/{y}.pbf.gz` – OSM land / lake vector tiles.
 *
 * The tiles are stored without sea-only tiles (missing = sea) and without tiles that are entirely
 * land (listed in `<root>index.json` instead, topmost tile only), which keeps the number of files
 * far below the host limit. This protocol fetches the index once, answers all-land tiles with a
 * constant one-rectangle tile and unknown tiles with an empty tile (no 404s).
 */
import maplibregl from "maplibre-gl";
import type { BasemapIndex } from "@etbm/shared";
import { inflate } from "./protocol.ts";

/** MVT, extent 4096, layer "land": one square from -256 to 4352 (covers the tile and its buffer). */
const LAND_TILE_B64 = "GiN4AgoEbGFuZCiAIBIWEgAYAyIQCf8D/wMagEgAAIBI/0cADw==";
let landTile: Uint8Array | null = null;
const landBytes = (): ArrayBuffer => {
  landTile ??= Uint8Array.from(atob(LAND_TILE_B64), (c) => c.charCodeAt(0));
  return landTile.slice().buffer;
};

export interface Sets {
  tiles: Set<number>[];
  land: Set<number>[];
  minzoom: number;
}
const key = (z: number, x: number, y: number) => (y * 2 ** z + x) * 32 + z; // < 2^53 for z ≤ 14
export const toSets = (ix: BasemapIndex): Sets => {
  const mk = (rec: Record<string, number[]>) => {
    const out: Set<number>[] = [];
    for (const [z, list] of Object.entries(rec)) {
      const s = new Set<number>();
      for (let i = 0; i < list.length; i += 2) s.add(key(+z, list[i]!, list[i + 1]!));
      out[+z] = s;
    }
    return out;
  };
  return { tiles: mk(ix.tiles), land: mk(ix.land), minzoom: ix.minzoom };
};

/** "file": fetch it; "land": entirely land; "sea": nothing there. */
export function classifyTile(sets: Sets, z: number, x: number, y: number): "file" | "land" | "sea" {
  if (sets.tiles[z]?.has(key(z, x, y))) return "file";
  for (let a = z; a >= sets.minzoom; a--) {
    const s = z - a;
    if (sets.land[a]?.has(key(a, x >> s, y >> s))) return "land";
  }
  return "sea";
}

const indexes = new Map<string, Promise<Sets | null>>();
function loadIndex(root: string): Promise<Sets | null> {
  let p = indexes.get(root);
  if (!p) {
    p = fetch(`${root}index.json`)
      .then((r) => (r.ok ? (r.json() as Promise<BasemapIndex>) : null))
      .then((ix) => (ix ? toSets(ix) : null))
      .catch(() => null);
    indexes.set(root, p);
  }
  return p;
}

/** Start fetching the index before MapLibre asks for the first tile. */
export function prefetchBasemapIndex(root: string): void {
  void loadIndex(root);
}

const TILE_RE = /^(.*\/)tiles\/(\d+)\/(\d+)\/(\d+)\.pbf\.gz$/;
let registered = false;

export function registerBasemapProtocol(): void {
  if (registered) return;
  registered = true;
  maplibregl.addProtocol("etbmbase", async (params, abort) => {
    const url = params.url.slice("etbmbase://".length);
    const m = TILE_RE.exec(url);
    if (!m) throw new Error(`bad basemap url ${url}`);
    const [root, z, x, y] = [m[1]!, +m[2]!, +m[3]!, +m[4]!];
    const sets = await loadIndex(root);
    if (!sets) {
      // no index: try the file itself (old / partial deployments)
      const res = await fetch(url, { signal: abort.signal });
      return { data: res.ok ? await inflate(await res.arrayBuffer()) : new ArrayBuffer(0) };
    }
    const kind = classifyTile(sets, z, x, y);
    if (kind === "file") {
      const res = await fetch(url, { signal: abort.signal });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return { data: await inflate(await res.arrayBuffer()) };
    }
    return { data: kind === "land" ? landBytes() : new ArrayBuffer(0) };
  });
}
