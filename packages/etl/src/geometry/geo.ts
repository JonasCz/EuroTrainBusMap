/** Small geodesy / polyline helpers. Coordinates are [lon, lat] in degrees, distances in metres. */

export type LonLat = [number, number];

export const EARTH_R = 6371008.8;
const D2R = Math.PI / 180;

export function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export const dist = (a: LonLat, b: LonLat): number => haversine(a[0], a[1], b[0], b[1]);

export function polylineLength(c: readonly LonLat[]): number {
  let s = 0;
  for (let i = 1; i < c.length; i++) s += dist(c[i - 1]!, c[i]!);
  return s;
}

/** Metres per degree of longitude / latitude at a latitude (equirectangular approximation). */
export function mPerDeg(lat: number): { kx: number; ky: number } {
  const ky = EARTH_R * D2R;
  return { kx: ky * Math.cos(lat * D2R), ky };
}

/**
 * Douglas-Peucker on a flat coordinate array (x0,y0,x1,y1,…) in degrees, tolerance in metres.
 * Returns the indices (vertex numbers) to keep, always including first and last.
 */
export function simplifyIndices(xy: ArrayLike<number>, n: number, tol: number, scale = 1): number[] {
  if (n <= 2) return n === 2 ? [0, 1] : n === 1 ? [0] : [];
  let latSum = 0;
  for (let i = 0; i < n; i++) latSum += xy[2 * i + 1]!;
  const { kx, ky } = mPerDeg((latSum / n) * scale);
  const sx = kx * scale;
  const sy = ky * scale;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = tol * tol;
  const stack: number[] = [0, n - 1];
  while (stack.length) {
    const last = stack.pop()!;
    const first = stack.pop()!;
    const ax = xy[2 * first]! * sx, ay = xy[2 * first + 1]! * sy;
    const bx = xy[2 * last]! * sx, by = xy[2 * last + 1]! * sy;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = first + 1; i < last; i++) {
      const px = xy[2 * i]! * sx - ax, py = xy[2 * i + 1]! * sy - ay;
      let d2: number;
      if (len2 === 0) d2 = px * px + py * py;
      else {
        let t = (px * dx + py * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - t * dx, ey = py - t * dy;
        d2 = ex * ex + ey * ey;
      }
      if (d2 > maxD) { maxD = d2; idx = i; }
    }
    if (idx >= 0 && maxD > tol2) {
      keep[idx] = 1;
      stack.push(first, idx, idx, last);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

export function simplify(c: readonly LonLat[], tol: number): LonLat[] {
  if (c.length <= 2) return c.slice();
  const flat = new Float64Array(c.length * 2);
  c.forEach((p, i) => { flat[2 * i] = p[0]; flat[2 * i + 1] = p[1]; });
  return simplifyIndices(flat, c.length, tol).map((i) => c[i]!);
}

/** Remove consecutive duplicates (closer than `eps` metres). */
export function dedupe(c: readonly LonLat[], eps = 0.5): LonLat[] {
  const out: LonLat[] = [];
  for (const p of c) {
    const q = out[out.length - 1];
    if (!q || dist(p, q) > eps) out.push(p);
  }
  if (out.length === 1 && c.length > 1) out.push(c[c.length - 1]!);
  return out;
}

/**
 * Adaptive Chaikin corner cutting. Only corners that turn by more than `minTurnDeg` are cut, and
 * each cut is at most `ratio` of the adjacent segment and at most `maxCut` metres, so straight
 * stretches stay untouched and the result stays close to the input (on the railway). The rule is
 * purely local, so two polylines sharing a run of vertices get identical output on that run
 * (except next to where they diverge).
 */
export function smooth(
  c: readonly LonLat[],
  opts: { iterations?: number; ratio?: number; maxCut?: number; minTurnDeg?: number } = {},
): LonLat[] {
  const { iterations = 2, ratio = 0.25, minTurnDeg = 2 } = opts;
  let maxCut = opts.maxCut ?? 250;
  let pts = c.slice();
  const cosMin = Math.cos(minTurnDeg * D2R);
  for (let it = 0; it < iterations; it++) {
    if (pts.length < 3) break;
    const out: LonLat[] = [pts[0]!];
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i - 1]!, q = pts[i]!, r = pts[i + 1]!;
      const { kx, ky } = mPerDeg(q[1]);
      const ax = (q[0] - p[0]) * kx, ay = (q[1] - p[1]) * ky;
      const bx = (r[0] - q[0]) * kx, by = (r[1] - q[1]) * ky;
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la < 1e-6 || lb < 1e-6) { out.push(q); continue; }
      const cos = (ax * bx + ay * by) / (la * lb);
      if (cos > cosMin) { out.push(q); continue; }
      const ca = Math.min(ratio * la, maxCut) / la;
      const cb = Math.min(ratio * lb, maxCut) / lb;
      out.push([q[0] - (q[0] - p[0]) * ca, q[1] - (q[1] - p[1]) * ca]);
      out.push([q[0] + (r[0] - q[0]) * cb, q[1] + (r[1] - q[1]) * cb]);
    }
    out.push(pts[pts.length - 1]!);
    pts = out;
    maxCut /= 2;
  }
  return pts;
}

/** Great-circle interpolation between a and b (fraction t). */
export function gcInterpolate(a: LonLat, b: LonLat, t: number): LonLat {
  const l1 = a[0] * D2R, p1 = a[1] * D2R, l2 = b[0] * D2R, p2 = b[1] * D2R;
  const d = haversine(a[0], a[1], b[0], b[1]) / EARTH_R;
  if (d < 1e-9) return [a[0], a[1]];
  const A = Math.sin((1 - t) * d) / Math.sin(d);
  const B = Math.sin(t * d) / Math.sin(d);
  const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
  const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
  const z = A * Math.sin(p1) + B * Math.sin(p2);
  return [Math.atan2(y, x) / D2R, Math.atan2(z, Math.hypot(x, y)) / D2R];
}

/**
 * Gentle curve from a to b: great-circle base line plus a perpendicular bulge of
 * `bulge` × length (positive = to the left of a→b), shaped like a quadratic Bézier.
 * Number of points scales with length.
 */
export function gentleCurve(a: LonLat, b: LonLat, bulge: number): LonLat[] {
  const L = dist(a, b);
  const n = Math.max(2, Math.min(48, Math.ceil(L / 4000) + (bulge ? 8 : 0)));
  const mid: LonLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const { kx, ky } = mPerDeg(mid[1]);
  const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky;
  const len = Math.hypot(dx, dy) || 1;
  // left normal in metres
  const nx = -dy / len, ny = dx / len;
  const out: LonLat[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const base = gcInterpolate(a, b, t);
    // quadratic Bézier with control offset 2*bulge*L gives max offset bulge*L at t=0.5
    const off = 2 * bulge * L * 2 * t * (1 - t);
    out.push([base[0] + (nx * off) / kx, base[1] + (ny * off) / ky]);
  }
  out[0] = [a[0], a[1]];
  out[n] = [b[0], b[1]];
  return out;
}

export const round5 = (v: number): number => Math.round(v * 1e5) / 1e5;

export function roundCoords(c: readonly LonLat[]): LonLat[] {
  const out: LonLat[] = [];
  for (const p of c) {
    const q: LonLat = [round5(p[0]), round5(p[1])];
    const l = out[out.length - 1];
    if (!l || l[0] !== q[0] || l[1] !== q[1]) out.push(q);
  }
  if (out.length === 1) out.push(out[0]!.slice() as LonLat);
  return out;
}
