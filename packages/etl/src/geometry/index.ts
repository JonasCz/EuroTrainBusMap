/**
 * Corridor geometries.
 *
 * rail: shortest path on the Overture rail graph between the (snapped) stations of the
 *       corridor's representative hop; feed shapes are used when routing fails or detours.
 * road: feed shape if plausible, else a gentle great-circle curve.
 * Every line is then attached to the city points a / b, smoothed (adaptive Chaikin) and
 * rounded to 5 decimals.
 */
import { ensureRailExtract, loadRailGraph } from './overture.ts';
import { graphBytes, type RailGraph } from './graph.ts';
import { Router, type RouteResult } from './route.ts';
import { dedupe, dist, gentleCurve, mPerDeg, polylineLength, roundCoords, simplify, smooth, type LonLat } from './geo.ts';

export interface GeometryRequest {
  id: number;
  mode: 'rail' | 'road';
  /** representative station-to-station hops (most frequent first, up to 3) */
  hops: { from: [number, number]; to: [number, number]; shape?: [number, number][] }[];
  /** city representative points */
  a: [number, number];
  b: [number, number];
}
export interface GeometryResult { id: number; coords: [number, number][]; snapped: boolean }

export interface BuildOptions { workDir: string; log: (s: string) => void }

/** Max routed track length relative to the station distance. */
export const MAX_DETOUR = (gc: number) => 2.2 * gc + 5000;
const ROAD_BULGE = 0.05;
const SHAPE_TOL = 25;

export async function buildGeometries(reqs: GeometryRequest[], opts: BuildOptions): Promise<GeometryResult[]> {
  const { log } = opts;
  let router: Router | null = null;
  if (reqs.some((r) => r.mode === 'rail')) {
    try {
      const t0 = Date.now();
      const parquet = await ensureRailExtract(opts.workDir, log);
      const g = await loadRailGraph(parquet, opts.workDir, log);
      log(`geometry: rail graph ready in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${(graphBytes(g) / 1e6).toFixed(0)} MB`);
      router = new Router(g);
    } catch (e) {
      log(`geometry: rail graph unavailable, using fallback lines (${String(e).slice(0, 300)})`);
    }
  }
  return buildWithRouter(reqs, router, log);
}

