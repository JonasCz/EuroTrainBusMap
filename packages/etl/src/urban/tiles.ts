/// <reference path="../vt-pbf.d.ts" />
import { gzipSync } from "node:zlib";
import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";
import type { UrbanInfo } from "@etbm/shared";
import { PACK_LAYER, URBAN_LAYERS, URBAN_VERSION } from "@etbm/shared";
import { writeLayerFile } from "../tilelayers.ts";
import { UMode } from "./types.ts";
import type { DrawnLine, UrbanStation } from "./model.ts";
import { boxOf, regionsOfTiles, REGION_ZOOM, tileInRegion, type Box, type RegionOutput, type Spill } from "./regions.ts";

type Feature = GeoJSON.Feature;

/** Storage zooms and extents of the two sources: metro / tram (and their stops) and buses. */
export const RAIL_TILE = { zoom: 10, extent: 16384 };
export const BUS_TILE = { zoom: 11, extent: 8192 };

export const isRailMode = (m: number) => m !== UMode.Bus;

export function lineFeature(l: DrawnLine): Feature {
  const p: Record<string, string | number> = { m: l.mode, n: l.name, z: l.lz };
  if (l.color) p.c = l.color;
  if (l.agency) p.a = l.agency;
  if (l.desc) p.d = l.desc;
  if (l.tpd) p.t = Math.round(l.tpd);
  if (l.geom !== "shape") p.g = l.geom === "stops" ? 3 : l.geom === "road" ? 2 : 1;
  if (l.expired) p.e = l.expired;
  return { type: "Feature", properties: p, geometry: { type: "LineString", coordinates: l.coords } };
}

export function stationFeature(s: UrbanStation): Feature {
  const lines = s.lines.slice(0, 12);
  const top = s.modes & (1 << UMode.Metro) ? UMode.Metro : s.modes & (1 << UMode.Tram) ? UMode.Tram : s.modes & (1 << UMode.Cable) ? UMode.Cable : UMode.Bus;
  const p: Record<string, string | number> = { n: s.name, m: s.modes, t: top, z: Math.round(s.z * 10) / 10, i: Math.round(Math.log2(1 + s.imp) * 4) / 4, k: s.lines.length };
  if (lines.length) p.l = lines.join(" ") + (s.lines.length > lines.length ? " …" : "");
  if (s.ix) p.x = 1;
  return { type: "Feature", properties: p, geometry: { type: "Point", coordinates: [Math.round(s.lon * 1e5) / 1e5, Math.round(s.lat * 1e5) / 1e5] } };
}

/** Tile features of one region's owned output, per source (`rail`: metro / tram / cable, `bus`). */
export interface SourceFeatures {
  lines: Feature[];
  stops: Feature[];
}
export type RegionFeatures = Record<"rail" | "bus", SourceFeatures>;

const SOURCES = { rail: RAIL_TILE, bus: BUS_TILE } as const;
/** Features are routed to the regions whose tiles they touch within this many tile widths (more than the tile buffers). */
const ROUTE_BUFFER_TILES = 1 / 8;

const empty = (): RegionFeatures => ({ rail: { lines: [], stops: [] }, bus: { lines: [], stops: [] } });

/**
 * Step 3a (regions.ts): the tile features of a region's owned lines and stations, grouped by the regions whose tiles
 * they reach (their own and, at a seam, the neighbours').
 */
export function routeFeatures(out: RegionOutput, rz = REGION_ZOOM): Map<string, RegionFeatures> {
  const dest = new Map<string, RegionFeatures>();
  const add = (src: "rail" | "bus", kind: "lines" | "stops", f: Feature, box: Box) => {
    for (const rk of regionsOfTiles(box, SOURCES[src].zoom, ROUTE_BUFFER_TILES, rz)) {
      let d = dest.get(rk);
      if (!d) dest.set(rk, (d = empty()));
      d[src][kind].push(f);
    }
  };
  for (const l of out.lines) add(isRailMode(l.mode) ? "rail" : "bus", "lines", lineFeature(l), boxOf(l.coords));
  // a station with any metro / tram / cable line is a rail station (its bus lines are listed too); the rest are bus stops
  for (const s of out.stations) add(s.modes & ~(1 << UMode.Bus) ? "rail" : "bus", "stops", stationFeature(s), boxOf([[s.lon, s.lat]]));
  return dest;
}

