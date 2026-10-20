/**
 * Pack stage: regroups the per-layer tile files of a build (`<build>/layers/<layer>.pack`, written by the basemap,
 * mapdata and urban stages) into geographic tile packs (`<build>/packs/<hash>.pack`, packages/shared/src/tilepack.ts)
 * and returns the index for Manifest.packs. Run as the last stage of build.ts, after mapdata.ts / urban/index.ts
 * standalone runs, or alone on an existing build directory:
 *
 *   node --import tsx src/packs.ts <outDir>/<build> [--target-kb 384] [--basemap work/assets/basemap/tiles-v2.tar]
 *
 * (`--basemap` first rebuilds the `base` layer and Manifest.basemap from the basemap tiles asset.)
 *
 * Quadtree rule (planPacks): a node (tile z/x/y) takes the tiles under it from zoom `zc` on (the zooms its ancestors
 * did not take). If they all fit the target size they become one pack (band zc..maxZoom). Otherwise the node keeps
 * the lowest zooms that fit (at least its own zoom, which cannot be split) and hands the deeper ones to its four
 * children; when not even zoom zc fits, the node writes nothing and the children start at zc. Fill tiles (basemap
 * all-land) are repeated in every pack they cover, as one entry for the pack's node when they cover all of it.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LAYERS_DIR } from "./tilelayers.ts";
import {
  encodePack,
  PACK_ENTRY_BYTES,
  PACK_LAYER,
  PACK_VERSION,
  TilePack,
  type Manifest,
  type PackNode,
  type PackSet,
  type PackTile,
  type TilePacks,
} from "@etbm/shared";

/** Default pack size target (compressed bytes). Bigger packs = fewer files and requests, more bytes per view. */
export const PACK_TARGET = 384 * 1024;
/** Hard limit per file (Cloudflare Workers static assets: 25 MiB). */
export const PACK_HARD_CAP = 20 * 1024 * 1024;
export const PACKS_DIR = "packs";

/**
 * Layer groups, one quadtree each. The mode-filter network is its own set: it replaces `net` at low zooms only while
 * a mode filter is on, so the default view never downloads it.
 */
export const PACK_SETS: { layers: string[]; fill?: string }[] = [
  { layers: [PACK_LAYER.base, PACK_LAYER.net, PACK_LAYER.urbRail, PACK_LAYER.urbBus], fill: PACK_LAYER.base },
  { layers: [PACK_LAYER.netModes] },
];

export interface PlannedPack {
  node: PackNode;
  tiles: PackTile[];
  bytes: number;
}

const under = (t: { z: number; x: number; y: number }, n: { z: number; x: number; y: number }) =>
  t.z >= n.z && t.x >> (t.z - n.z) === n.x && t.y >> (t.z - n.z) === n.y;

