/**
 * Steering rail routes onto the track trains really use.
 *
 * The rail graph only knows track length (and a few name-based cost tweaks), so a hop without
 * intermediate stops is drawn on the shortest path, which is often a slow branch line (Praha → Brno
 * across the Sázava branch instead of the main line via Pardubice and Česká Třebová). Two signals
 * fix that without changing the graph:
 *
 * - **feed shapes**: a shape that lies on the track is the real path. The route is then searched with
 *   edges away from the shape made expensive (`shapeEdgeMult`), so the line follows the shape
 *   but keeps the exact track geometry of the graph.
 * - **track usage**: the trains per day of all other routed hops on each graph edge (`TrackUsage`).
 *   Hops with stops close together are well constrained, so their paths mark the lines in
 *   passenger use; long non-stop hops are then routed with lightly used track made more
 *   expensive (`usageMult`), so they stay on the busy main line.
 */
import { Q, querySegments, type RailGraph } from './graph.ts';
import { dist, mPerDeg, type LonLat } from './geo.ts';

/** Points every `step` metres along a polyline (first and last point included). */
export function resample(c: readonly LonLat[], step: number): LonLat[] {
  if (c.length < 2) return c.slice();
  const out: LonLat[] = [c[0]!];
  let cum = 0, next = step; // distance along the line so far / of the next sample
  for (let i = 1; i < c.length; i++) {
    const p = c[i - 1]!, q = c[i]!;
    const l = dist(p, q);
    while (next < cum + l) {
      const t = (next - cum) / l;
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      next += step;
    }
    cum += l;
  }
  const last = c[c.length - 1]!;
  if (dist(out[out.length - 1]!, last) > 1) out.push(last);
  return out;
}

