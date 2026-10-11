/** Station snapping + A* routing on a RailGraph. */
import { Q, querySegments, type RailGraph } from './graph.ts';
import { haversine, mPerDeg, type LonLat } from './geo.ts';

export interface Snap {
  edge: number;
  /** geometry vertex where the sub-segment starts */
  g: number;
  /** fraction along that sub-segment */
  t: number;
  /** distance station → track (m) */
  d: number;
  /** projected point */
  lon: number;
  lat: number;
  /** fraction of the edge (by geometry length) from U to the snap point */
  f: number;
}

export interface RouteResult {
  coords: LonLat[];
  /** metres along the track (snap point to snap point) */
  length: number;
  /** snap distances (m) */
  snapA: number;
  snapB: number;
}

export interface RouterOptions {
  /** max station → track distance (m) */
  snapRadius?: number;
  /** extra candidates within best + this (m) */
  snapSlack?: number;
  maxCandidates?: number;
  /** cost per metre of snap distance */
  snapPenalty?: number;
  /** components with less track than this (m) are ignored when snapping */
  minComponent?: number;
}

/** Binary min-heap of (key, value) on typed arrays. */
class Heap {
  k = new Float64Array(1 << 16);
  v = new Int32Array(1 << 16);
  n = 0;
  clear() { this.n = 0; }
  push(key: number, val: number) {
    if (this.n === this.k.length) {
      const k2 = new Float64Array(this.n * 2); k2.set(this.k); this.k = k2;
      const v2 = new Int32Array(this.n * 2); v2.set(this.v); this.v = v2;
    }
    let i = this.n++;
    const K = this.k, V = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p]! <= key) break;
      K[i] = K[p]!; V[i] = V[p]!; i = p;
    }
    K[i] = key; V[i] = val;
  }
  /** pops min, returns value; key in this.top */
  top = 0;
  pop(): number {
    const K = this.k, V = this.v;
    const rk = K[0]!, rv = V[0]!;
    const n = --this.n;
    if (n > 0) {
      const key = K[n]!, val = V[n]!;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1]! < K[c]!) c++;
        if (K[c]! >= key) break;
        K[i] = K[c]!; V[i] = V[c]!; i = c;
      }
      K[i] = key; V[i] = val;
    }
    this.top = rk;
    return rv;
  }
}

export class Router {
  readonly g: RailGraph;
  private o: Required<RouterOptions>;
  private gScore: Float64Array;
  private stamp: Uint32Array;
  private closed: Uint32Array;
  private prev: Int32Array;
  private gen = 0;
  private heap = new Heap();
  /** cumulative geometry length per vertex within its edge (m) */
  private cum: Float32Array;
  stats = { queries: 0, settled: 0 };

  constructor(g: RailGraph, opts: RouterOptions = {}) {
    this.g = g;
    this.o = {
      snapRadius: opts.snapRadius ?? 1500,
      snapSlack: opts.snapSlack ?? 250,
      maxCandidates: opts.maxCandidates ?? 8,
      snapPenalty: opts.snapPenalty ?? 2,
      minComponent: opts.minComponent ?? 3000,
    };
    const N = g.nodeCount;
    this.gScore = new Float64Array(N);
    this.stamp = new Uint32Array(N);
    this.closed = new Uint32Array(N);
    this.prev = new Int32Array(N);
    this.cum = new Float32Array(g.geoX.length);
    for (let e = 0; e < g.edgeCount; e++) {
      let s = 0;
      for (let i = g.geoStart[e]!; i < g.geoStart[e + 1]!; i++) {
        if (i > g.geoStart[e]!) s += haversine(g.geoX[i - 1]! / Q, g.geoY[i - 1]! / Q, g.geoX[i]! / Q, g.geoY[i]! / Q);
        this.cum[i] = s;
      }
    }
  }

