/**
 * Compact routable rail graph built from polylines (Overture rail segments).
 *
 * Topology comes from shared vertices: Overture segments are OSM-derived and share exact
 * coordinates at connectors / junctions, so a vertex used by more than one line (or a line end)
 * is a junction. Chains of degree-2 nodes are contracted, so the final graph only has real
 * junctions and dead ends; each edge carries its (Douglas-Peucker simplified) geometry.
 * Everything lives in typed arrays (coordinates quantised to 1e-6°).
 */
import { haversine, simplifyIndices } from './geo.ts';

export const Q = 1e6;

class GrowI32 {
  a: Int32Array;
  n = 0;
  constructor(cap = 1024) { this.a = new Int32Array(cap); }
  push(v: number): void {
    if (this.n === this.a.length) { const b = new Int32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  trim(): Int32Array { return this.a.slice(0, this.n); }
}
class GrowF32 {
  a: Float32Array;
  n = 0;
  constructor(cap = 1024) { this.a = new Float32Array(cap); }
  push(v: number): void {
    if (this.n === this.a.length) { const b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  trim(): Float32Array { return this.a.slice(0, this.n); }
}

export interface RailGraph {
  nodeCount: number;
  edgeCount: number;
  /** quantised node coordinates (lon*1e6, lat*1e6) */
  nodeX: Int32Array;
  nodeY: Int32Array;
  edgeU: Int32Array;
  edgeV: Int32Array;
  /** metres */
  edgeLen: Float32Array;
  /** routing cost (≥ minCostRatio × length) */
  edgeCost: Float32Array;
  /** lowest cost/length ratio of any edge (scales the A* heuristic) */
  minCostRatio: number;
  /** geometry of edge e: vertices geoStart[e] .. geoStart[e+1]-1, from U to V */
  geoStart: Int32Array;
  geoX: Int32Array;
  geoY: Int32Array;
  geoEdge: Int32Array;
  adjStart: Int32Array;
  adjEdge: Int32Array;
  comp: Int32Array;
  compSize: Int32Array;
  index: SegmentIndex;
}

/** Uniform grid over edge sub-segments (geometry vertex g → g+1). */
export interface SegmentIndex {
  cell: number; // degrees
  cells: Map<number, number>; // key -> cell number
  cellStart: Int32Array;
  items: Int32Array; // geometry vertex ids
}

const cellKey = (cx: number, cy: number) => (cx + 50000) * 100000 + (cy + 50000);

export class RailGraphBuilder {
  private xs = new GrowI32(1 << 20);
  private ys = new GrowI32(1 << 20);
  private lineStart = new GrowI32(1 << 16);
  private lineMult = new GrowF32(1 << 16);
  // explicit node markers (topology from ids, e.g. Overture connectors): global vertex index + 64-bit key
  private markV = new GrowI32(1 << 16);
  private markHi = new GrowI32(1 << 16);
  private markLo = new GrowI32(1 << 16);
  private lineMarkStart = new GrowI32(1 << 16);
  constructor() { this.lineStart.push(0); this.lineMarkStart.push(0); }

  get lineCount(): number { return this.lineStart.n - 1; }
  get vertexCount(): number { return this.xs.n; }

  /** flat [lon,lat,lon,lat,…]; `mult` is the cost multiplier for this line (cost = length × mult). */
  addLine(flat: ArrayLike<number>, mult = 1, marks?: { idx: ArrayLike<number>; hi: ArrayLike<number>; lo: ArrayLike<number> }): void {
    const n = flat.length >> 1;
    const start = this.xs.n;
    const map = marks ? new Int32Array(n) : null;
    let px = NaN, py = NaN;
    for (let i = 0; i < n; i++) {
      const x = Math.round(flat[2 * i]! * Q), y = Math.round(flat[2 * i + 1]! * Q);
      if (x !== px || y !== py) { this.xs.push(x); this.ys.push(y); px = x; py = y; }
      if (map) map[i] = this.xs.n - 1;
    }
    if (this.xs.n - start < 2) { this.xs.n = start; this.ys.n = start; return; }
    this.lineStart.push(this.xs.n);
    this.lineMult.push(Math.max(0.1, mult));
    if (marks) {
      // node markers in vertex order; line ends always get one (coordinate key if not given)
      const end = this.xs.n - 1;
      let last = -1;
      const push = (v: number, hi: number, lo: number) => {
        if (v === last) return;
        this.markV.push(v); this.markHi.push(hi); this.markLo.push(lo); last = v;
      };
      const k0 = marks.idx.length;
      const first = k0 ? map![marks.idx[0]!]! : -1;
      if (first !== start) push(start, this.xs.a[start]!, this.ys.a[start]! ^ 0x55555555);
      for (let k = 0; k < k0; k++) {
        const v = map![Math.min(n - 1, Math.max(0, marks.idx[k]!))]!;
        if (v > last) push(v, marks.hi[k]!, marks.lo[k]!);
      }
      if (last !== end) push(end, this.xs.a[end]!, this.ys.a[end]! ^ 0x55555555);
    }
    this.lineMarkStart.push(this.markV.n);
  }

  build(opts: { simplifyTol?: number; cellDeg?: number; log?: (s: string) => void } = {}): RailGraph {
    const tol = opts.simplifyTol ?? 15;
    const log = opts.log ?? (() => {});
    const X = this.xs.a, Y = this.ys.a, nv = this.xs.n;
    const LS = this.lineStart.a, nl = this.lineStart.n - 1, LM = this.lineMult.a;

    const pu = new GrowI32(), pv = new GrowI32(), pa = new GrowI32(), pb = new GrowI32();
    const pmult = new GrowF32();
    const n1x = new GrowI32(), n1y = new GrowI32();
    let n1 = 0;
    const keyed = this.markV.n > 0;
    if (keyed) {
      // ---- 1+2 (keyed): stage-1 nodes are the markers, pieces run between consecutive markers
      const MV = this.markV.a, MH = this.markHi.a, ML = this.markLo.a, MS = this.lineMarkStart.a, nm = this.markV.n;
      let cap = 1;
      while (cap < nm * 1.5) cap <<= 1;
      const mask = cap - 1;
      const hx = new Int32Array(cap), hy = new Int32Array(cap), sid = new Int32Array(cap).fill(-1);
      const nodeOf = (m: number): number => {
        const x = MH[m]!, y = ML[m]!;
        let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) & mask;
        while (sid[h] !== -1 && (hx[h] !== x || hy[h] !== y)) h = (h + 1) & mask;
        if (sid[h] === -1) { hx[h] = x; hy[h] = y; sid[h] = n1++; n1x.push(X[MV[m]!]!); n1y.push(Y[MV[m]!]!); }
        return sid[h]!;
      };
      for (let l = 0; l < nl; l++) {
        const m0 = MS[l]!, m1 = MS[l + 1]!;
        let lastId = m1 > m0 ? nodeOf(m0) : -1;
        for (let m = m0 + 1; m < m1; m++) {
          const id = nodeOf(m);
          pu.push(lastId); pv.push(id); pa.push(MV[m - 1]!); pb.push(MV[m]!); pmult.push(LM[l]!);
          lastId = id;
        }
      }
    } else {
      // ---- 1. hash line end points; count incidences (end 1, interior 2). Interior vertices are
      // only looked up, not inserted: a junction always involves some segment's end point
      // (Overture splits at connectors), and this keeps the table small (~2 entries per line).
      let cap = 1;
      while (cap < nl * 2 * 1.5) cap <<= 1;
      const mask = cap - 1;
      const hx = new Int32Array(cap), hy = new Int32Array(cap), hcnt = new Int32Array(cap);
      const slotOf = (x: number, y: number, insert: boolean): number => {
        let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) & mask;
        while (hcnt[h] !== 0 && (hx[h] !== x || hy[h] !== y)) h = (h + 1) & mask;
        if (hcnt[h] === 0) {
          if (!insert) return -1;
          hx[h] = x; hy[h] = y;
        }
        return h;
      };
      for (let l = 0; l < nl; l++) {
        const s = LS[l]!, e = LS[l + 1]! - 1;
        hcnt[slotOf(X[s]!, Y[s]!, true)]!++;
        hcnt[slotOf(X[e]!, Y[e]!, true)]!++;
      }
      for (let l = 0; l < nl; l++) {
        const e = LS[l + 1]! - 1;
        for (let i = LS[l]! + 1; i < e; i++) {
          const h = slotOf(X[i]!, Y[i]!, false);
          if (h >= 0) hcnt[h]! += 2;
        }
      }
      // ---- 2. stage-1 nodes: line ends and junction vertices (incidence != 2)
      const sid = new Int32Array(cap).fill(-1);
      /** stage-1 node id of vertex i of a line [s, e), or -1 */
      const node1 = (i: number, s: number, e: number): number => {
        const end = i === s || i === e - 1;
        const h = slotOf(X[i]!, Y[i]!, false);
        if (h < 0 || (!end && hcnt[h] === 2)) return -1;
        if (sid[h] === -1) { sid[h] = n1++; n1x.push(X[i]!); n1y.push(Y[i]!); }
        return sid[h]!;
      };
      for (let l = 0; l < nl; l++) {
        const s = LS[l]!, e = LS[l + 1]!;
        let last = s, lastId = node1(s, s, e);
        for (let i = s + 1; i < e; i++) {
          const id = node1(i, s, e);
          if (id < 0) continue;
          pu.push(lastId); pv.push(id); pa.push(last); pb.push(i); pmult.push(LM[l]!);
          last = i; lastId = id;
        }
      }
    }
    const np = pu.n;
    const deg1 = new Int32Array(n1 + 1);
    for (let p = 0; p < np; p++) { deg1[pu.a[p]!]!++; deg1[pv.a[p]!]!++; }
    const adj1Start = new Int32Array(n1 + 1);
    for (let i = 0; i < n1; i++) adj1Start[i + 1] = adj1Start[i]! + deg1[i]!;
    const fill = adj1Start.slice(0, n1);
    const adj1 = new Int32Array(2 * np);
    for (let p = 0; p < np; p++) { adj1[fill[pu.a[p]!]!++] = p; adj1[fill[pv.a[p]!]!++] = p; }
    log(`  graph: ${nl} lines, ${nv} vertices, ${n1} stage-1 nodes, ${np} pieces`);

    // ---- 3. contract degree-2 chains
    const isFinal = (n: number) => deg1[n] !== 2;
    const fid = new Int32Array(n1).fill(-1);
    let nf = 0;
    const visited = new Uint8Array(np);
    const eU = new GrowI32(), eV = new GrowI32(), gS = new GrowI32(), gX = new GrowI32(1 << 20), gY = new GrowI32(1 << 20);
    const eLen = new GrowF32(), eCost = new GrowF32();
    const chainX: number[] = [], chainY: number[] = [];
    let flat = new Float64Array(1024);
    // piece boundaries along the current chain: node, chain index, cumulative length / cost
    const bNode: number[] = [], bIdx: number[] = [], bLen: number[] = [], bCost: number[] = [];
    const emit = (u: number, v: number, from: number, to: number, len: number, cost: number) => {
      for (const nn of [u, v]) if (fid[nn] === -1) fid[nn] = nf++;
      eU.push(fid[u]!); eV.push(fid[v]!); eLen.push(len); eCost.push(cost);
      gS.push(gX.n);
      const m = to - from;
      if (flat.length < 2 * m) flat = new Float64Array(4 * m);
      for (let i = 0; i < m; i++) { flat[2 * i] = chainX[from + i]!; flat[2 * i + 1] = chainY[from + i]!; }
      for (const i of simplifyIndices(flat, m, tol, 1 / Q)) { gX.push(chainX[from + i]!); gY.push(chainY[from + i]!); }
    };
    for (let s0 = 0; s0 < n1; s0++) {
      if (!isFinal(s0)) continue;
      for (let k = adj1Start[s0]!; k < adj1Start[s0 + 1]!; k++) {
        const p0 = adj1[k]!;
        if (visited[p0]) continue;
        chainX.length = 0; chainY.length = 0;
        bNode.length = 0; bIdx.length = 0; bLen.length = 0; bCost.length = 0;
        let cur = s0, p = p0, len = 0, cost = 0;
        for (;;) {
          visited[p] = 1;
          const fwd = pu.a[p] === cur;
          const a = pa.a[p]!, b = pb.a[p]!;
          let plen = 0;
          if (fwd) for (let i = a; i <= b; i++) {
            if (i > a) plen += haversine(X[i - 1]! / Q, Y[i - 1]! / Q, X[i]! / Q, Y[i]! / Q);
            if (i > a || chainX.length === 0) { chainX.push(X[i]!); chainY.push(Y[i]!); }
          } else for (let i = b; i >= a; i--) {
            if (i < b) plen += haversine(X[i + 1]! / Q, Y[i + 1]! / Q, X[i]! / Q, Y[i]! / Q);
            if (i < b || chainX.length === 0) { chainX.push(X[i]!); chainY.push(Y[i]!); }
          }
          len += plen; cost += plen * pmult.a[p]!;
          cur = fwd ? pv.a[p]! : pu.a[p]!;
          bNode.push(cur); bIdx.push(chainX.length - 1); bLen.push(len); bCost.push(cost);
          if (isFinal(cur)) break;
          // degree-2 pass-through: take the other piece
          const k0 = adj1Start[cur]!;
          const q = adj1[k0] === p ? adj1[k0 + 1]! : adj1[k0]!;
          if (visited[q]) break; // closed ring through a degree-2 node, shouldn't happen
          p = q;
        }
        if (len < 0.01) continue;
        if (cur !== s0) { emit(s0, cur, 0, chainX.length, len, cost); continue; }
        // a loop back to s0 through degree-2 nodes: split it at the middle boundary node
        if (bNode.length < 2) continue; // single closed piece: useless for routing
        let mid = 0;
        for (let i = 0; i < bNode.length - 1; i++) if (Math.abs(bLen[i]! - len / 2) < Math.abs(bLen[mid]! - len / 2)) mid = i;
        emit(s0, bNode[mid]!, 0, bIdx[mid]! + 1, bLen[mid]!, bCost[mid]!);
        emit(bNode[mid]!, s0, bIdx[mid]!, chainX.length, len - bLen[mid]!, cost - bCost[mid]!);
      }
    }
    gS.push(gX.n);
    const E = eU.n, N = nf;
    const nodeX = new Int32Array(N), nodeY = new Int32Array(N);
    for (let i = 0; i < n1; i++) if (fid[i]! >= 0) { nodeX[fid[i]!] = n1x.a[i]!; nodeY[fid[i]!] = n1y.a[i]!; }
    const g = assemble({
      nodeX, nodeY, edgeU: eU.trim(), edgeV: eV.trim(), edgeLen: eLen.trim(), edgeCost: eCost.trim(),
      geoStart: gS.trim(), geoX: gX.trim(), geoY: gY.trim(),
    }, opts.cellDeg);
    log(`  graph: ${N} nodes, ${E} edges, ${g.geoX.length} geometry vertices, ${g.compSize.length} components`);
    return g;
  }
}

/** Build adjacency, components and the spatial index from the raw edge arrays. */
export function assemble(
  r: Pick<RailGraph, 'nodeX' | 'nodeY' | 'edgeU' | 'edgeV' | 'edgeLen' | 'edgeCost' | 'geoStart' | 'geoX' | 'geoY'>,
  cellDeg = 0.02,
): RailGraph {
  const N = r.nodeX.length, E = r.edgeU.length;
  let minCostRatio = 1;
  for (let e = 0; e < E; e++) if (r.edgeLen[e]! > 1) minCostRatio = Math.min(minCostRatio, r.edgeCost[e]! / r.edgeLen[e]!);
  const adjStart = new Int32Array(N + 1);
  for (let e = 0; e < E; e++) { adjStart[r.edgeU[e]! + 1]!++; adjStart[r.edgeV[e]! + 1]!++; }
  for (let i = 0; i < N; i++) adjStart[i + 1]! += adjStart[i]!;
  const fill = adjStart.slice(0, N);
  const adjEdge = new Int32Array(2 * E);
  for (let e = 0; e < E; e++) { adjEdge[fill[r.edgeU[e]!]!++] = e; adjEdge[fill[r.edgeV[e]!]!++] = e; }
  // components (union-find)
  const parent = new Int32Array(N);
  for (let i = 0; i < N; i++) parent[i] = i;
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; } return x; };
  for (let e = 0; e < E; e++) { const a = find(r.edgeU[e]!), b = find(r.edgeV[e]!); if (a !== b) parent[a] = b; }
  const comp = new Int32Array(N).fill(-1);
  const rootId = new Int32Array(N).fill(-1);
  const sizes: number[] = [];
  for (let i = 0; i < N; i++) {
    const rt = find(i);
    if (rootId[rt] === -1) { rootId[rt] = sizes.length; sizes.push(0); }
    comp[i] = rootId[rt]!;
  }
  // component size in metres of track is more useful than node count
  const compLen = new Float64Array(sizes.length);
  for (let e = 0; e < E; e++) compLen[comp[r.edgeU[e]!]!]! += r.edgeLen[e]!;
  const compSize = Int32Array.from(compLen, (v) => Math.min(2e9, Math.round(v)));
  const geoEdge = new Int32Array(r.geoX.length).fill(-1);
  for (let e = 0; e < E; e++) for (let g = r.geoStart[e]!; g < r.geoStart[e + 1]!; g++) geoEdge[g] = e;
  const index = buildIndex(r.geoStart, r.geoX, r.geoY, E, cellDeg);
  return { ...r, minCostRatio, nodeCount: N, edgeCount: E, adjStart, adjEdge, comp, compSize, geoEdge, index };
}