/** Distance (m) from p to the graph sub-segment starting at geometry vertex gi. */
function segDist(g: RailGraph, gi: number, p: LonLat, kx: number, ky: number): number {
  const ax = (g.geoX[gi]! / Q - p[0]) * kx, ay = (g.geoY[gi]! / Q - p[1]) * ky;
  const bx = (g.geoX[gi + 1]! / Q - p[0]) * kx, by = (g.geoY[gi + 1]! / Q - p[1]) * ky;
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Whether a geometry vertex starts a sub-segment of its edge (not the last vertex of the edge). */
const isSeg = (g: RailGraph, gi: number) => gi + 1 < g.geoStart[g.geoEdge[gi]! + 1]!;

/**
 * Fraction of a polyline (sampled every `step` m) within `tol` m of track. Feed shapes drawn on
 * the track give ~1; shapes that are stop-to-stop chords or hand-drawn curves give much less.
 */
export function onTrack(g: RailGraph, line: readonly LonLat[], tol = 150, step = 500): number {
  const pts = resample(line, step);
  if (!pts.length) return 0;
  const ids = new Set<number>();
  let hit = 0;
  for (const p of pts) {
    ids.clear();
    querySegments(g, p[0], p[1], tol, ids);
    const { kx, ky } = mPerDeg(p[1]);
    for (const gi of ids) if (isSeg(g, gi) && segDist(g, gi, p, kx, ky) <= tol) { hit++; break; }
  }
  return hit / pts.length;
}

/** Cost multiplier of graph edges that do not follow a guiding shape. */
export const OFF_SHAPE_MULT = 4;

/**
 * Edge cost multipliers that keep a route on a shape: 1 for edges whose geometry lies within
 * `radius` of the shape, up to OFF_SHAPE_MULT for edges entirely away from it (by the fraction of
 * the edge's length near the shape, so a branch that only touches the shape at a junction stays
 * expensive).
 */
export function shapeEdgeMult(g: RailGraph, shape: readonly LonLat[], radius = 250): (e: number) => number {
  // length of each edge along the shape: every shape sample near an edge stands for `step` metres of it
  const step = Math.max(50, radius / 2);
  const nearLen = new Map<number, number>();
  const ids = new Set<number>();
  const seen = new Set<number>();
  for (const p of resample(shape, step)) {
    ids.clear();
    seen.clear();
    querySegments(g, p[0], p[1], radius, ids);
    const { kx, ky } = mPerDeg(p[1]);
    for (const gi of ids) {
      const e = g.geoEdge[gi]!;
      if (seen.has(e) || !isSeg(g, gi) || segDist(g, gi, p, kx, ky) > radius) continue;
      seen.add(e);
      nearLen.set(e, (nearLen.get(e) ?? 0) + step);
    }
  }
  const mult = new Map<number, number>();
  for (const [e, l] of nearLen) {
    const f = Math.min(1, l / Math.max(1, g.edgeLen[e]!));
    mult.set(e, OFF_SHAPE_MULT - (OFF_SHAPE_MULT - 1) * f);
  }
  return (e) => mult.get(e) ?? OFF_SHAPE_MULT;
}

/** Fraction of polyline a (sampled every `step` m) within `tol` m of polyline b. */
export function coverage(a: readonly LonLat[], b: readonly LonLat[], tol = 300, step = 200): number {
  const pts = resample(a, step);
  if (!pts.length || b.length < 2) return 0;
  // grid over b's segments
  const cell = (tol * 4) / 111195;
  const grid = new Map<string, number[]>();
  for (let i = 0; i + 1 < b.length; i++) {
    const x0 = Math.floor(Math.min(b[i]![0], b[i + 1]![0]) / cell), x1 = Math.floor(Math.max(b[i]![0], b[i + 1]![0]) / cell);
    const y0 = Math.floor(Math.min(b[i]![1], b[i + 1]![1]) / cell), y1 = Math.floor(Math.max(b[i]![1], b[i + 1]![1]) / cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) continue; // degenerate long segment: checked below by brute force
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = `${x},${y}`;
      const l = grid.get(k);
      if (l) l.push(i); else grid.set(k, [i]);
    }
  }
  const long: number[] = [];
  for (let i = 0; i + 1 < b.length; i++) {
    const nx = Math.abs(Math.floor(b[i]![0] / cell) - Math.floor(b[i + 1]![0] / cell)) + 1;
    const ny = Math.abs(Math.floor(b[i]![1] / cell) - Math.floor(b[i + 1]![1] / cell)) + 1;
    if (nx * ny > 400) long.push(i);
  }
  let hit = 0;
  for (const p of pts) {
    const { kx, ky } = mPerDeg(p[1]);
    const dLon = tol / kx, dLat = tol / ky;
    const cand = new Set<number>(long);
    for (let x = Math.floor((p[0] - dLon) / cell); x <= Math.floor((p[0] + dLon) / cell); x++)
      for (let y = Math.floor((p[1] - dLat) / cell); y <= Math.floor((p[1] + dLat) / cell); y++)
        for (const i of grid.get(`${x},${y}`) ?? []) cand.add(i);
    for (const i of cand) {
      const ax = (b[i]![0] - p[0]) * kx, ay = (b[i]![1] - p[1]) * ky;
      const dx = (b[i + 1]![0] - b[i]![0]) * kx, dy = (b[i + 1]![1] - b[i]![1]) * ky;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (Math.hypot(ax + t * dx, ay + t * dy) <= tol) { hit++; break; }
    }
  }
  return hit / pts.length;
}

/** Trains per day at which track counts as fully used (no usage penalty). */
export const USAGE_FULL_TPD = 1000;
/** Cost multiplier of track that no routed hop uses. */
export const USAGE_MAX_MULT = 2;
/** Weight of regional trains in the usage seen by a long-distance hop. */
export const USAGE_REGIONAL_WEIGHT = 0.25;
/** Hops shorter than this (m) are not re-routed by usage: their stops leave little choice. */
export const USAGE_MIN_HOP = 25000;

/**
 * Cost multiplier from the trains per day on an edge: 2 for unused track, falling
 * logarithmically to 1 at USAGE_FULL_TPD (≈1.6 at 15/day, ≈1.27 at 150/day).
 */
