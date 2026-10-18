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
  /** graph edges of the path in order (incl. the partly used edges at both ends) */
  edges: number[];
}

/** Per-query routing options. */
export interface RouteOptions {
  /**
   * Cost multiplier of edge e (≥ 1, so the A* heuristic stays admissible): steers a query onto
   * some track (a feed shape's, lines that trains use) without changing the graph.
   */
  edgeMult?: (e: number) => number;
  /** largest value edgeMult can return (bounds the search; default 1 without edgeMult, else 4) */
  maxMult?: number;
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
  /**
   * Extra cost (m) of reversing at a junction: going from one branch of a fork onto the other one
   * (both leave the node within REVERSAL_DEG of each other). Trains cannot do that without
   * stopping and changing ends, so rail routes set it; 0 (default) allows it freely. It is capped
   * at `reversalShare` × the straight-line distance of the query, so short hops in station areas
   * (terminal tracks, tunnels missing from the graph) still route as before.
   */
  reversalCost?: number;
  reversalShare?: number;
}

/** Two edges leaving a node closer than this angle (deg) are branches of a fork: passing from one to the other is a reversal. */
export const REVERSAL_DEG = 45;
/** Distance (m) along an edge at which its direction at a node is taken. */
const DIR_SAMPLE_M = 150;

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
      reversalCost: opts.reversalCost ?? 0,
      reversalShare: opts.reversalShare ?? 0.5,
    };
    // search states are directed edges: 2e (edge e traversed V → U, i.e. arriving at U) and 2e + 1 (U → V)
    const S = 2 * g.edgeCount;
    this.gScore = new Float64Array(S);
    this.stamp = new Uint32Array(S);
    this.closed = new Uint32Array(S);
    this.prev = new Int32Array(S);
    this.cum = new Float32Array(g.geoX.length);
    for (let e = 0; e < g.edgeCount; e++) {
      let s = 0;
      for (let i = g.geoStart[e]!; i < g.geoStart[e + 1]!; i++) {
        if (i > g.geoStart[e]!) s += haversine(g.geoX[i - 1]! / Q, g.geoY[i - 1]! / Q, g.geoX[i]! / Q, g.geoY[i]! / Q);
        this.cum[i] = s;
      }
    }
    this.dir = this.o.reversalCost > 0 ? edgeDirections(g, this.cum) : null;
  }

  /** unit direction (x, y; local metres) in which edge e leaves its U end (4e, 4e+1) and its V end (4e+2, 4e+3) */
  private dir: Float32Array | null;

  /** Whether passing node n from edge e onto edge f reverses (both leave n in about the same direction). */
  private reverses(e: number, f: number, n: number): boolean {
    const D = this.dir!, g = this.g;
    const ie = 4 * e + (g.edgeU[e] === n ? 0 : 2), jf = 4 * f + (g.edgeU[f] === n ? 0 : 2);
    return D[ie]! * D[jf]! + D[ie + 1]! * D[jf + 1]! > COS_REV;
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
  route(a: LonLat, b: LonLat, maxLen: number, ropts: RouteOptions = {}): RouteResult | null {
    const g = this.g;
    const M = ropts.edgeMult;
    const cost = M ? (e: number) => g.edgeCost[e]! * M(e) : (e: number) => g.edgeCost[e]!;
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
    const rev = this.dir ? Math.min(this.o.reversalCost, this.o.reversalShare * haversine(a[0], a[1], b[0], b[1])) : 0;
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
    const maxCost = (maxLen * 1.6 + 2000) * (M ? ropts.maxMult ?? 4 : 1) + rev;
    /** node a state arrives at */
    const at = (st: number) => (st & 1 ? g.edgeV[st >> 1]! : g.edgeU[st >> 1]!);
    const turn = (e: number, f: number, n: number) => (rev && this.reverses(e, f, n) ? rev : 0);

    let bestCost = Infinity;
    let bestEnd = -1; // state
    let bestTarget: Snap | null = null;
    let direct: { s: Snap; t: Snap } | null = null;

    // same-edge solutions
    for (const s of sa) for (const t of sb) if (s.edge === t.edge) {
      const c = Math.abs(s.f - t.f) * cost(s.edge) + pen * (s.d + t.d);
      if (c < bestCost) { bestCost = c; direct = { s, t }; }
    }
    const relax = (st: number, c: number, prev: number) => {
      if (c > maxCost) return;
      if (ST[st] !== gen || c < G[st]!) {
        ST[st] = gen; G[st] = c; PV[st] = prev;
        H.push(c + h(at(st)), st);
      }
    };
    // a source state is the snap edge itself, left towards U (state 2e) or V (2e + 1)
    sa.forEach((s, i) => {
      const e = s.edge, c = cost(e), base = pen * s.d;
      relax(2 * e, base + s.f * c, -(2 * i + 1) - 1); // encode: source snap i via U
      relax(2 * e + 1, base + (1 - s.f) * c, -(2 * i + 2) - 1);
    });
    // target entry costs per node: from the node along a target snap edge to the snap point
    const tEntry = new Map<number, { c: number; s: Snap }[]>();
    for (const t of sb) {
      const e = t.edge, c = cost(e), base = pen * t.d;
      for (const [n, cc] of [[g.edgeU[e]!, base + t.f * c], [g.edgeV[e]!, base + (1 - t.f) * c]] as const) {
        const l = tEntry.get(n);
        if (l) l.push({ c: cc, s: t }); else tEntry.set(n, [{ c: cc, s: t }]);
      }
    }
    let settled = 0;
    while (H.n > 0) {
      const st = H.pop();
      if (H.top >= bestCost) break;
      if (CL[st] === gen) continue;
      CL[st] = gen;
      settled++;
      const gn = G[st]!;
      const e = st >> 1, n = at(st);
      const tl = tEntry.get(n);
      if (tl) for (const te of tl) {
        if (te.s.edge === e) continue; // back along the edge it came by: a same-edge solution
        const c = gn + te.c + turn(e, te.s.edge, n);
        if (c < bestCost) { bestCost = c; bestEnd = st; bestTarget = te.s; direct = null; }
      }
      for (let k = g.adjStart[n]!; k < g.adjStart[n + 1]!; k++) {
        const f = g.adjEdge[k]!;
        if (f === e) continue;
        const ns = 2 * f + (g.edgeU[f] === n ? 1 : 0);
        if (CL[ns] === gen) continue;
        relax(ns, gn + cost(f) + turn(e, f, n), st);
      }
    }
    this.stats.settled += settled;
    if (bestCost === Infinity) return null;

    let coords: LonLat[];
    let s: Snap, t: Snap;
    let pathEdges: number[];
    if (direct) {
      s = direct.s; t = direct.t;
      pathEdges = [s.edge];
      coords = this.partial(s, t.g + t.t > s.g + s.t ? 'V' : 'U', t);
    } else {
      t = bestTarget!;
      // walk back over the states to the source state (the start snap edge)
      const states: number[] = [];
      let cur = bestEnd;
      let srcCode = 0;
      for (;;) {
        const pv = PV[cur]!;
        if (pv < 0) { srcCode = -pv - 1; break; }
        states.push(cur);
        cur = pv;
      }
      states.reverse();
      const si = (srcCode - 1) >> 1;
      s = sa[si]!;
      pathEdges = [s.edge, ...states.map((x) => x >> 1), t.edge];
      const viaU = srcCode % 2 === 1;
      coords = this.partial(s, viaU ? 'U' : 'V');
      for (const x of states) {
        const e = x >> 1, fwd = (x & 1) === 1;
        const s0 = g.geoStart[e]!, s1 = g.geoStart[e + 1]!;
        if (fwd) for (let i = s0 + 1; i < s1; i++) coords.push([g.geoX[i]! / Q, g.geoY[i]! / Q]);
        else for (let i = s1 - 2; i >= s0; i--) coords.push([g.geoX[i]! / Q, g.geoY[i]! / Q]);
      }
      // from the node reached along the target edge to the target snap point
      const end = at(bestEnd);
      const tail = this.partial(t, g.edgeU[t.edge] === end ? 'U' : 'V');
      tail.reverse();
      for (let i = 1; i < tail.length; i++) coords.push(tail[i]!);
    }
    let length = 0;
    for (let i = 1; i < coords.length; i++) length += haversine(coords[i - 1]![0], coords[i - 1]![1], coords[i]![0], coords[i]![1]);
    if (length > maxLen) return null;
    return { coords, length, snapA: s.d, snapB: t.d, edges: pathEdges };
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

const COS_REV = Math.cos((REVERSAL_DEG * Math.PI) / 180);

/** Unit directions in which every edge leaves its two end nodes (towards a point DIR_SAMPLE_M along it). */
function edgeDirections(g: RailGraph, cum: Float32Array): Float32Array {
  const D = new Float32Array(4 * g.edgeCount);
  for (let e = 0; e < g.edgeCount; e++) {
    const s0 = g.geoStart[e]!, s1 = g.geoStart[e + 1]! - 1;
    const total = cum[s1]!;
    let i = s0 + 1;
    while (i < s1 && cum[i]! < DIR_SAMPLE_M) i++;
    let j = s1 - 1;
    while (j > s0 && total - cum[j]! < DIR_SAMPLE_M) j--;
    put(D, 4 * e, g, s0, i);
    put(D, 4 * e + 2, g, s1, j);
  }
  return D;
}

function put(D: Float32Array, k: number, g: RailGraph, from: number, to: number): void {
  const lat = g.geoY[from]! / Q;
  const { kx, ky } = mPerDeg(lat);
  const dx = ((g.geoX[to]! - g.geoX[from]!) / Q) * kx, dy = ((g.geoY[to]! - g.geoY[from]!) / Q) * ky;
  const l = Math.hypot(dx, dy);
  if (l > 0) { D[k] = dx / l; D[k + 1] = dy / l; }
}