export interface CutTile {
  z: number;
  x: number;
  y: number;
  /** geojson-vt tiles per tile layer (URBAN_LAYERS) */
  layers: Record<string, { features: unknown[] }>;
}

/** Step 3b: cut the tiles of one source that lie in `region` from the features routed to it. */
export function cutRegionTiles(region: string, cfg: { zoom: number; extent: number }, f: SourceFeatures, rz = REGION_ZOOM): CutTile[] {
  const z = cfg.zoom;
  const opts = { maxZoom: z, indexMaxZoom: z, indexMaxPoints: 0, extent: cfg.extent, buffer: Math.round(cfg.extent / 16), tolerance: 1 };
  const fc = (fs: Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features: fs });
  const layers: Record<string, ReturnType<typeof geojsonvt>> = {};
  if (f.lines.length) layers[URBAN_LAYERS.line] = geojsonvt(fc(f.lines), opts);
  if (f.stops.length) layers[URBAN_LAYERS.stop] = geojsonvt(fc(f.stops), { ...opts, buffer: 64 });
  const keys = new Map<string, [number, number]>();
  for (const l of Object.values(layers))
    for (const t of (l as unknown as { tileCoords: { z: number; x: number; y: number }[] }).tileCoords)
      if (t.z === z && tileInRegion(z, t.x, t.y, region, rz)) keys.set(`${t.x}/${t.y}`, [t.x, t.y]);
  const out: CutTile[] = [];
  for (const [x, y] of [...keys.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const tl: CutTile["layers"] = {};
    for (const [name, l] of Object.entries(layers)) {
      const t = l.getTile(z, x, y);
      if (t && t.features.length) tl[name] = t;
    }
    if (Object.keys(tl).length) out.push({ z, x, y, layers: tl });
  }
  return out;
}

export const encodeTile = (t: CutTile, extent: number): Uint8Array => gzipSync(vtpbf.fromGeojsonVt(t.layers as Parameters<typeof vtpbf.fromGeojsonVt>[0], { version: 2, extent }), { level: 9 });

export interface UrbanTiles {
  rail: { z: number; x: number; y: number; data: Uint8Array }[];
  bus: { z: number; x: number; y: number; data: Uint8Array }[];
}

/** Step 3b for every region: the encoded tiles of both sources. */
export async function cutAllTiles(spill: Spill, rz = REGION_ZOOM): Promise<UrbanTiles> {
  const out: UrbanTiles = { rail: [], bus: [] };
  for (const group of await spill.groups("out")) {
    const region = group.slice("out/".length);
    const f = empty();
    for (const n of await spill.names(group)) {
      const part = await spill.get<RegionFeatures>(group, n);
      for (const src of ["rail", "bus"] as const) {
        f[src].lines.push(...part[src].lines);
        f[src].stops.push(...part[src].stops);
      }
    }
    for (const src of ["rail", "bus"] as const) for (const t of cutRegionTiles(region, SOURCES[src], f[src], rz)) out[src].push({ z: t.z, x: t.x, y: t.y, data: encodeTile(t, SOURCES[src].extent) });
  }
  return out;
}

/** Write the two tile layers `urb-rail` and `urb-bus` (`<buildDir>/layers/`, see packs.ts). */
export async function writeUrbanTiles(buildDir: string, tiles: UrbanTiles, log: (m: string) => void = console.log): Promise<{ info: UrbanInfo; tiles: number; bytes: number }> {
  let n = 0, bytes = 0;
  for (const [src, layer] of [["rail", PACK_LAYER.urbRail], ["bus", PACK_LAYER.urbBus]] as const) {
    const ts = tiles[src].sort((a, b) => a.x - b.x || a.y - b.y);
    const sum = ts.reduce((s, t) => s + t.data.length, 0);
    const max = ts.reduce((s, t) => Math.max(s, t.data.length), 0);
    await writeLayerFile(buildDir, layer, { minzoom: SOURCES[src].zoom, maxzoom: SOURCES[src].zoom }, ts);
    log(`urban ${layer}: ${ts.length} tiles at z${SOURCES[src].zoom}, ${(sum / 1e6).toFixed(1)} MB gz, largest ${(max / 1024).toFixed(0)} KB`);
    n += ts.length;
    bytes += sum;
  }
  const info: UrbanInfo = { version: URBAN_VERSION, rail: { zoom: RAIL_TILE.zoom }, bus: { zoom: BUS_TILE.zoom } };
  return { info, tiles: n, bytes };
}
