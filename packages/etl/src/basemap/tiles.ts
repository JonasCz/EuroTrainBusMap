/**
 * Basemap vector tiles: OSM land polygons (osmdata.openstreetmap.de, ODbL) + Natural Earth 10m lakes,
 * cut into gzipped MVTs per zoom (layers `land`, `lake`), shipped as ONE tar asset in R2
 * (`basemap/tiles-v2.tar`) that every build unpacks to `<out>/basemap-v2/` (see `installBasemapTiles`).
 *
 * File count is kept low by omitting tiles that carry no information: tiles without land are simply
 * missing (= sea), and tiles completely covered by land and without lakes are missing too, but listed
 * in `index.json` (`land`: the topmost such tiles; their descendants are land as well), so the client
 * answers them with a synthetic all-land tile (web/src/map/basemap.ts).
 *
 * CLI: node --import tsx src/basemap/tiles.ts --out <dir> [--cache <dir>] [--maxzoom 9]
 */
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";
import { boxesOverlap, clipRingFlat, quantize, ringBox, simplifyRing, type Poly, type Ring } from "./geom.ts";
import { readPolygons, type Box } from "./shp.ts";
import { tarEntries, untar } from "./tar.ts";
import { COVERAGE_ID, MAP_BBOX, type BasemapIndex } from "@etbm/shared";

export const BASEMAP_TILES_KEY = "basemap/tiles-v2.tar";
/** Directory (below the data root, next to manifest.json) the tiles are unpacked to. */
export const BASEMAP_DIR = "basemap-v2";
export const BASEMAP_VERSION = 2;
/** Area the tiles are cut for: the box around the map's coverage (packages/shared/src/coverage.ts). */
export const BASEMAP_BBOX: Box = [...MAP_BBOX];
/** Area of tiles built before the index recorded it (Europe only). */
export const LEGACY_BASEMAP_BBOX: Box = [-25, 34, 45, 72];
export const BASEMAP_MINZOOM = 2;
export const BASEMAP_MAXZOOM = 9;

export const LAND_ZIP = "https://osmdata.openstreetmap.de/download/land-polygons-complete-4326.zip";
const NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson";
const LAKE_FILES = ["ne_10m_lakes", "ne_10m_lakes_europe"];

type Log = (m: string) => void;

export type { BasemapIndex };