function buildIndex(geoStart: Int32Array, gx: Int32Array, gy: Int32Array, E: number, cell: number): SegmentIndex {
  const cq = cell * Q;
  const cells = new Map<number, number>();
  const counts: number[] = [];
  const visit = (cb: (c: number, g: number) => void) => {
    for (let e = 0; e < E; e++) {
      for (let g = geoStart[e]!; g < geoStart[e + 1]! - 1; g++) {
        const x0 = Math.floor(Math.min(gx[g]!, gx[g + 1]!) / cq), x1 = Math.floor(Math.max(gx[g]!, gx[g + 1]!) / cq);
        const y0 = Math.floor(Math.min(gy[g]!, gy[g + 1]!) / cq), y1 = Math.floor(Math.max(gy[g]!, gy[g + 1]!) / cq);
        for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
          const k = cellKey(cx, cy);
          let c = cells.get(k);
          if (c === undefined) { c = counts.length; cells.set(k, c); counts.push(0); }
          cb(c, g);
        }
      }
    }
  };
  visit((c) => { counts[c]!++; });
  const cellStart = new Int32Array(counts.length + 1);
  for (let i = 0; i < counts.length; i++) cellStart[i + 1] = cellStart[i]! + counts[i]!;
  const fill = cellStart.slice(0, counts.length);
  const items = new Int32Array(cellStart[counts.length]!);
  visit((c, g) => { items[fill[c]!++] = g; });
  return { cell, cells, cellStart, items };
}

/** Geometry vertex ids of sub-segments whose cells intersect the box around (lon,lat) ± r metres. */
export function querySegments(g: RailGraph, lon: number, lat: number, r: number, out: Set<number>): void {
  const { cell, cells, cellStart, items } = g.index;
  const dLat = r / 111195, dLon = r / (111195 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  const x0 = Math.floor((lon - dLon) / cell), x1 = Math.floor((lon + dLon) / cell);
  const y0 = Math.floor((lat - dLat) / cell), y1 = Math.floor((lat + dLat) / cell);
  for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
    const c = cells.get(cellKey(cx, cy));
    if (c === undefined) continue;
    for (let i = cellStart[c]!; i < cellStart[c + 1]!; i++) out.add(items[i]!);
  }
}

export function graphBytes(g: RailGraph): number {
  let b = 0;
  for (const v of Object.values(g)) if (ArrayBuffer.isView(v)) b += v.byteLength;
  b += g.index.cellStart.byteLength + g.index.items.byteLength + g.index.cells.size * 40;
  return b;
}