/** Split the tiles of one layer group into packs (see the file comment). */
export function planPacks(tiles: PackTile[], o: { target: number; minZoom?: number; maxZoom: number }): PlannedPack[] {
  const out: PlannedPack[] = [];
  const size = (t: PackTile) => PACK_ENTRY_BYTES + (t.data?.length ?? 0);
  const data = tiles.filter((t) => t.data);
  const fills = tiles.filter((t) => !t.data);
  const minZoom = o.minZoom ?? Math.min(...tiles.map((t) => t.z));

  const emit = (n: { z: number; x: number; y: number }, zc: number, zk: number, ts: PackTile[], fs: PackTile[]) => {
    const node: PackNode = { z: n.z, x: n.x, y: n.y, zmin: zc, zmax: zk };
    const own = ts.filter((t) => t.z <= zk);
    const fk = new Set<string>();
    const fill: PackTile[] = [];
    for (const f of fs) {
      if (f.z > zk) continue;
      const t = f.z <= n.z ? { layer: f.layer, z: n.z, x: n.x, y: n.y, data: null } : f;
      const k = `${t.layer}/${t.z}/${t.x}/${t.y}`;
      if (!fk.has(k)) fk.add(k), fill.push(t);
    }
    const all = [...own, ...fill];
    out.push({ node, tiles: all, bytes: all.reduce((s, t) => s + size(t), 0) });
  };

  const rec = (n: { z: number; x: number; y: number }, zc: number, ts: PackTile[], fs: PackTile[]) => {
    if (!ts.length && !fs.length) return;
    const perZoom = new Map<number, number>();
    for (const t of ts) perZoom.set(t.z, (perZoom.get(t.z) ?? 0) + size(t));
    for (const f of fs) if (f.z >= zc && f.z > n.z) perZoom.set(f.z, (perZoom.get(f.z) ?? 0) + size(f));
    const total = [...perZoom.values()].reduce((a, b) => a + b, 0);
    let zk: number;
    if (total <= o.target) zk = o.maxZoom;
    else {
      let acc = 0;
      zk = zc - 1;
      for (let z = zc; z <= o.maxZoom; z++) {
        const s = perZoom.get(z) ?? 0;
        if (acc + s > o.target) break;
        acc += s;
        zk = z;
      }
      if (zc <= n.z) zk = Math.max(zk, n.z); // zooms up to the node's own cannot be split among children
    }
    if (zk >= zc) emit(n, zc, zk, ts, fs);
    if (zk >= o.maxZoom) return;
    const deeper = ts.filter((t) => t.z > zk);
    for (let i = 0; i < 4; i++) {
      const c = { z: n.z + 1, x: n.x * 2 + (i & 1), y: n.y * 2 + (i >> 1) };
      rec(
        c,
        Math.max(zc, zk + 1),
        deeper.filter((t) => under(t, c)),
        fs.filter((f) => f.z <= n.z || under(f, c)),
      );
    }
  };
  rec({ z: 0, x: 0, y: 0 }, minZoom, data, fills);
  return out;
}

/** A pack whose only entry is a fill tile for its whole node needs no file. */
const fillOnly = (p: PlannedPack) => p.tiles.length === 1 && !p.tiles[0]!.data && p.tiles[0]!.z === p.node.z;

export interface PackStats {
  files: number;
  bytes: number;
  fillOnly: number;
  largest: number;
  /** pack sizes in KiB buckets: "<64", "64-128", … */
  histogram: Record<string, number>;
}

/** Read `<buildDir>/layers/*.pack`, write `<buildDir>/packs/`, return Manifest.packs. */
export async function writePacks(buildDir: string, o: { target?: number; log?: (m: string) => void } = {}): Promise<{ packs: TilePacks; stats: PackStats }> {
  const log = o.log ?? console.log;
  const target = o.target ?? PACK_TARGET;
  const layersDir = join(buildDir, LAYERS_DIR);
  const layerTiles = new Map<string, PackTile[]>();
  const layers: TilePacks["layers"] = {};
  if (existsSync(layersDir)) {
    for (const f of (await readdir(layersDir)).sort()) {
      if (!f.endsWith(".pack")) continue;
      const p = new TilePack(await readFile(join(layersDir, f)));
      const name = f.slice(0, -".pack".length);
      const ts = [...p.entries()];
      if (ts.some((t) => t.layer !== name)) throw new Error(`${f}: holds tiles of another layer`);
      layerTiles.set(name, ts);
      layers[name] = { minzoom: p.node.zmin, maxzoom: p.node.zmax };
    }
  }
  const dir = join(buildDir, PACKS_DIR);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const stats: PackStats = { files: 0, bytes: 0, fillOnly: 0, largest: 0, histogram: {} };
  const sets: PackSet[] = [];
  const known = new Set(PACK_SETS.flatMap((s) => s.layers));
  for (const l of layerTiles.keys()) if (!known.has(l)) throw new Error(`layer ${l} belongs to no pack set (PACK_SETS)`);
  for (const def of PACK_SETS) {
    const ls = def.layers.filter((l) => layerTiles.has(l));
    if (!ls.length) continue;
    const tiles = ls.flatMap((l) => layerTiles.get(l)!);
    const maxZoom = Math.max(...ls.map((l) => layers[l]!.maxzoom));
    const minZoom = Math.min(...ls.map((l) => layers[l]!.minzoom));
    const planned = planPacks(tiles, { target, minZoom, maxZoom });
    const set: PackSet = { layers: ls, nodes: [], files: [], ...(def.fill && ls.includes(def.fill) ? { fill: def.fill } : {}) };
    for (const p of planned) {
      set.nodes.push(p.node.z, p.node.x, p.node.y, p.node.zmin, p.node.zmax);
      if (fillOnly(p)) {
        set.files.push("");
        stats.fillOnly++;
        continue;
      }
      const buf = encodePack(p.node, p.tiles);
      if (buf.length > PACK_HARD_CAP) throw new Error(`pack ${p.node.z}/${p.node.x}/${p.node.y} is ${buf.length} bytes (cap ${PACK_HARD_CAP})`);
      const hash = createHash("sha256").update(buf).digest("hex").slice(0, 16);
      await writeFile(join(dir, `${hash}.pack`), buf);
      set.files.push(hash);
      stats.files++;
      stats.bytes += buf.length;
      stats.largest = Math.max(stats.largest, buf.length);
      const kb = buf.length / 1024;
      const b = kb < 64 ? "<64" : kb < 128 ? "64-128" : kb < 256 ? "128-256" : kb < 384 ? "256-384" : kb < 512 ? "384-512" : kb < 1024 ? "512-1024" : ">=1024";
      stats.histogram[b] = (stats.histogram[b] ?? 0) + 1;
    }
    sets.push(set);
    log(`packs [${ls.join(", ")}]: ${planned.length} packs (${set.files.filter((f) => !f).length} fill-only), ${tiles.length} tiles`);
  }
  log(`packs: ${stats.files} files, ${(stats.bytes / 1e6).toFixed(1)} MB, largest ${(stats.largest / 1024).toFixed(0)} KiB, target ${(target / 1024).toFixed(0)} KiB; sizes (KiB) ${JSON.stringify(stats.histogram)}`);
  return { packs: { version: PACK_VERSION, dir: `${PACKS_DIR}/`, layers, sets }, stats };
}

