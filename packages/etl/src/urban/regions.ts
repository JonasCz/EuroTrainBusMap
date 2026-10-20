/**
 * Region-by-region build of the local-transport layer, so that memory stays bounded however many lines there are.
 *
 * Regions are the web-mercator tiles of zoom REGION_ZOOM (z6, about 400 km across in central Europe); the tiles of
 * the layer (z10 rail, z11 bus) nest inside them, so every output tile belongs to exactly one region.
 *
 * 1. Partition (per feed, while the feeds are extracted): every pattern goes to each region whose square, grown by
 *    REGION_HALO_KM, its bounding box touches, together with the stops it calls at. A line crossing a seam is
 *    therefore complete in both regions, and so is everything within the halo of a region.
 * 2. Build (per region): buildUrban on the region's patterns (de-duplication, stations, zoom levels), then keep only what
 *    the region owns: a line alignment belongs to the region holding the centre of its bounding box, a station to
 *    the region holding its position. Each alignment and station thus comes out of exactly one region; their
 *    decisions are the same in every region that sees them, because everything they depend on (same-name lines
 *    nearby, stops within a few hundred metres, more important lines in the same screen cells) lies within the halo.
 * 3. Tiles (per region): the owned features of all regions are routed to every region whose tiles (with the tile
 *    buffer) their bounding box touches; each region cuts only its own tiles from them, so a tile at a seam holds
 *    the features of both sides and no feature twice.
 *
 * The spill between the steps goes through a Spill (files under work/urban/regions, or memory in the tests).
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { DiscIndex } from "./classify.ts";
import { buildUrban, type DrawnLine, type UrbanStation } from "./model.ts";
import { type LonLat, type UrbanFeed, type UrbanLine, type UrbanStop } from "./types.ts";

export const REGION_ZOOM = 6;
/** Context around a region: more than a local line's span (classify.ts LOCAL_BUS_MAX_KM) plus a neighbour's. */
export const REGION_HALO_KM = 60;