/** Same as buildGeometries but with a ready router (tests / demo). */
export function buildWithRouter(reqs: GeometryRequest[], router: Router | null, log: (s: string) => void = () => {}): GeometryResult[] {
  const t0 = Date.now();
  const cache = new Map<string, RouteResult | null>();
  const counts = { rail: 0, routed: 0, shape: 0, fallback: 0, road: 0, roadShape: 0 };
  const out: GeometryResult[] = [];
  let lastLog = Date.now();
  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i]!;
    let res: GeometryResult;
    try {
      res = r.mode === 'rail' ? railGeometry(r, router, cache, counts) : roadGeometry(r, counts);
    } catch (e) {
      log(`geometry: request ${r.id} failed (${String(e).slice(0, 200)}), using fallback`);
      res = { id: r.id, coords: finish(gentleCurve(r.a, r.b, 0), 0), snapped: false };
    }
    out.push(res);
    if (Date.now() - lastLog > 30000) {
      lastLog = Date.now();
      log(`geometry: ${i + 1}/${reqs.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
  }
  const s = (Date.now() - t0) / 1000;
  log(`geometry: ${reqs.length} corridors in ${s.toFixed(1)} s — rail ${counts.rail} (routed ${counts.routed}, shape ${counts.shape}, fallback ${counts.fallback}), road ${counts.road} (shape ${counts.roadShape})`);
  return out;
}

type Counts = { rail: number; routed: number; shape: number; fallback: number; road: number; roadShape: number };

function orient(h: GeometryRequest['hops'][number], a: LonLat, b: LonLat) {
  if (dist(h.from, a) + dist(h.to, b) <= dist(h.from, b) + dist(h.to, a)) return h;
  return { from: h.to, to: h.from, shape: h.shape ? h.shape.slice().reverse() : undefined };
}

/** A feed shape is used only if it ends near the stations, isn't a wild detour and has real detail. */
function plausibleShape(h: { from: LonLat; to: LonLat; shape?: LonLat[] }): LonLat[] | null {
  const s = h.shape;
  if (!s || s.length < 2) return null;
  const gc = dist(h.from, h.to);
  if (dist(s[0]!, h.from) > 1000 || dist(s[s.length - 1]!, h.to) > 1000) return null;
  const len = polylineLength(s);
  if (len > 2 * gc + 2000) return null;
  // a shape that is just the straight stop-to-stop line adds nothing
  if (s.length < Math.max(4, gc / 5000)) return null;
  return s;
}

const key = (p: LonLat, q: LonLat) => `${p[0].toFixed(4)},${p[1].toFixed(4)};${q[0].toFixed(4)},${q[1].toFixed(4)}`;

function railGeometry(r: GeometryRequest, router: Router | null, cache: Map<string, RouteResult | null>, counts: Counts): GeometryResult {
  counts.rail++;
  let shapeFallback: LonLat[] | null = null;
  for (const raw of r.hops.slice(0, 3)) {
    const h = orient(raw, r.a, r.b);
    const shape = plausibleShape(h);
    const gc = dist(h.from, h.to);
    let routed: RouteResult | null = null;
    if (router && gc > 30) {
      const k = key(h.from, h.to), kr = key(h.to, h.from);
      if (cache.has(k)) routed = cache.get(k)!;
      else if (cache.has(kr)) {
        const c = cache.get(kr)!;
        routed = c && { ...c, coords: c.coords.slice().reverse(), snapA: c.snapB, snapB: c.snapA };
      } else {
        routed = router.route(h.from, h.to, MAX_DETOUR(gc));
        cache.set(k, routed);
      }
    }
    if (routed) {
      if (shape && routed.length > 1.3 * polylineLength(shape)) {
        counts.shape++;
        return { id: r.id, coords: finish(attach(r.a, simplify(shape, SHAPE_TOL), r.b), 1), snapped: true };
      }
      counts.routed++;
      return { id: r.id, coords: finish(attach(r.a, routed.coords, r.b), 1), snapped: true };
    }
    if (shape && !shapeFallback) shapeFallback = shape;
  }
  if (shapeFallback) {
    counts.shape++;
    return { id: r.id, coords: finish(attach(r.a, simplify(shapeFallback, SHAPE_TOL), r.b), 1), snapped: true };
  }
  counts.fallback++;
  return { id: r.id, coords: finish(gentleCurve(r.a, r.b, 0), 0), snapped: false };
}

function roadGeometry(r: GeometryRequest, counts: Counts): GeometryResult {
  counts.road++;
  for (const raw of r.hops.slice(0, 3)) {
    const shape = plausibleShape(orient(raw, r.a, r.b));
    if (shape) {
      counts.roadShape++;
      return { id: r.id, coords: finish(attach(r.a, simplify(shape, 40), r.b), 2), snapped: false };
    }
  }
  // bulge to the left of west→east, so a↔b and b↔a give the same curve
  const sign = r.a[0] < r.b[0] || (r.a[0] === r.b[0] && r.a[1] < r.b[1]) ? 1 : -1;
  return { id: r.id, coords: finish(gentleCurve(r.a, r.b, sign * ROAD_BULGE), 0), snapped: false };
}

/**
 * Join city point a → path → city point b. The path is trimmed to its closest approach to the
 * city point (searched within the first / last 35 % of its length), so a line never runs past
 * the city dot and back; the remaining gap becomes a straight stub that smoothing rounds off.
 */
export function attach(a: LonLat, path: readonly LonLat[], b: LonLat): LonLat[] {
  let P = dedupe(path);
  if (P.length < 2) return [a, b];
  P = trimStart(a, P);
  P = trimStart(b, P.slice().reverse()).reverse();
  P = lead(a, P);
  P = lead(b, P.slice().reverse()).reverse();
  return dedupe(P);
}

/**
 * Prefix the path with city point a. A short gap is a straight stub; when the stub would make a
 * sharp turn into the path (city dot "behind" the station) a cubic Bézier leaves a and merges
 * tangentially into the path further along, so there is no hook.
 */
function lead(a: LonLat, P: LonLat[]): LonLat[] {
  const d = dist(a, P[0]!);
  if (d < 40) return [a, ...P.slice(1)];
  const total = polylineLength(P);
  const { kx, ky } = mPerDeg(a[1]);
  const toM = (p: LonLat): [number, number] => [(p[0] - a[0]) * kx, (p[1] - a[1]) * ky];
  const toLL = (x: number, y: number): LonLat => [a[0] + x / kx, a[1] + y / ky];
  // path direction near its start
  const ahead = pointAt(P, Math.min(300, total / 2));
  const [sx, sy] = toM(P[0]!), [hx, hy] = toM(ahead.p);
  const tx = hx - sx, ty = hy - sy;
  const cos = (sx * tx + sy * ty) / ((Math.hypot(sx, sy) || 1) * (Math.hypot(tx, ty) || 1));
  if (cos > 0.5) return [a, ...P]; // turn < 60°: plain stub, smoothing rounds it
  // merge point: far enough along that the curve can turn gently
  const m = pointAt(P, Math.min(0.3 * total, Math.max(2 * d, 800)));
  const back = pointAt(P, Math.max(0, m.s - 300));
  const [mx, my] = toM(m.p), [bx, by] = toM(back.p);
  const tl = Math.hypot(mx - bx, my - by) || 1;
  const L = Math.hypot(mx, my);
  const c2x = mx - ((mx - bx) / tl) * (L / 2.5), c2y = my - ((my - by) / tl) * (L / 2.5);
  const c1x = c2x / 3, c1y = c2y / 3;
  const out: LonLat[] = [];
  const n = 14;
  for (let i = 0; i < n; i++) {
    const t = i / n, u = 1 - t;
    out.push(toLL(3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * mx, 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * my));
  }
  return [...out, m.p, ...P.slice(m.k + 1)];
}

/** Point at distance s along P; k = index of the vertex before it. */
function pointAt(P: LonLat[], s: number): { p: LonLat; k: number; s: number } {
  let cum = 0;
  for (let k = 0; k < P.length - 1; k++) {
    const l = dist(P[k]!, P[k + 1]!);
    if (cum + l >= s) {
      const t = l > 0 ? (s - cum) / l : 0;
      return { p: [P[k]![0] + t * (P[k + 1]![0] - P[k]![0]), P[k]![1] + t * (P[k + 1]![1] - P[k]![1])], k, s };
    }
    cum += l;
  }
  return { p: P[P.length - 1]!, k: P.length - 2, s: cum };
}

function trimStart(a: LonLat, P: LonLat[]): LonLat[] {
  const total = polylineLength(P);
  const lim = 0.35 * total;
  const { kx, ky } = mPerDeg(a[1]);
  let best = Infinity, bk = 0, bt = 0, cum = 0;
  for (let k = 0; k < P.length - 1 && cum <= lim; k++) {
    const p = P[k]!, q = P[k + 1]!;
    const ax = (p[0] - a[0]) * kx, ay = (p[1] - a[1]) * ky;
    const dx = (q[0] - p[0]) * kx, dy = (q[1] - p[1]) * ky;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const segLen = Math.sqrt(l2);
    if (cum + t * segLen > lim) t = Math.max(0, (lim - cum) / (segLen || 1));
    const d = Math.hypot(ax + t * dx, ay + t * dy) + 0.05 * (cum + t * segLen);
    if (d < best) { best = d; bk = k; bt = t; }
    cum += segLen;
  }
  if (bk === 0 && bt === 0) return P;
  const p = P[bk]!, q = P[bk + 1]!;
  const start: LonLat = [p[0] + bt * (q[0] - p[0]), p[1] + bt * (q[1] - p[1])];
  const rest = P.slice(bt >= 1 ? bk + 2 : bk + 1);
  return dedupe([start, ...rest]);
}

/** Smooth + round. style 0 = already smooth curve, 1 = rail (stay on track), 2 = road shape. */
function finish(c: LonLat[], style: 0 | 1 | 2): [number, number][] {
  if (style === 1) c = smooth(c, { iterations: 2, maxCut: 200, minTurnDeg: 6 });
  else if (style === 2) c = smooth(c, { iterations: 2, maxCut: 600, minTurnDeg: 4 });
  return roundCoords(c);
}

export type { RailGraph };
export { Router } from './route.ts';
