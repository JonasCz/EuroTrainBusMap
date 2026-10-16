/**
 * Compact binary serialisation of a routing graph (rail graph file / road graph file;
 * header.kind tells which).
 *
 * Layout (little endian):
 *   bytes 0..7    magic "ETBMRAIL"
 *   bytes 8..11   uint32 header length H
 *   bytes 12..    UTF-8 JSON header (RailBinHeader), H bytes — readable without decompressing
 *   then          payload compressed with header.compression ('zstd' | 'gzip'): the sections
 *                 listed in header.sections, concatenated in that order (each 4-byte aligned).
 *
 * Sections (format 1):
 *   edgeU, edgeV       int32[E]   node ids
 *   edgeLen            float32[E] metres (unsimplified track length)
 *   edgeCost           float32[E] routing cost (length × class/usage multiplier)
 *   geoCount           int32[E]   number of geometry vertices of each edge (≥ 2)
 *   geoDX, geoDY       int32[G]   vertex coordinates in 1e-6°, delta-coded over the whole
 *                                 array (first vertex absolute); vertex 0 / last of each edge
 *                                 are the edge's U / V node, so node coordinates are derived.
 * Unknown sections are ignored; a missing required section is an error.
 */
import { gunzipSync, gzipSync, constants as zc } from 'node:zlib';
import * as zlib from 'node:zlib';
import { assemble, type RailGraph } from './graph.ts';

export const RAIL_FORMAT = 1;
/** The same format stores the rail graph and the major-road graph. */
export type GraphKind = 'rail' | 'road' | 'urbanrail';
const MAGIC = 'ETBMRAIL';

export interface RailBinHeader {
  format: number;
  /** 'rail' | 'road' (absent in early rail files = rail) */
  kind?: GraphKind;
  /** Overture release the graph was built from */
  release: string;
  /** [xmin, ymin, xmax, ymax] of the extraction */
  bbox: readonly number[];
  created: string;
  compression: 'zstd' | 'gzip';
  nodeCount: number;
  edgeCount: number;
  geoCount: number;
  /** Douglas-Peucker tolerance (m) used for edge geometry */
  simplifyTol: number;
  /** components with less track than this (m) were dropped */
  minComponent: number;
  sections: { name: string; type: 'i32' | 'f32'; length: number }[];
  [k: string]: unknown;
}

/** Drop components with less than `minTrack` metres of track; renumber nodes. */
export function pruneGraph(g: RailGraph, minTrack: number): RailGraph {
  const keepE: number[] = [];
  for (let e = 0; e < g.edgeCount; e++) if (g.compSize[g.comp[g.edgeU[e]!]!]! >= minTrack) keepE.push(e);
  const remap = new Int32Array(g.nodeCount).fill(-1);
  let n = 0;
  for (const e of keepE) for (const v of [g.edgeU[e]!, g.edgeV[e]!]) if (remap[v] === -1) remap[v] = n++;
  const E = keepE.length;
  const edgeU = new Int32Array(E), edgeV = new Int32Array(E), edgeLen = new Float32Array(E), edgeCost = new Float32Array(E);
  const geoStart = new Int32Array(E + 1);
  let G = 0;
  keepE.forEach((e, i) => { G += g.geoStart[e + 1]! - g.geoStart[e]!; });
  const geoX = new Int32Array(G), geoY = new Int32Array(G);
  let k = 0;
  keepE.forEach((e, i) => {
    edgeU[i] = remap[g.edgeU[e]!]!; edgeV[i] = remap[g.edgeV[e]!]!;
    edgeLen[i] = g.edgeLen[e]!; edgeCost[i] = g.edgeCost[e]!;
    geoStart[i] = k;
    for (let j = g.geoStart[e]!; j < g.geoStart[e + 1]!; j++) { geoX[k] = g.geoX[j]!; geoY[k] = g.geoY[j]!; k++; }
  });
  geoStart[E] = k;
  const nodeX = new Int32Array(n), nodeY = new Int32Array(n);
  for (let v = 0; v < g.nodeCount; v++) if (remap[v]! >= 0) { nodeX[remap[v]!] = g.nodeX[v]!; nodeY[remap[v]!] = g.nodeY[v]!; }
  return assemble({ nodeX, nodeY, edgeU, edgeV, edgeLen, edgeCost, geoStart, geoX, geoY }, g.index.cell);
}

const hasZstd = typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === 'function';

