/// <reference path="./vt-pbf.d.ts" />
/**
 * Progressive map data (see packages/shared/src/netmap.ts): core.json,
 * stations.json, gzipped vector tiles of the drawn network and per-shard
 * highlight geometry. Run as part of build.ts, or standalone on an existing
 * build directory:
 *
 *   node --import tsx src/mapdata.ts <outDir>/<build>
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";
import {
  CAT_BITS,
  STATION_ZOOM,
  levelIndex,
  TILE_LAYERS,
  TILE_MAXZOOM,
  buildNetIndex,
  ensureSegments,
  mergeLines,
  cityMinZoom,
  cityProps,
  expandNetwork,
  packCore,
  packGeo,
  segmentMinZoom,
  segmentProps,
  stationProps,
  terminalGeometry,
  type CityFile,
  type CityShardFile,
  type MapNet,
  type Manifest,
  MAPDATA_VERSION,
  type NetworkFile,
  type Segment,
} from "@etbm/shared";

type Feature = GeoJSON.Feature;
type Log = (msg: string) => void;

const TILE_MINZOOM = 2;

export interface MapDataResult {
  files: number;
  bytes: number;
  /** Manifest.mapdata */
  mapdata: NonNullable<Manifest["mapdata"]>;
}

/**
 * Write the map data for `net` (expanded, with segments) into `buildDir`.
 * Reads the timetable shards already written there to build the geo files.
 */
