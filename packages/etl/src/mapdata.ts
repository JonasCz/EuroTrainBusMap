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
  FADE_ZOOM,
  STATION_ZOOM,
  levelIndex,
  minScenarioLevel,
  packScenario,
  unpackScenario,
  TILE_LAYERS,
  TILE_MAXZOOM,
  MODES_TILE_MAXZOOM,
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
const TILES_DIR = "tiles";
/** Tiles for mode filters (see writeMapData), up to MODES_TILE_MAXZOOM. */
const MODES_TILES_DIR = "tiles-m";
/** City markers are fully shown this much before the zoom of their level (must match the style); they fade in over FADE_ZOOM before that. */
const CITY_LEAD = 0.5;

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
  };
  const idx = buildNetIndex(net, { density: true, log });
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
  /** z: earliest zoom under any mode filter, zAll: with every mode on */
  const segFeatures: { f: Feature; z: number; zAll: number }[] = [];
  segments.forEach((s, i) => {
    const p = segProps[i];
    if (!p) return;
    segFeatures.push({ f: { type: "Feature", properties: tileProps(p), geometry: { type: "LineString", coordinates: s.coords } }, z: segmentMinZoom(p), zAll: segmentMinZoom(p, false) });
  });
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
  log(`mapdata: ${segFeatures.length} segments, ${cityFeatures.length} cities, ${stationFeatures.length} stations`);

  // ---- vector tiles (tileSize 512: tile zoom z is shown from map zoom z to z+1, and overzoomed past TILE_MAXZOOM)
  // Up to MODES_TILE_MAXZOOM there are two sets: `tiles/` with every mode on (what nearly everybody loads)
  // and `tiles-m/` with the lines of every mode filter (density.ts scenarios; far more lines at low zoom).
  // From there on `tiles/` serves both.
  for (const d of [TILES_DIR, MODES_TILES_DIR]) if (existsSync(join(buildDir, d))) await rm(join(buildDir, d), { recursive: true });
  const index: Record<string, number[]> = {};
  const modesIndex: Record<string, number[]> = {};
  let tileBytes = 0, maxTile = 0, modesBytes = 0;
  for (let z = TILE_MINZOOM; z <= TILE_MAXZOOM; z++) {
    const last = z === TILE_MAXZOOM;
    // The last level keeps (nearly) all stored detail: 1 unit ≈ 6 m at z9. Lower levels are only
    // seen at 1-2 zoom levels, where 4 units (z7: ~200 m, z8: ~100 m) is below a pixel.
    const extent = last ? 8192 : 4096;
    const opts = { maxZoom: z, indexMaxZoom: z, indexMaxPoints: 0, extent, buffer: last ? 512 : 256, tolerance: last ? 1 : 4 };
    const fc = (fs: Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features: fs });
    const cityVt = geojsonvt(fc(cityFeatures.filter((x) => last || x.z - CITY_LEAD - FADE_ZOOM < z + 1).map((x) => x.f)), { ...opts, buffer: 64 });
    const sets = z <= MODES_TILE_MAXZOOM ? [{ dir: MODES_TILES_DIR, modes: true }, { dir: TILES_DIR, modes: false }] : [{ dir: TILES_DIR, modes: true }];
    for (const set of sets) {
      const segs = segFeatures.filter((x) => last || (set.modes ? x.z : x.zAll) - FADE_ZOOM < z + 1).map((x) => (last ? x.f : forZoom(x.f, z, set.modes)));
      const layers: Record<string, ReturnType<typeof geojsonvt>> = {
        [TILE_LAYERS.seg]: geojsonvt(fc(mergeLines(segs)), opts),
        [TILE_LAYERS.city]: cityVt,
      };
      if (last) layers[TILE_LAYERS.station] = geojsonvt(fc(stationFeatures), { ...opts, buffer: 64 });
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
        await write(join(set.dir, String(z), String(x), `${y}.pbf.gz`), gz);
        if (set.dir === TILES_DIR) tileBytes += gz.length;
        else modesBytes += gz.length;
        maxTile = Math.max(maxTile, gz.length);
        list.push(x, y);
      }
      (set.dir === TILES_DIR ? index : modesIndex)[z] = list;
      log(`mapdata: z${z}${set.dir === TILES_DIR ? "" : " (mode filters)"}: ${list.length / 2} tiles`);
    }
  }
  log(`mapdata: tiles ${(tileBytes / 1e6).toFixed(1)} MB gz + ${(modesBytes / 1e6).toFixed(1)} MB for mode filters (z≤${MODES_TILE_MAXZOOM}), largest ${(maxTile / 1024).toFixed(0)} KB`);

  // ---- core + stations
  const core = packCore({
    schema: network.schema,
    build: network.build,
    timezones: network.timezones,
    cityList: network.cities,
    nStations: network.stations.length,
    counts: { stations: network.stations.length, corridors: network.corridors.length, segments: segments.length },
    tiles: {
      minzoom: TILE_MINZOOM,
      maxzoom: TILE_MAXZOOM,
      tiles: index,
      url: `${TILES_DIR}/{z}/{x}/{y}.pbf.gz`,
      modes: { maxzoom: MODES_TILE_MAXZOOM, tiles: modesIndex, url: `${MODES_TILES_DIR}/{z}/{x}/{y}.pbf.gz` },
    },
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
    else if (v !== 0 || k === "u" || k[0] === "l" || k[0] === "s") out[k] = v;
  }
  return out;
}

/**
 * Coarser properties for a tile shown from zoom z to z+1: categories not yet
 * fading in by z+1 (FADE_ZOOM before their level) under any mode filter are dropped, levels reached by z
 * (fully faded in) and levels not reached by then are clamped (also the packed scenario levels `s{k}`; `modes` false:
 * only the levels with every mode on are kept), widths rounded
 * to half units and no sort key – so more neighbours share properties.
 */
export function forZoom(f: Feature, z: number, modes = true): Feature {
  const p = f.properties as Record<string, number>;
  const lo = levelIndex(z), hi = levelIndex(z + 1 + FADE_ZOOM - 0.001);
  // levels not reached before z + 1 (+ fade) all look the same here: "later"
  const clamp = (l: number) => Math.min(Math.max(l, lo), hi + 1);
  const out: Record<string, number> = {};
  for (const k of CAT_BITS) {
    const l = p[`l${k}`];
    const min = modes ? minScenarioLevel(p, k) : l;
    if (l === undefined || min === undefined || min > hi) continue;
    out[`l${k}`] = clamp(l);
    if (modes && p[`s${k}`] !== undefined) {
      const ds = unpackScenario(p[`s${k}`]!).map(clamp);
      if (ds.some((v) => v !== out[`l${k}`])) out[`s${k}`] = packScenario(ds);
    }
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