export function usageMult(tpd: number): number {
  if (!(tpd > 0)) return USAGE_MAX_MULT;
  const f = Math.log1p(tpd) / Math.log1p(USAGE_FULL_TPD);
  return f >= 1 ? 1 : 1 + (USAGE_MAX_MULT - 1) * (1 - f);
}

/**
 * How much a routed hop says about the track it uses: hops with stops close together leave the
 * router little choice, long non-stop hops are guesses. 1 up to `ref` m, then ref / gc.
 */
export const usageConfidence = (gc: number, ref = 60000): number => (gc <= ref ? 1 : ref / gc);

/**
 * Trains per day per graph edge (long-distance and regional separately), summed over routed hops.
 * OSM maps double track as two ways, and hops pick either, so `spread` gives an edge the usage
 * of a used edge that runs alongside it for most of its length.
 */
export class TrackUsage {
  readonly long: Float32Array;
  readonly reg: Float32Array;
  constructor(readonly g: RailGraph) {
    this.long = new Float32Array(g.edgeCount);
    this.reg = new Float32Array(g.edgeCount);
  }

  add(edges: ArrayLike<number>, long: number, reg: number): void {
    for (const e of new Set(Array.from(edges))) {
      if (long > 0) this.long[e]! += long;
      if (reg > 0) this.reg[e]! += reg;
    }
  }

  /**
   * Copy usage onto parallel track: an edge running within `tol` m of a more used edge along at
   * least half of its length gets that edge's usage (per category, the larger value).
   */
  spread(tol = 40, step = 100): void {
    const g = this.g, L = this.long, R = this.reg;
    const L2 = L.slice(), R2 = R.slice();
    const ids = new Set<number>();
    const seen = new Set<number>();
    const hits = new Map<number, number>(); // edge f → samples of the used edge e near f
    const line: LonLat[] = [];
    for (let e = 0; e < g.edgeCount; e++) {
      if (!(L[e]! > 0 || R[e]! > 0)) continue;
      line.length = 0;
      for (let i = g.geoStart[e]!; i < g.geoStart[e + 1]!; i++) line.push([g.geoX[i]! / Q, g.geoY[i]! / Q]);
      hits.clear();
      for (const p of resample(line, step)) {
        ids.clear();
        seen.clear();
        querySegments(g, p[0], p[1], tol, ids);
        const { kx, ky } = mPerDeg(p[1]);
        for (const gi of ids) {
          const f = g.geoEdge[gi]!;
          if (f === e || seen.has(f) || !isSeg(g, gi) || segDist(g, gi, p, kx, ky) > tol) continue;
          seen.add(f);
          hits.set(f, (hits.get(f) ?? 0) + 1);
        }
      }
      for (const [f, n] of hits) {
        if (n * step < 0.5 * g.edgeLen[f]!) continue;
        if (L[e]! > L2[f]!) L2[f] = L[e]!;
        if (R[e]! > R2[f]!) R2[f] = R[e]!;
      }
    }
    L.set(L2);
    R.set(R2);
  }

  /**
   * Edge multipliers for re-routing a hop. Its own pass-one path (`own`, with its trains per day)
   * is left out by the share it is a guess (1 − confidence), so a long non-stop hop does not keep
   * itself on a wrong line, while a short hop alone on its line still counts its own trains.
   */
  multFor(own: ArrayLike<number>, ownLong: number, ownReg: number, gc: number): (e: number) => number {
    const self = new Set(Array.from(own));
    const k = 1 - usageConfidence(gc);
    const L = this.long, R = this.reg;
    const longHop = ownLong > ownReg;
    return (e) => {
      let l = L[e]!, r = R[e]!;
      if (self.has(e)) { l -= k * ownLong; r -= k * ownReg; }
      return usageMult(longHop ? l + USAGE_REGIONAL_WEIGHT * r : l + r);
    };
  }
}