/** Web-mercator world coordinates in [0, 1). */
export const worldX = (lon: number) => (lon + 180) / 360;
export function worldY(lat: number): number {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

export interface Box {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export function boxOf(pts: Iterable<LonLat>): Box {
  const b = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
  for (const [x, y] of pts) {
    if (x < b.minLon) b.minLon = x;
    if (x > b.maxLon) b.maxLon = x;
    if (y < b.minLat) b.minLat = y;
    if (y > b.maxLat) b.maxLat = y;
  }
  return b;
}

export const regionKey = (x: number, y: number) => `${x}-${y}`;
export function parseRegion(k: string): { x: number; y: number } {
  const [x, y] = k.split("-").map(Number);
  return { x: x!, y: y! };
}

/** Region holding a point. */
export function regionOf(lon: number, lat: number, rz = REGION_ZOOM): string {
  const n = 2 ** rz;
  return regionKey(Math.min(n - 1, Math.floor(worldX(lon) * n)), Math.min(n - 1, Math.floor(worldY(lat) * n)));
}

/** Regions whose square grown by `haloKm` touches a box (equivalently: the box grown by the halo touches them). */
export function regionsOfBox(b: Box, haloKm: number, rz = REGION_ZOOM): string[] {
  const dLat = haloKm / 111.2;
  const cos = Math.max(0.1, Math.cos((Math.min(85, Math.max(Math.abs(b.minLat), Math.abs(b.maxLat)) + dLat) * Math.PI) / 180));
  const dLon = haloKm / (111.2 * cos);
  return worldRange(worldX(b.minLon - dLon), worldY(b.maxLat + dLat), worldX(b.maxLon + dLon), worldY(b.minLat - dLat), rz);
}

/** Regions whose tiles at zoom `tz`, grown by `bufferTiles` tile widths, touch a box. */
export function regionsOfTiles(b: Box, tz: number, bufferTiles: number, rz = REGION_ZOOM): string[] {
  const m = bufferTiles / 2 ** tz;
  return worldRange(worldX(b.minLon) - m, worldY(b.maxLat) - m, worldX(b.maxLon) + m, worldY(b.minLat) + m, rz);
}

function worldRange(x0: number, y0: number, x1: number, y1: number, rz: number): string[] {
  const n = 2 ** rz;
  const c = (v: number) => Math.max(0, Math.min(n - 1, Math.floor(v * n)));
  const out: string[] = [];
  for (let x = c(x0); x <= c(x1); x++) for (let y = c(y0); y <= c(y1); y++) out.push(regionKey(x, y));
  return out;
}

/** Whether tile z/x/y lies in a region. */
export function tileInRegion(z: number, x: number, y: number, region: string, rz = REGION_ZOOM): boolean {
  const r = parseRegion(region);
  return x >> (z - rz) === r.x && y >> (z - rz) === r.y;
}

/**
 * Split a feed into the parts each region needs (step 1): per region the patterns whose bounding box (line and
 * stops) touches the region grown by the halo, and only the stops they call at. Lines and patterns keep their order.
 */
export function partitionFeed(feed: UrbanFeed, haloKm = REGION_HALO_KM, rz = REGION_ZOOM): Map<string, UrbanFeed> {
  const parts = new Map<string, { lines: UrbanLine[]; stops: UrbanStop[]; remap: Map<number, number>; cur: UrbanLine | null; src: UrbanLine | null }>();
  for (const line of feed.lines)
    for (const p of line.patterns) {
      const box = boxOf([...p.coords, ...p.stops.map((s) => [feed.stops[s]!.lon, feed.stops[s]!.lat] as LonLat)]);
      for (const rk of regionsOfBox(box, haloKm, rz)) {
        let part = parts.get(rk);
        if (!part) parts.set(rk, (part = { lines: [], stops: [], remap: new Map(), cur: null, src: null }));
        if (part.src !== line) {
          part.cur = { ...line, patterns: [] };
          part.src = line;
          part.lines.push(part.cur);
        }
        const stops = p.stops.map((s) => {
          let i = part!.remap.get(s);
          if (i === undefined) {
            i = part!.stops.length;
            part!.remap.set(s, i);
            part!.stops.push(feed.stops[s]!);
          }
          return i;
        });
        // the bus times (station changes by bus) are not part of the layer
        const { times: _times, ...rest } = p;
        part.cur!.patterns.push({ ...rest, stops });
      }
    }
  const out = new Map<string, UrbanFeed>();
  for (const [rk, part] of parts) out.set(rk, { ...feed, lines: part.lines, stops: part.stops });
  return out;
}

/** Owner region of a drawn alignment: the one holding the centre of its bounding box. */
export function lineOwner(l: { coords: LonLat[] }, rz = REGION_ZOOM): string {
  const b = boxOf(l.coords);
  return regionOf((b.minLon + b.maxLon) / 2, (b.minLat + b.maxLat) / 2, rz);
}

/** Where the steps leave their intermediate results: a directory tree, or memory (tests). */
export interface Spill {
  put(group: string, name: string, data: unknown): Promise<void>;
  /** names in a group, sorted */
  names(group: string): Promise<string[]>;
  /** groups that hold something, sorted */
  groups(prefix: string): Promise<string[]>;
  get<T>(group: string, name: string): Promise<T>;
  clear(): Promise<void>;
}

export class DiskSpill implements Spill {
  constructor(readonly dir: string) {}
  async put(group: string, name: string, data: unknown): Promise<void> {
    await mkdir(join(this.dir, group), { recursive: true });
    await writeFile(join(this.dir, group, `${name}.json.gz`), gzipSync(JSON.stringify(data), { level: 1 }));
  }
  async names(group: string): Promise<string[]> {
    const d = join(this.dir, group);
    if (!existsSync(d)) return [];
    return (await readdir(d)).filter((f) => f.endsWith(".json.gz")).map((f) => f.slice(0, -8)).sort();
  }
  async groups(prefix: string): Promise<string[]> {
    const d = join(this.dir, prefix);
    if (!existsSync(d)) return [];
    return (await readdir(d)).sort().map((g) => `${prefix}/${g}`);
  }
  async get<T>(group: string, name: string): Promise<T> {
    return JSON.parse(gunzipSync(await readFile(join(this.dir, group, `${name}.json.gz`))).toString("utf8")) as T;
  }
  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

export class MemorySpill implements Spill {
  private m = new Map<string, Map<string, string>>();
  async put(group: string, name: string, data: unknown): Promise<void> {
    let g = this.m.get(group);
    if (!g) this.m.set(group, (g = new Map()));
    g.set(name, JSON.stringify(data));
  }
  async names(group: string): Promise<string[]> {
    return [...(this.m.get(group)?.keys() ?? [])].sort();
  }
  async groups(prefix: string): Promise<string[]> {
    return [...this.m.keys()].filter((g) => g.startsWith(prefix + "/")).sort();
  }
  async get<T>(group: string, name: string): Promise<T> {
    return JSON.parse(this.m.get(group)!.get(name)!) as T;
  }
  async clear(): Promise<void> {
    this.m.clear();
  }
}

/** Feed index as a sortable spill name (feeds are read back in their global order). */
const feedName = (fi: number) => String(fi).padStart(5, "0");

/** Step 1 for one feed: write its region parts. */
export async function spillFeed(spill: Spill, fi: number, feed: UrbanFeed, haloKm = REGION_HALO_KM, rz = REGION_ZOOM): Promise<number> {
  const parts = partitionFeed(feed, haloKm, rz);
  for (const [rk, part] of parts) await spill.put(`in/${rk}`, feedName(fi), part);
  return parts.size;
}

export interface RegionOutput {
  lines: DrawnLine[];
  stations: UrbanStation[];
}

/** Step 2 for one region: build it from its parts and keep what it owns. */
export async function buildRegion(
  spill: Spill,
  region: string,
  intercity: { lon: number; lat: number; name?: string }[],
  cities: DiscIndex | undefined,
  rz = REGION_ZOOM,
): Promise<RegionOutput> {
  const feeds: UrbanFeed[] = [];
  for (const n of await spill.names(`in/${region}`)) feeds.push(await spill.get<UrbanFeed>(`in/${region}`, n));
  const built = buildUrban(feeds, intercity, cities);
  // stations are referenced by index from the lines (stops): not needed after this point
  const lines = built.lines.filter((l) => lineOwner(l, rz) === region);
  const stations = built.stations.filter((s) => regionOf(s.lon, s.lat, rz) === region);
  return { lines, stations };
}

/** Points by the regions whose halo they lie in (the intercity stations each region needs for the attach test). */
export function bucketByRegion<T extends { lon: number; lat: number }>(all: T[], haloKm = REGION_HALO_KM, rz = REGION_ZOOM): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const s of all)
    for (const rk of regionsOfBox({ minLon: s.lon, minLat: s.lat, maxLon: s.lon, maxLat: s.lat }, haloKm, rz)) {
      const a = out.get(rk);
      if (a) a.push(s);
      else out.set(rk, [s]);
    }
  return out;
}