export async function writeMapData(network: NetworkFile, buildDir: string, log: Log = console.log): Promise<MapDataResult> {
  const t0 = Date.now();
  const segments = ensureSegments(network);
  const net: MapNet = {
    cities: network.cities,
    corridors: network.corridors,
    segments,
    stations: network.stations,
    hasDtCats: network.corridors.some((c) => c.dtCats !== undefined),
  };
  const idx = buildNetIndex(net);
  let files = 0, bytes = 0;
  const write = async (rel: string, data: string | Uint8Array) => {
    const p = join(buildDir, rel);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, data);
    files++;
    bytes += typeof data === "string" ? Buffer.byteLength(data) : data.length;
  };

  // ---- features
  const segProps = segments.map((s: Segment) => segmentProps(net, idx, s));
  const segFeatures: { f: Feature; z: number }[] = [];
  segments.forEach((s, i) => {
    const p = segProps[i];
    if (!p) return;
    segFeatures.push({ f: { type: "Feature", properties: tileProps(p), geometry: { type: "LineString", coordinates: s.coords } }, z: segmentMinZoom(p) });
  });
  const termFeatures: Feature[] = [];
  const doneTerm = new Set<string>();
  for (const c of network.corridors) {
    for (const end of ["a", "b"] as const) {
      const t = terminalGeometry((sid) => segments[sid]?.coords, (id) => network.stations[id], c, idx.cutA[c.id]!, idx.cutB[c.id]!, end);
      if (!t) continue;
      const p = segProps[t.sid];
      if (!p || p.hop) continue;
      const st = end === "a" ? c.sa : c.sb;
      const key = `${t.sid}:${st}`;
      if (doneTerm.has(key)) continue;
      doneTerm.add(key);
      termFeatures.push({ type: "Feature", properties: tileProps(p), geometry: { type: "LineString", coordinates: t.coords } });
    }
  }
  const cityFeatures: { f: Feature; z: number }[] = [];
  cityProps(net, idx, segProps).forEach((p, i) => {
    if (!p) return;
    const c = network.cities[i]!;
    cityFeatures.push({ f: { type: "Feature", id: c.id, properties: p, geometry: { type: "Point", coordinates: [c.lon, c.lat] } }, z: cityMinZoom(p) });
  });
  const stationFeatures: Feature[] = [];
  for (const c of network.cities) {
    c.stations.forEach((sid, rank) => {
      const s = network.stations[sid]!;
      stationFeatures.push({ type: "Feature", id: sid, properties: stationProps(c, s, rank), geometry: { type: "Point", coordinates: [s.lon, s.lat] } });
    });
  }
  log(`mapdata: ${segFeatures.length} segments, ${termFeatures.length} terminal pieces, ${cityFeatures.length} cities, ${stationFeatures.length} stations`);

  // ---- vector tiles (tileSize 512: tile zoom z is shown from map zoom z to z+1, and overzoomed past TILE_MAXZOOM)
  const tileDir = join(buildDir, "tiles");
  if (existsSync(tileDir)) await rm(tileDir, { recursive: true });
  const index: Record<string, number[]> = {};
  let tileBytes = 0, maxTile = 0;
  for (let z = TILE_MINZOOM; z <= TILE_MAXZOOM; z++) {
    const last = z === TILE_MAXZOOM;
    const extent = last ? 8192 : 4096;
    const opts = { maxZoom: z, indexMaxZoom: z, indexMaxPoints: 0, extent, buffer: last ? 512 : 256, tolerance: last ? 6 : 4 };
    const fc = (fs: Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features: fs });
    const layers: Record<string, ReturnType<typeof geojsonvt>> = {
      [TILE_LAYERS.seg]: geojsonvt(fc(mergeLines(segFeatures.filter((x) => last || x.z < z + 1).map((x) => (last ? x.f : forZoom(x.f, z))))), opts),
      [TILE_LAYERS.city]: geojsonvt(fc(cityFeatures.filter((x) => last || x.z < z + 1).map((x) => x.f)), { ...opts, buffer: 64 }),
    };
    if (last) {
      layers[TILE_LAYERS.term] = geojsonvt(fc(mergeLines(termFeatures)), opts);
      layers[TILE_LAYERS.station] = geojsonvt(fc(stationFeatures), { ...opts, buffer: 64 });
    }
    const keys = new Map<string, [number, number]>();
    for (const l of Object.values(layers)) {
      for (const t of (l as unknown as { tileCoords: { z: number; x: number; y: number }[] }).tileCoords) if (t.z === z) keys.set(`${t.x}/${t.y}`, [t.x, t.y]);
    }
    const list: number[] = [];
    for (const [x, y] of keys.values()) {
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
      const pbf = vtpbf.fromGeojsonVt(tl, { version: 2, extent });
      const gz = gzipSync(pbf, { level: 9 });
      await write(join("tiles", String(z), String(x), `${y}.pbf.gz`), gz);
      tileBytes += gz.length;
      maxTile = Math.max(maxTile, gz.length);
      list.push(x, y);
    }
    index[z] = list;
    log(`mapdata: z${z}: ${list.length / 2} tiles`);
  }
  log(`mapdata: tiles ${(tileBytes / 1e6).toFixed(1)} MB gz, largest ${(maxTile / 1024).toFixed(0)} KB`);

  // ---- core + stations
  const core = packCore({
    schema: network.schema,
    build: network.build,
    timezones: network.timezones,
    cityList: network.cities,
    nStations: network.stations.length,
    counts: { stations: network.stations.length, corridors: network.corridors.length, segments: segments.length },
    hasDtCats: net.hasDtCats,
    tiles: { minzoom: TILE_MINZOOM, maxzoom: TILE_MAXZOOM, tiles: index, url: "tiles/{z}/{x}/{y}.pbf.gz" },
  });
  await write("core.json", JSON.stringify(core));

  // ---- geo files: corridors referenced by each timetable shard / stand-alone city file
  const geoDir = join(buildDir, "geo");
  if (existsSync(geoDir)) await rm(geoDir, { recursive: true });
  let geoBytes = 0, nGeo = 0;
  const corridorsOf = (cfs: CityFile[]) => {
    const ids = new Set<number>();
    for (const cf of cfs) for (const p of cf.patterns) for (const c of p.corridors) ids.add(c);
    return ids;
  };
  const stationsOf = (cfs: CityFile[]) => {
    const ids = new Set<number>();
    for (const cf of cfs) {
      for (const s of network.cities[cf.city]?.stations ?? []) ids.add(s);
      for (const p of cf.patterns) for (const s of p.stations) ids.add(s);
    }
    return ids;
  };
  const writeGeo = async (rel: string, cfs: CityFile[]) => {
    const json = JSON.stringify(packGeo(net, idx, corridorsOf(cfs), stationsOf(cfs)));
    await write(rel, json);
    geoBytes += json.length;
    nGeo++;
  };
  const shardDir = join(buildDir, "shard");
  if (existsSync(shardDir)) {
    for (const f of await readdir(shardDir)) {
      if (!f.endsWith(".json")) continue;
      const sf = JSON.parse(await readFile(join(shardDir, f), "utf8")) as CityShardFile;
      await writeGeo(join("geo", f), Object.values(sf.cities));
    }
  }
  const cityDir = join(buildDir, "city");
  if (existsSync(cityDir)) {
    for (const f of await readdir(cityDir)) {
      if (!f.endsWith(".json")) continue;
      const cf = JSON.parse(await readFile(join(cityDir, f), "utf8")) as CityFile;
      await writeGeo(join("geo", `c${f}`), [cf]);
    }
  }
  log(`mapdata: ${nGeo} geo files, ${(geoBytes / 1e6).toFixed(1)} MB raw; total ${files} files in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return { files, bytes, mapdata: { version: MAPDATA_VERSION, core: "core.json", tiles: core.tiles } };
}

/**
 * Tile properties of a segment: no ids (the highlight uses the geo files), widths
 * and sort keys quantised so equal-looking neighbours can be merged.
 */
export function tileProps(p: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "sid") continue;
    if (k === "k") out.k = Math.round(Math.log2(1 + v) * 2);
    else if (k[0] === "w") out[k] = Math.round(v * 4) / 4;
    else if (v !== 0 || k === "u" || k[0] === "l") out[k] = v;
  }
  return out;
}

/**
 * Coarser properties for a tile shown from zoom z to z+1: categories not yet
 * visible by z+1 are dropped, levels reached by z are clamped, widths rounded
 * to half units and no sort key – so more neighbours share properties.
 */
export function forZoom(f: Feature, z: number): Feature {
  const p = f.properties as Record<string, number>;
  const lo = levelIndex(z), hi = levelIndex(z + 0.999);
  const out: Record<string, number> = {};
  for (const k of CAT_BITS) {
    const l = p[`l${k}`];
    if (l === undefined || l > hi) continue;
    out[`l${k}`] = Math.max(l, lo);
    out[`w${k}`] = Math.round(p[`w${k}`]! * 2) / 2;
    if (p[`d${k}`]) out[`d${k}`] = 1;
  }
  out.u = p.u!;
  if (p.hop) out.hop = 1;
  return { type: "Feature", properties: out, geometry: f.geometry };
}

export { STATION_ZOOM };

// CLI: rebuild map data for an existing build directory
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: mapdata.ts <buildDir>");
    process.exit(1);
  }
  const n = expandNetwork(JSON.parse(await readFile(join(dir, "network.json"), "utf8")) as NetworkFile);
  const r = await writeMapData(n, dir);
  const mf = join(dir, "..", "manifest.json");
  if (existsSync(mf)) {
    const m = JSON.parse(await readFile(mf, "utf8")) as Manifest;
    if (m.build === n.build) {
      m.mapdata = r.mapdata;
      await writeFile(mf, JSON.stringify(m, null, 2));
      console.log("manifest updated");
    }
  }
}