  /** Candidate track positions near a point, best first (one per edge). */
  snap(p: LonLat, radius = this.o.snapRadius): Snap[] {
    const g = this.g;
    const ids = new Set<number>();
    querySegments(g, p[0], p[1], radius, ids);
    const { kx, ky } = mPerDeg(p[1]);
    const best = new Map<number, Snap>();
    for (const gi of ids) {
      const e = g.geoEdge[gi]!;
      if (g.compSize[g.comp[g.edgeU[e]!]!]! < this.o.minComponent) continue;
      const ax = (g.geoX[gi]! / Q - p[0]) * kx, ay = (g.geoY[gi]! / Q - p[1]) * ky;
      const bx = (g.geoX[gi + 1]! / Q - p[0]) * kx, by = (g.geoY[gi + 1]! / Q - p[1]) * ky;
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d > radius) continue;
      const cur = best.get(e);
      if (cur && cur.d <= d) continue;
      const s0 = g.geoStart[e]!, s1 = g.geoStart[e + 1]! - 1;
      const total = this.cum[s1]! || 1;
      const along = this.cum[gi]! + t * (this.cum[gi + 1]! - this.cum[gi]!);
      best.set(e, {
        edge: e, g: gi, t, d,
        lon: (g.geoX[gi]! + t * (g.geoX[gi + 1]! - g.geoX[gi]!)) / Q,
        lat: (g.geoY[gi]! + t * (g.geoY[gi + 1]! - g.geoY[gi]!)) / Q,
        f: s1 > s0 ? along / total : 0,
      });
    }
    const all = [...best.values()].sort((a, b) => a.d - b.d);
    if (!all.length) return all;
    const lim = all[0]!.d + this.o.snapSlack;
    return all.filter((s) => s.d <= lim).slice(0, this.o.maxCandidates);
  }

  /**
   * Shortest path between two points. `maxLen` bounds the track length (search is pruned
   * beyond it). Returns null when nothing is found within the bound.
   */
  route(a: LonLat, b: LonLat, maxLen: number): RouteResult | null {
    const g = this.g;
    this.stats.queries++;
    let sa = this.snap(a), sb = this.snap(b);
    if (!sa.length || !sb.length) return null;
    // keep only components present on both sides
    const compsB = new Set(sb.map((s) => g.comp[g.edgeU[s.edge]!]!));
    sa = sa.filter((s) => compsB.has(g.comp[g.edgeU[s.edge]!]!));
    const compsA = new Set(sa.map((s) => g.comp[g.edgeU[s.edge]!]!));
    sb = sb.filter((s) => compsA.has(g.comp[g.edgeU[s.edge]!]!));
    if (!sa.length || !sb.length) return null;

    const pen = this.o.snapPenalty;
    const gen = ++this.gen;
    const G = this.gScore, ST = this.stamp, CL = this.closed, PV = this.prev, H = this.heap;
    H.clear();
    const tx = b[0], ty = b[1];
    const { kx, ky } = mPerDeg((a[1] + b[1]) / 2);
    // keep the heuristic admissible: cheapest cost per metre, and a margin for the projection
    const hs = 0.97 * Math.min(1, g.minCostRatio);
    const kxs = kx * hs, kys = ky * hs;
    const maxSnapB = Math.max(...sb.map((s) => s.d));
    const h = (n: number) => {
      const dx = (g.nodeX[n]! / Q - tx) * kxs, dy = (g.nodeY[n]! / Q - ty) * kys;
      return Math.max(0, Math.sqrt(dx * dx + dy * dy) - maxSnapB * hs);
    };
    const maxCost = maxLen * 1.6 + 2000;

    let bestCost = Infinity;
    let bestEnd = -1; // node
    let bestTarget: Snap | null = null;
    let direct: { s: Snap; t: Snap } | null = null;

    // same-edge solutions
    for (const s of sa) for (const t of sb) if (s.edge === t.edge) {
      const c = Math.abs(s.f - t.f) * g.edgeCost[s.edge]! + pen * (s.d + t.d);
      if (c < bestCost) { bestCost = c; direct = { s, t }; }
    }
    const relax = (n: number, c: number, pe: number) => {
      if (c > maxCost) return;
      if (ST[n] !== gen || c < G[n]!) {
        ST[n] = gen; G[n] = c; PV[n] = pe;
        H.push(c + h(n), n);
      }
    };
    sa.forEach((s, i) => {
      const e = s.edge, c = g.edgeCost[e]!, base = pen * s.d;
      relax(g.edgeU[e]!, base + s.f * c, -(2 * i + 1) - 1); // encode: source snap i via U
      relax(g.edgeV[e]!, base + (1 - s.f) * c, -(2 * i + 2) - 1);
    });
    // target entry costs
    const tEntry = new Map<number, { c: number; s: Snap }>();
    for (const t of sb) {
      const e = t.edge, c = g.edgeCost[e]!, base = pen * t.d;
      for (const [n, cc] of [[g.edgeU[e]!, base + t.f * c], [g.edgeV[e]!, base + (1 - t.f) * c]] as const) {
        const cur = tEntry.get(n);
        if (!cur || cc < cur.c) tEntry.set(n, { c: cc, s: t });
      }
    }
    let settled = 0;
    while (H.n > 0) {
      const n = H.pop();
      if (H.top >= bestCost) break;
      if (CL[n] === gen) continue;
      CL[n] = gen;
      settled++;
      const gn = G[n]!;
      const te = tEntry.get(n);
      if (te && gn + te.c < bestCost) { bestCost = gn + te.c; bestEnd = n; bestTarget = te.s; direct = null; }
      for (let k = g.adjStart[n]!; k < g.adjStart[n + 1]!; k++) {
        const e = g.adjEdge[k]!;
        const m = g.edgeU[e] === n ? g.edgeV[e]! : g.edgeU[e]!;
        if (CL[m] === gen) continue;
        relax(m, gn + g.edgeCost[e]!, e);
      }
    }
    this.stats.settled += settled;
    if (bestCost === Infinity) return null;

    let coords: LonLat[];
    let s: Snap, t: Snap;
    if (direct) {
      s = direct.s; t = direct.t;
      coords = this.partial(s, t.g + t.t > s.g + s.t ? 'V' : 'U', t);
    } else {
      t = bestTarget!;
      // walk back
      const edges: number[] = [];
      const nodes: number[] = [bestEnd];
      let n = bestEnd;
      let srcCode = 0;
      for (;;) {
        const pe = PV[n]!;
        if (pe < 0) { srcCode = -pe - 1; break; }
        edges.push(pe);
        n = g.edgeU[pe] === n ? g.edgeV[pe]! : g.edgeU[pe]!;
        nodes.push(n);
      }
      edges.reverse(); nodes.reverse();
      const si = (srcCode - 1) >> 1;
      s = sa[si]!;
      const viaU = srcCode % 2 === 1;
      coords = this.partial(s, viaU ? 'U' : 'V');
      let at = nodes[0]!;
      for (const e of edges) {
        const fwd = g.edgeU[e] === at;
        const s0 = g.geoStart[e]!, s1 = g.geoStart[e + 1]!;
        if (fwd) for (let i = s0 + 1; i < s1; i++) coords.push([g.geoX[i]! / Q, g.geoY[i]! / Q]);
        else for (let i = s1 - 2; i >= s0; i--) coords.push([g.geoX[i]! / Q, g.geoY[i]! / Q]);
        at = fwd ? g.edgeV[e]! : g.edgeU[e]!;
      }
      // from node `at` along target edge to the target snap point
      const tail = this.partial(t, g.edgeU[t.edge] === at ? 'U' : 'V');
      tail.reverse();
      for (let i = 1; i < tail.length; i++) coords.push(tail[i]!);
    }
    let length = 0;
    for (let i = 1; i < coords.length; i++) length += haversine(coords[i - 1]![0], coords[i - 1]![1], coords[i]![0], coords[i]![1]);
    if (length > maxLen) return null;
    return { coords, length, snapA: s.d, snapB: t.d };
  }

  /** Coordinates from snap point s along its edge to end 'U' or 'V' (or to snap point `to` on the same edge). */
  private partial(s: Snap, end: 'U' | 'V', to?: Snap): LonLat[] {
    const g = this.g;
    const out: LonLat[] = [[s.lon, s.lat]];
    const e = s.edge, s0 = g.geoStart[e]!, s1 = g.geoStart[e + 1]! - 1;
    if (end === 'V') {
      const stop = to ? to.g : s1;
      for (let i = s.g + 1; i <= stop; i++) out.push([g.geoX[i]! / Q, g.geoY[i]! / Q]);
    } else {
      const stop = to ? to.g + 1 : s0;
      for (let i = s.g; i >= stop; i--) out.push([g.geoX[i]! / Q, g.geoY[i]! / Q]);
    }
    if (to) out.push([to.lon, to.lat]);
    return out;
  }
}
