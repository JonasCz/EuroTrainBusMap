/// <reference path="../vt-pbf.d.ts" />
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";
import type { UrbanInfo } from "@etbm/shared";
import { URBAN_LAYERS, URBAN_VERSION } from "@etbm/shared";
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
  kind: "rail" | "bus",
  cfg: { zoom: number; extent: number },
  lines: Feature[],
  stations: Feature[],
  log: (m: string) => void,
): Promise<{ tiles: number[]; files: number; bytes: number; maxBytes: number }> {
  const z = cfg.zoom;
  const opts = { maxZoom: z, indexMaxZoom: z, indexMaxPoints: 0, extent: cfg.extent, buffer: Math.round(cfg.extent / 16), tolerance: 1 };
  const fc = (fs: Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features: fs });
  const layers: Record<string, ReturnType<typeof geojsonvt>> = {};
  if (lines.length) layers[URBAN_LAYERS.line] = geojsonvt(fc(lines), opts);
  if (stations.length) layers[URBAN_LAYERS.stop] = geojsonvt(fc(stations), { ...opts, buffer: 64 });
  const keys = new Map<string, [number, number]>();
  for (const l of Object.values(layers))
    for (const t of (l as unknown as { tileCoords: { z: number; x: number; y: number }[] }).tileCoords) if (t.z === z) keys.set(`${t.x}/${t.y}`, [t.x, t.y]);
  const out = { tiles: [] as number[], files: 0, bytes: 0, maxBytes: 0 };
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
    const rel = join("urban", kind, String(z), String(x), `${y}.pbf.gz`);
    await mkdir(join(buildDir, rel, ".."), { recursive: true });
    await writeFile(join(buildDir, rel), gz);
    out.tiles.push(x, y);
    out.files++;
    out.bytes += gz.length;
    out.maxBytes = Math.max(out.maxBytes, gz.length);
  }
  log(`urban ${kind}: ${out.files} tiles at z${z}, ${(out.bytes / 1e6).toFixed(1)} MB gz, largest ${(out.maxBytes / 1024).toFixed(0)} KB`);
  return out;
}

/** Write the vector tiles of the local-transport layer into `<buildDir>/urban/`. */
export async function writeUrbanTiles(buildDir: string, built: BuiltUrban, log: (m: string) => void = console.log): Promise<{ info: UrbanInfo; files: number; bytes: number }> {
  const dir = join(buildDir, "urban");
  if (existsSync(dir)) await rm(dir, { recursive: true });
  const railLines = built.lines.filter((l) => isRailMode(l.mode)).map(lineFeature);
  const busLines = built.lines.filter((l) => !isRailMode(l.mode)).map(lineFeature);
  // a station with any metro / tram / cable line is a rail station (its bus lines are listed too); the rest are bus stops
  const railStations = built.stations.filter((s) => s.modes & ~(1 << UMode.Bus)).map(stationFeature);
  const busStations = built.stations.filter((s) => !(s.modes & ~(1 << UMode.Bus))).map(stationFeature);
  const rail = await writeSource(buildDir, "rail", RAIL_TILE, railLines, railStations, log);
  const bus = await writeSource(buildDir, "bus", BUS_TILE, busLines, busStations, log);
  const info: UrbanInfo = {
    version: URBAN_VERSION,
    rail: { zoom: RAIL_TILE.zoom, tiles: rail.tiles, url: "urban/rail/{z}/{x}/{y}.pbf.gz" },
    bus: { zoom: BUS_TILE.zoom, tiles: bus.tiles, url: "urban/bus/{z}/{x}/{y}.pbf.gz" },
  };
  return { info, files: rail.files + bus.files, bytes: rail.bytes + bus.bytes };
}
