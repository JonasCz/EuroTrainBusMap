/// <reference path="../vt-pbf.d.ts" />
import { gzipSync } from "node:zlib";
import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";
import type { UrbanInfo } from "@etbm/shared";
import { PACK_LAYER, URBAN_LAYERS, URBAN_VERSION } from "@etbm/shared";
import { writeLayerFile } from "../tilelayers.ts";
import { UMode } from "./types.ts";
import type { BuiltUrban, DrawnLine, UrbanStation } from "./model.ts";

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

async function writeSource(
  buildDir: string,
  layer: string,
  cfg: { zoom: number; extent: number },
  lines: Feature[],
  stations: Feature[],
  log: (m: string) => void,
): Promise<{ tiles: number; bytes: number; maxBytes: number }> {
  const z = cfg.zoom;
  const opts = { maxZoom: z, indexMaxZoom: z, indexMaxPoints: 0, extent: cfg.extent, buffer: Math.round(cfg.extent / 16), tolerance: 1 };
  const fc = (fs: Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features: fs });
  const layers: Record<string, ReturnType<typeof geojsonvt>> = {};
  if (lines.length) layers[URBAN_LAYERS.line] = geojsonvt(fc(lines), opts);
  if (stations.length) layers[URBAN_LAYERS.stop] = geojsonvt(fc(stations), { ...opts, buffer: 64 });
  const keys = new Map<string, [number, number]>();
  for (const l of Object.values(layers))
    for (const t of (l as unknown as { tileCoords: { z: number; x: number; y: number }[] }).tileCoords) if (t.z === z) keys.set(`${t.x}/${t.y}`, [t.x, t.y]);
  const out = { tiles: 0, bytes: 0, maxBytes: 0 };
  const tiles: { z: number; x: number; y: number; data: Uint8Array }[] = [];
  for (const [x, y] of [...keys.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const tl: Record<string, unknown> = {};
    let n = 0;
    for (const [name, l] of Object.entries(layers)) {
      const t = l.getTile(z, x, y);
      if (t && t.features.length) {
        tl[name] = t;
        n += t.features.length;
      }
    }
    if (!n) continue;
    const gz = gzipSync(vtpbf.fromGeojsonVt(tl, { version: 2, extent: cfg.extent }), { level: 9 });
    tiles.push({ z, x, y, data: gz });
    out.tiles++;
    out.bytes += gz.length;
    out.maxBytes = Math.max(out.maxBytes, gz.length);
  }
  await writeLayerFile(buildDir, layer, { minzoom: z, maxzoom: z }, tiles);
  log(`urban ${layer}: ${out.tiles} tiles at z${z}, ${(out.bytes / 1e6).toFixed(1)} MB gz, largest ${(out.maxBytes / 1024).toFixed(0)} KB`);
  return out;
}

/** Write the vector tiles of the local-transport layer: tile layers `urb-rail` and `urb-bus` (`<buildDir>/layers/`, see packs.ts). */
export async function writeUrbanTiles(buildDir: string, built: BuiltUrban, log: (m: string) => void = console.log): Promise<{ info: UrbanInfo; tiles: number; bytes: number }> {
  const railLines = built.lines.filter((l) => isRailMode(l.mode)).map(lineFeature);
  const busLines = built.lines.filter((l) => !isRailMode(l.mode)).map(lineFeature);
  // a station with any metro / tram / cable line is a rail station (its bus lines are listed too); the rest are bus stops
  const railStations = built.stations.filter((s) => s.modes & ~(1 << UMode.Bus)).map(stationFeature);
  const busStations = built.stations.filter((s) => !(s.modes & ~(1 << UMode.Bus))).map(stationFeature);
  const rail = await writeSource(buildDir, PACK_LAYER.urbRail, RAIL_TILE, railLines, railStations, log);
  const bus = await writeSource(buildDir, PACK_LAYER.urbBus, BUS_TILE, busLines, busStations, log);
  const info: UrbanInfo = { version: URBAN_VERSION, rail: { zoom: RAIL_TILE.zoom }, bus: { zoom: BUS_TILE.zoom } };
  return { info, tiles: rail.tiles + bus.tiles, bytes: rail.bytes + bus.bytes };
}