/** Repack an existing build directory and point its manifest at the packs (standalone stage runs). */
export async function repackBuild(buildDir: string, o: { target?: number; log?: (m: string) => void } = {}): Promise<void> {
  const r = await writePacks(buildDir, o);
  const mf = join(buildDir, "..", "manifest.json");
  if (!existsSync(mf)) return;
  const m = JSON.parse(await readFile(mf, "utf8")) as Manifest;
  if (m.build !== resolve(buildDir).split("/").pop()) return;
  m.packs = r.packs;
  Object.assign(m.stats, packStats(r.stats));
  await writeFile(mf, JSON.stringify(m));
  (o.log ?? console.log)("manifest updated (packs)");
}

export const packStats = (s: PackStats): Record<string, number> => ({ packFiles: s.files, packBytes: s.bytes, packLargest: s.largest });

// CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2).filter((x) => x !== "--");
  const get = (n: string) => (a.indexOf(n) >= 0 ? a[a.indexOf(n) + 1] : undefined);
  const kb = get("--target-kb") ? Number(get("--target-kb")) : undefined;
  const dir = a.find((x, i) => !x.startsWith("--") && !a[i - 1]?.startsWith("--"));
  if (!dir) {
    console.error("usage: packs.ts <buildDir> [--target-kb N] [--basemap <tiles-v2.tar>]");
    process.exit(1);
  }
  const buildDir = resolve(dir);
  const tar = get("--basemap");
  if (tar) {
    const bm = await import("./basemap/tiles.ts");
    const r = await bm.installBasemapLayer(resolve(tar), buildDir);
    console.log(`basemap: ${r.files} tiles, base layer ${(r.bytes / 1e6).toFixed(1)} MB`);
    const mf = join(buildDir, "..", "manifest.json");
    if (existsSync(mf)) {
      const m = JSON.parse(await readFile(mf, "utf8")) as Manifest;
      m.basemap = { version: bm.BASEMAP_VERSION, minzoom: bm.BASEMAP_MINZOOM, maxzoom: bm.BASEMAP_MAXZOOM, bounds: [...r.bounds] };
      await writeFile(mf, JSON.stringify(m));
    }
  }
  await repackBuild(buildDir, { target: kb ? kb * 1024 : undefined });
}