async function download(url: string, file: string, log: Log): Promise<void> {
  if (existsSync(file)) return;
  log(`basemap: downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status} ${url}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file + ".part"));
  const { rename } = await import("node:fs/promises");
  await rename(file + ".part", file);
}

async function landShapefile(cacheDir: string, log: Log): Promise<string> {
  const shp = join(cacheDir, "land-polygons-complete-4326", "land_polygons.shp");
  if (existsSync(shp)) return shp;
  const zip = join(cacheDir, "land-polygons-complete-4326.zip");
  await download(LAND_ZIP, zip, log);
  log("basemap: unzipping land_polygons.shp");
  execFileSync("unzip", ["-o", "-q", zip, "land-polygons-complete-4326/land_polygons.shp", "-d", cacheDir]);
  return shp;
}

export interface Item {
  poly: Poly;
  box: Box;
}

function prep(poly: Poly, bbox: Box, f: number): Item | null {
  const out: Ring[] = [];
  for (let i = 0; i < poly.length; i++) {
    const c = clipRingFlat(poly[i]!, bbox);
    const q = c && quantize(c, f);
    if (q) out.push(q);
    else if (i === 0) return null;
  }
  return { poly: out, box: ringBox(out[0]!) };
}

async function loadLand(cacheDir: string, bbox: Box, log: Log): Promise<Item[]> {
  const shp = await landShapefile(cacheDir, log);
  const items: Item[] = [];
  let pts = 0;
  for (const rec of readPolygons(shp, bbox)) {
    for (const p of rec.polygons) {
      const it = prep(p, bbox, 1e5);
      if (!it) continue;
      items.push(it);
      for (const r of it.poly) pts += r.length / 2;
    }
  }
  log(`basemap: ${items.length} land polygons, ${(pts / 1e6).toFixed(1)} M points in the bbox`);
  return items;
}

async function loadLakes(cacheDir: string, bbox: Box, log: Log): Promise<Item[]> {
  const items: Item[] = [];
  for (const name of LAKE_FILES) {
    const file = join(cacheDir, `${name}.geojson`);
    await download(`${NE}/${name}.geojson`, file, log);
    const fc = JSON.parse(await readFile(file, "utf8")) as { features: { geometry: { type: string; coordinates: number[][][] | number[][][][] } | null }[] };
    for (const f of fc.features) {
      const g = f.geometry;
      if (!g) continue;
      const polys = g.type === "Polygon" ? [g.coordinates as number[][][]] : g.type === "MultiPolygon" ? (g.coordinates as number[][][][]) : [];
      for (const rings of polys) {
        const it = prep(rings.map((r) => Float64Array.from(r.flat())), bbox, 1e5);
        if (it) items.push(it);
      }
    }
  }
  log(`basemap: ${items.length} lakes`);
  return items;
}

/** Degrees per screen pixel (512 px tiles) at zoom z. */
const pxDeg = (z: number) => 360 / (512 * 2 ** z);

/** Simplify / prune for zoom z; returns GeoJSON MultiPolygon features (one per polygon). */
function toFeatures(items: Item[], z: number, last: boolean, tolPx: number, prunePx: number): GeoJSON.Feature[] {
  const px = pxDeg(z);
  const feats: GeoJSON.Feature[] = [];
  for (const { poly, box } of items) {
    const ky = 1 / Math.cos((((box[1] + box[3]) / 2) * Math.PI) / 180);
    if (Math.max(box[2] - box[0], (box[3] - box[1]) * ky) < px * prunePx) continue;
    const rings: number[][][] = [];
    for (let i = 0; i < poly.length; i++) {
      const r0 = poly[i]!;
      const b = i === 0 ? box : ringBox(r0);
      if (Math.max(b[2] - b[0], (b[3] - b[1]) * ky) < px * prunePx) {
        if (i === 0) break;
        continue;
      }
      const r = last && tolPx === 0 ? r0 : simplifyRing(r0, px * tolPx, ky);
      if (!r || r.length < 8) {
        if (i === 0) break;
        continue;
      }
      const ring: number[][] = [];
      for (let k = 0; k < r.length; k += 2) ring.push([r[k]!, r[k + 1]!]);
      rings.push(ring);
    }
    if (rings.length) feats.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: rings } });
  }
  return feats;
}

export interface TileOut {
  x: number;
  y: number;
  pbf: Uint8Array | null; // null = entirely land
}

const lon2x = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat: number, z: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z);
};
const tileBox = (z: number, x: number, y: number): Box => {
  const n = 2 ** z;
  const lat = (yy: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)];
};

/** Cut one zoom level from the given polygons; `keep` filters the tiles that belong to the caller (blocks). */
export function cutZoom(land: Item[], lakes: Item[], z: number, maxZoom: number, keep: (x: number, y: number) => boolean): TileOut[] {
  const last = z === maxZoom;
  const extent = last ? 8192 : 4096;
  // the last level is overzoomed up to z15 (1 unit ≈ 1 px at z13): keep every vertex that survives rounding to a unit
  const opts = { maxZoom: z, indexMaxZoom: z, indexMaxPoints: 0, extent, buffer: last ? 512 : 256, tolerance: last ? 0 : 1 };
  const tolPx = last ? 0.02 : 0.35;
  const lf = toFeatures(land, z, last, tolPx, last ? 0.2 : 0.8);
  const kf = toFeatures(lakes, z, last, tolPx, last ? 0.5 : 1.5);
  const vtL = geojsonvt({ type: "FeatureCollection", features: lf }, opts);
  const vtK = geojsonvt({ type: "FeatureCollection", features: kf }, opts);
  const keys = new Map<string, [number, number]>();
  for (const v of [vtL, vtK])
    for (const t of (v as unknown as { tileCoords: { z: number; x: number; y: number }[] }).tileCoords) if (t.z === z && keep(t.x, t.y)) keys.set(`${t.x}/${t.y}`, [t.x, t.y]);
  const out: TileOut[] = [];
  for (const [x, y] of keys.values()) {
    const tl = vtL.getTile(z, x, y);
    const tk = vtK.getTile(z, x, y);
    const hasL = !!tl && tl.features.length > 0;
    const hasK = !!tk && tk.features.length > 0;
    if (!hasL && !hasK) continue;
    if (hasL && !hasK && isAllLand(tl!, extent)) {
      out.push({ x, y, pbf: null });
      continue;
    }
    const layers: Record<string, unknown> = {};
    if (hasL) layers.land = tl;
    if (hasK) layers.lake = tk;
    out.push({ x, y, pbf: gzipSync(vtpbf.fromGeojsonVt(layers, { version: 2, extent }), { level: 9 }) });
  }
  return out;
}

/** True if the (clipped) land of a tile is one rectangle covering the whole tile. */
function isAllLand(t: { features: { type: number; geometry: unknown }[] }, extent: number): boolean {
  if (t.features.length !== 1) return false;
  const f = t.features[0]!;
  const rings = f.geometry as number[][][];
  if (f.type !== 3 || rings.length !== 1) return false;
  const r = rings[0]!;
  if (r.length > 5) return false;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of r) {
    x0 = Math.min(x0, x!);
    x1 = Math.max(x1, x!);
    y0 = Math.min(y0, y!);
    y1 = Math.max(y1, y!);
  }
  return x0 <= 0 && y0 <= 0 && x1 >= extent && y1 >= extent;
}

export interface TilesOptions {
  cacheDir: string;
  bbox?: Box;
  minZoom?: number;
  maxZoom?: number;
  log?: Log;
  /** Also write the unpacked tiles to this directory. */
  outDir?: string;
}

/** Build all tiles; returns the tar bytes (index.json + tiles/…) and the index. */
export async function buildBasemapTiles(o: TilesOptions): Promise<{ tar: Buffer; index: BasemapIndex; stats: Record<string, { files: number; bytes: number; pure: number }> }> {
  const log = o.log ?? console.log;
  const bbox = o.bbox ?? BASEMAP_BBOX;
  const minZoom = o.minZoom ?? BASEMAP_MINZOOM, maxZoom = o.maxZoom ?? BASEMAP_MAXZOOM;
  await mkdir(o.cacheDir, { recursive: true });
  const land = await loadLand(o.cacheDir, bbox, log);
  const lakes = await loadLakes(o.cacheDir, bbox, log);

  const BZ = 5; // levels above this are cut block by block (a z5 tile at a time) to bound memory
  const byZoom = new Map<number, TileOut[]>();
  const add = (z: number, ts: TileOut[]) => byZoom.set(z, [...(byZoom.get(z) ?? []), ...ts]);
  for (let z = minZoom; z <= Math.min(BZ, maxZoom); z++) {
    const t0 = Date.now();
    add(z, cutZoom(land, lakes, z, maxZoom, () => true));
    log(`basemap: z${z}: ${byZoom.get(z)!.length} tiles (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  if (maxZoom > BZ) {
    const bx0 = lon2x(bbox[0], BZ), bx1 = lon2x(bbox[2], BZ), by0 = lat2y(bbox[3], BZ), by1 = lat2y(bbox[1], BZ);
    let nb = 0;
    const t0 = Date.now();
    for (let bx = bx0; bx <= bx1; bx++)
      for (let by = by0; by <= by1; by++) {
        const b = tileBox(BZ, bx, by);
        const m = Math.max(b[2] - b[0], b[3] - b[1]) * 0.12;
        const wide: Box = [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
        const sel = (items: Item[]) =>
          items.flatMap((it) => {
            if (!boxesOverlap(it.box, wide)) return [];
            const c = prep(it.poly, wide, 1e5);
            return c ? [c] : [];
          });
        const bl = sel(land), bk = sel(lakes);
        if (!bl.length && !bk.length) continue;
        nb++;
        for (let z = BZ + 1; z <= maxZoom; z++) {
          const s = z - BZ;
          add(z, cutZoom(bl, bk, z, maxZoom, (x, y) => x >> s === bx && y >> s === by));
        }
      }
    log(`basemap: ${nb} blocks cut in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }

  const index: BasemapIndex = {
    version: BASEMAP_VERSION, minzoom: minZoom, maxzoom: maxZoom, tiles: {}, land: {},
    bounds: [bbox[0], bbox[1], bbox[2], bbox[3]], ...(o.bbox ? {} : { coverage: COVERAGE_ID }),
  };
  const entries: { name: string; data: Uint8Array }[] = [];
  const stats: Record<string, { files: number; bytes: number; pure: number }> = {};
  const pure = new Map<number, Set<string>>();
  for (let z = minZoom; z <= maxZoom; z++) {
    const ts = (byZoom.get(z) ?? []).sort((a, b) => a.y - b.y || a.x - b.x);
    const list: number[] = [];
    const ps = new Set<string>();
    let bytes = 0, files = 0;
    for (const t of ts) {
      if (!t.pbf) {
        ps.add(`${t.x}/${t.y}`);
        continue;
      }
      list.push(t.x, t.y);
      entries.push({ name: `tiles/${z}/${t.x}/${t.y}.pbf.gz`, data: t.pbf });
      bytes += t.pbf.length;
      files++;
    }
    pure.set(z, ps);
    index.tiles[z] = list;
    stats[z] = { files, bytes, pure: ps.size };
  }
  for (let z = minZoom; z <= maxZoom; z++) {
    const list: number[] = [];
    for (const k of pure.get(z)!) {
      const [x, y] = k.split("/").map(Number) as [number, number];
      if (z > minZoom && pure.get(z - 1)!.has(`${x >> 1}/${y >> 1}`)) continue;
      list.push(x, y);
    }
    index.land[z] = list;
  }
  entries.unshift({ name: "index.json", data: Buffer.from(JSON.stringify(index)) });
  if (o.outDir) {
    await rm(o.outDir, { recursive: true, force: true });
    untar(tarEntries(entries), o.outDir);
  }
  for (const [z, s] of Object.entries(stats)) log(`basemap: z${z}: ${s.files} files, ${(s.bytes / 1e6).toFixed(2)} MB, ${s.pure} all-land tiles`);
  return { tar: tarEntries(entries), index, stats };
}

/**
 * Unpack the tiles asset into `<outRoot>/basemap-v2/`; returns the file count and the area and coverage the tiles
 * were cut for (tiles from before the index recorded them: the Europe-only box, no coverage).
 */
export async function installBasemapTiles(tarFile: string, outRoot: string): Promise<{ files: number; bounds: Box; coverage: string | null }> {
  const dir = join(outRoot, BASEMAP_DIR);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const files = untar(await readFile(tarFile), dir);
  const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8")) as BasemapIndex;
  return { files, bounds: index.bounds ?? LEGACY_BASEMAP_BBOX, coverage: index.coverage ?? null };
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const get = (n: string) => (a.indexOf(n) >= 0 ? a[a.indexOf(n) + 1] : undefined);
  const out = resolve(get("--out") ?? "work/assets");
  const cache = resolve(get("--cache") ?? "work/cache/basemap-src");
  const maxZoom = Number(get("--maxzoom") ?? BASEMAP_MAXZOOM);
  const r = await buildBasemapTiles({ cacheDir: cache, maxZoom, outDir: get("--unpacked") ? resolve(get("--unpacked")!) : undefined });
  await mkdir(join(out, "basemap"), { recursive: true });
  await writeFile(join(out, BASEMAP_TILES_KEY), r.tar);
  console.log(`wrote ${BASEMAP_TILES_KEY} ${(r.tar.length / 1e6).toFixed(1)} MB`);
}
