/**
 * Tile packs: every vector tile of the map (basemap land / lakes, the intercity network, local transport) is served
 * from a few hundred pack files instead of one file per tile (the static host allows 20k files and no HTTP Range
 * requests, so a client fetches a whole pack once and cuts the tiles out of it).
 *
 * A pack covers one node of a quadtree (tile z/x/y) and a band of tile zooms [zmin, zmax]: it holds every tile of
 * its set's layers under the node within the band. The ETL (packages/etl/src/packs.ts) splits a node into its four
 * children when the pack would exceed the target size, so sparse areas get large packs and dense cities small ones;
 * low zooms end up in a few overview packs. The pack index (`TilePacks`) is part of manifest.json.
 *
 * Binary layout (little endian):
 *   u32 magic "ETBP" | u8 version | u8 node z | u16 node x | u16 node y | u8 zmin | u8 zmax
 *   u8 layer count, per layer: u8 name length + ASCII name
 *   u32 entry count, per entry (PACK_ENTRY_BYTES): u8 layer | u8 z | u16 x | u16 y | u32 byte length
 *   tile bytes, in entry order (gzipped MVTs, as the ETL wrote them)
 * An entry of length 0 is a *fill* tile: the layer's tile there and at every zoom below it (within the pack) is the
 * layer's fill tile (basemap: entirely land). Tiles without an entry are empty (basemap: sea).
 *
 * Intermediate files: the ETL stages write each layer as ONE pack covering everything (`<build>/layers/<layer>.pack`,
 * node 0/0/0); the pack stage regroups them into `<build>/packs/`. Only `packs/` is deployed.
 */

export const PACK_VERSION = 1;
const MAGIC = 0x50425445; // "ETBP"
export const PACK_ENTRY_BYTES = 10;
/** Zooms up to 16 (x, y fit in u16). */
export const PACK_MAX_ZOOM = 16;

/** Tile layers. Each is one MapLibre vector source (`etbmgz://pack/<layer>/{z}/{x}/{y}`, web/src/map/packs.ts). */
export const PACK_LAYER = {
  /** OSM land + lakes (fill = entirely land) */
  base: "base",
  /** intercity network, every mode on (and every mode filter beyond TileIndex.modes.maxzoom) */
  net: "net",
  /** intercity network for mode filters, up to TileIndex.modes.maxzoom */
  netModes: "net-m",
  /** metro / tram lines and their stops */
  urbRail: "urb-rail",
  /** local bus lines and bus stops */
  urbBus: "urb-bus",
} as const;
export type PackLayer = (typeof PACK_LAYER)[keyof typeof PACK_LAYER];

export interface PackTile {
  layer: string;
  z: number;
  x: number;
  y: number;
  /** tile bytes (gzipped MVT); null = fill tile */
  data: Uint8Array | null;
}

export interface PackNode {
  z: number;
  x: number;
  y: number;
  zmin: number;
  zmax: number;
}

export function encodePack(node: PackNode, tiles: PackTile[]): Uint8Array {
  const layers = [...new Set(tiles.map((t) => t.layer))].sort();
  const li = new Map(layers.map((l, i) => [l, i]));
  const head = 4 + 1 + 1 + 2 + 2 + 1 + 1 + 1 + layers.reduce((s, l) => s + 1 + l.length, 0) + 4;
  const data = tiles.reduce((s, t) => s + (t.data?.length ?? 0), 0);
  const out = new Uint8Array(head + tiles.length * PACK_ENTRY_BYTES + data);
  const v = new DataView(out.buffer);
  let p = 0;
  v.setUint32(p, MAGIC, true);
  v.setUint8(p + 4, PACK_VERSION);
  v.setUint8(p + 5, node.z);
  v.setUint16(p + 6, node.x, true);
  v.setUint16(p + 8, node.y, true);
  v.setUint8(p + 10, node.zmin);
  v.setUint8(p + 11, node.zmax);
  v.setUint8(p + 12, layers.length);
  p += 13;
  for (const l of layers) {
    if (l.length > 255 || !/^[\x20-\x7e]*$/.test(l)) throw new Error(`bad layer name ${l}`);
    v.setUint8(p++, l.length);
    for (let i = 0; i < l.length; i++) v.setUint8(p++, l.charCodeAt(i));
  }
  v.setUint32(p, tiles.length, true);
  p += 4;
  let d = p + tiles.length * PACK_ENTRY_BYTES;
  for (const t of tiles) {
    if (t.z > PACK_MAX_ZOOM) throw new Error(`zoom ${t.z} > ${PACK_MAX_ZOOM}`);
    if (t.data && !t.data.length) throw new Error(`empty tile ${t.layer} ${t.z}/${t.x}/${t.y} (use null for a fill tile)`);
    v.setUint8(p, li.get(t.layer)!);
    v.setUint8(p + 1, t.z);
    v.setUint16(p + 2, t.x, true);
    v.setUint16(p + 4, t.y, true);
    v.setUint32(p + 6, t.data?.length ?? 0, true);
    p += PACK_ENTRY_BYTES;
    if (t.data) {
      out.set(t.data, d);
      d += t.data.length;
    }
  }
  return out;
}

const key = (layer: number, z: number, x: number, y: number) => ((y * 65536 + x) * 32 + z) * 256 + layer; // < 2^53