export function serializeRailGraph(
  g: RailGraph,
  meta: { kind?: GraphKind; release: string; bbox: readonly number[]; simplifyTol: number; minComponent: number },
): Buffer {
  const E = g.edgeCount, G = g.geoX.length;
  const geoCount = new Int32Array(E);
  for (let e = 0; e < E; e++) geoCount[e] = g.geoStart[e + 1]! - g.geoStart[e]!;
  const dx = new Int32Array(G), dy = new Int32Array(G);
  for (let i = 0; i < G; i++) {
    dx[i] = g.geoX[i]! - (i ? g.geoX[i - 1]! : 0);
    dy[i] = g.geoY[i]! - (i ? g.geoY[i - 1]! : 0);
  }
  const secs: [string, Int32Array | Float32Array][] = [
    ['edgeU', g.edgeU], ['edgeV', g.edgeV], ['edgeLen', g.edgeLen], ['edgeCost', g.edgeCost],
    ['geoCount', geoCount], ['geoDX', dx], ['geoDY', dy],
  ];
  const payload = Buffer.concat(secs.map(([, a]) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
  const compression = hasZstd ? 'zstd' : 'gzip';
  const z = hasZstd
    ? (zlib as unknown as { zstdCompressSync: (b: Buffer, o: object) => Buffer }).zstdCompressSync(payload, {
        params: { [(zc as Record<string, number>).ZSTD_c_compressionLevel!]: 19 },
      })
    : gzipSync(payload, { level: 9 });
  const header: RailBinHeader = {
    format: RAIL_FORMAT, kind: meta.kind ?? 'rail', release: meta.release, bbox: meta.bbox, created: new Date().toISOString(), compression,
    nodeCount: g.nodeCount, edgeCount: E, geoCount: G, simplifyTol: meta.simplifyTol, minComponent: meta.minComponent,
    sections: secs.map(([name, a]) => ({ name, type: a instanceof Float32Array ? 'f32' : 'i32', length: a.length })),
  };
  const hb = Buffer.from(JSON.stringify(header), 'utf8');
  const pre = Buffer.alloc(12);
  pre.write(MAGIC, 0, 'latin1');
  pre.writeUInt32LE(hb.length, 8);
  return Buffer.concat([pre, hb, z]);
}

export function readRailHeader(buf: Buffer): { header: RailBinHeader; offset: number } {
  if (buf.length < 12 || buf.toString('latin1', 0, 8) !== MAGIC) throw new Error('not a rail graph file (bad magic)');
  const hl = buf.readUInt32LE(8);
  const header = JSON.parse(buf.toString('utf8', 12, 12 + hl)) as RailBinHeader;
  return { header, offset: 12 + hl };
}

export function deserializeRailGraph(buf: Buffer, cellDeg?: number): { graph: RailGraph; header: RailBinHeader } {
  const { header, offset } = readRailHeader(buf);
  if (header.format !== RAIL_FORMAT) throw new Error(`rail graph format ${header.format}, expected ${RAIL_FORMAT}`);
  const z = buf.subarray(offset);
  let raw: Buffer;
  if (header.compression === 'zstd') {
    const dec = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
    if (!dec) throw new Error('rail graph is zstd-compressed but this Node has no zstd (need Node ≥ 22.15)');
    raw = dec(z);
  } else raw = gunzipSync(z);
  const secs = new Map<string, Int32Array | Float32Array>();
  let off = 0;
  for (const s of header.sections) {
    const bytes = s.length * 4;
    const copy = new ArrayBuffer(bytes);
    new Uint8Array(copy).set(raw.subarray(off, off + bytes));
    secs.set(s.name, s.type === 'f32' ? new Float32Array(copy) : new Int32Array(copy));
    off += bytes;
  }
  const need = <T extends Int32Array | Float32Array>(n: string): T => {
    const a = secs.get(n);
    if (!a) throw new Error(`rail graph file lacks section ${n}`);
    return a as T;
  };
  const edgeU = need<Int32Array>('edgeU'), edgeV = need<Int32Array>('edgeV');
  const edgeLen = need<Float32Array>('edgeLen'), edgeCost = need<Float32Array>('edgeCost');
  const geoCount = need<Int32Array>('geoCount'), dx = need<Int32Array>('geoDX'), dy = need<Int32Array>('geoDY');
  const E = edgeU.length, G = dx.length;
  const geoStart = new Int32Array(E + 1);
  for (let e = 0; e < E; e++) geoStart[e + 1] = geoStart[e]! + geoCount[e]!;
  if (geoStart[E] !== G) throw new Error('rail graph file: geometry counts do not match');
  const geoX = dx, geoY = dy; // undo delta coding in place
  for (let i = 1; i < G; i++) { geoX[i]! += geoX[i - 1]!; geoY[i]! += geoY[i - 1]!; }
  const N = header.nodeCount;
  const nodeX = new Int32Array(N), nodeY = new Int32Array(N);
  for (let e = 0; e < E; e++) {
    const a = geoStart[e]!, b = geoStart[e + 1]! - 1;
    nodeX[edgeU[e]!] = geoX[a]!; nodeY[edgeU[e]!] = geoY[a]!;
    nodeX[edgeV[e]!] = geoX[b]!; nodeY[edgeV[e]!] = geoY[b]!;
  }
  return { graph: assemble({ nodeX, nodeY, edgeU, edgeV, edgeLen, edgeCost, geoStart, geoX, geoY }, cellDeg), header };
}