/** A pack read back: tile lookup by layer and z/x/y. */
export class TilePack {
  readonly node: PackNode;
  readonly layers: string[];
  readonly bytes: Uint8Array;
  /** key → [offset, length] (length 0 = fill) */
  private index = new Map<number, [number, number]>();

  constructor(buf: ArrayBuffer | Uint8Array) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b.byteLength < 17 || v.getUint32(0, true) !== MAGIC) throw new Error("not a tile pack");
    if (v.getUint8(4) !== PACK_VERSION) throw new Error(`tile pack version ${v.getUint8(4)}, expected ${PACK_VERSION}`);
    this.node = { z: v.getUint8(5), x: v.getUint16(6, true), y: v.getUint16(8, true), zmin: v.getUint8(10), zmax: v.getUint8(11) };
    const nl = v.getUint8(12);
    let p = 13;
    this.layers = [];
    for (let i = 0; i < nl; i++) {
      const n = v.getUint8(p++);
      this.layers.push(String.fromCharCode(...b.subarray(p, p + n)));
      p += n;
    }
    const ne = v.getUint32(p, true);
    p += 4;
    let d = p + ne * PACK_ENTRY_BYTES;
    for (let i = 0; i < ne; i++, p += PACK_ENTRY_BYTES) {
      const len = v.getUint32(p + 6, true);
      this.index.set(key(v.getUint8(p), v.getUint8(p + 1), v.getUint16(p + 2, true), v.getUint16(p + 4, true)), [d, len]);
      d += len;
    }
    if (d !== b.byteLength) throw new Error(`tile pack: ${b.byteLength} bytes, index says ${d}`);
    this.bytes = b;
  }

  get size(): number {
    return this.index.size;
  }

  /**
   * The tile `layer` z/x/y: its bytes (a view into the pack), "fill" (a fill entry at the tile or at an ancestor
   * down to the pack's node zoom) or null (empty).
   */
  get(layer: string, z: number, x: number, y: number): Uint8Array | "fill" | null {
    const l = this.layers.indexOf(layer);
    if (l < 0) return null;
    const e = this.index.get(key(l, z, x, y));
    if (e) return e[1] ? this.bytes.subarray(e[0], e[0] + e[1]) : "fill";
    for (let a = z - 1; a >= this.node.z; a--) {
      const s = z - a;
      const f = this.index.get(key(l, a, x >> s, y >> s));
      if (f && !f[1]) return "fill";
    }
    return null;
  }

  /** Every entry (tests and tools). */
  *entries(): Generator<PackTile> {
    for (const [k, [off, len]] of this.index) {
      const layer = this.layers[k % 256]!;
      const r = Math.floor(k / 256);
      const z = r % 32, xy = Math.floor(r / 32);
      yield { layer, z, x: xy % 65536, y: Math.floor(xy / 65536), data: len ? this.bytes.subarray(off, off + len) : null };
    }
  }
}

/** One quadtree of packs over a group of layers. */
export interface PackSet {
  layers: string[];
  /** per pack 5 numbers: node z, x, y, zmin, zmax */
  nodes: number[];
  /**
   * per pack: content hash = file name `<hash>.pack` in TilePacks.dir; "" = no file, the node is fill for `fill`
   * across the band (and empty for the other layers)
   */
  files: string[];
  /** layer with fill tiles (basemap: all-land) */
  fill?: string;
}

/** Manifest.packs: where every tile layer of the build lives. */
export interface TilePacks {
  version: number;
  /** directory of the pack files, relative to the build dir (content-addressed names) */
  dir: string;
  /** zoom range per layer as stored (MapLibre overzooms past maxzoom) */
  layers: Record<string, { minzoom: number; maxzoom: number }>;
  sets: PackSet[];
}

export interface PackRef {
  set: PackSet;
  /** index into the set's nodes / files */
  i: number;
  node: PackNode;
  /** "" for a fill-only node */
  file: string;
}

/** Finds the pack that holds a tile. */
export class PackLookup {
  private bySet = new Map<string, { set: PackSet; nodes: Map<number, number[]> }>();
  readonly packs: TilePacks;

  constructor(packs: TilePacks) {
    this.packs = packs;
    for (const set of packs.sets) {
      const nodes = new Map<number, number[]>();
      for (let i = 0; i * 5 < set.nodes.length; i++) {
        const [z, x, y] = set.nodes.slice(i * 5, i * 5 + 3) as [number, number, number];
        const k = key(0, z, x, y);
        const l = nodes.get(k);
        if (l) l.push(i);
        else nodes.set(k, [i]);
      }
      const e = { set, nodes };
      for (const l of set.layers) this.bySet.set(l, e);
    }
  }

  find(layer: string, z: number, x: number, y: number): PackRef | null {
    const e = this.bySet.get(layer);
    if (!e) return null;
    for (let a = z; a >= 0; a--) {
      const s = z - a;
      const list = e.nodes.get(key(0, a, x >> s, y >> s));
      if (!list) continue;
      for (const i of list) {
        const n = e.set.nodes;
        if (n[i * 5 + 3]! <= z && z <= n[i * 5 + 4]!) {
          return { set: e.set, i, node: { z: n[i * 5]!, x: n[i * 5 + 1]!, y: n[i * 5 + 2]!, zmin: n[i * 5 + 3]!, zmax: n[i * 5 + 4]! }, file: e.set.files[i]! };
        }
      }
    }
    return null;
  }
}
