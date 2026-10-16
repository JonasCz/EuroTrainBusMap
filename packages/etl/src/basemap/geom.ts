/** Flat-ring geometry helpers for the basemap tiler (rings are Float64Array [x0,y0,x1,y1,...], closed). */
import type { Box } from "./shp.ts";

export type Ring = Float64Array;
/** A polygon: outer ring followed by holes. */
export type Poly = Ring[];

export function ringBox(r: Ring): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    const x = r[i]!, y = r[i + 1]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Round to `f` steps per degree and drop repeated points; returns null if fewer than 4 points remain. */
export function quantize(r: Ring, f: number): Ring | null {
  const out: number[] = [];
  let px = NaN, py = NaN;
  for (let i = 0; i < r.length; i += 2) {
    const x = Math.round(r[i]! * f) / f, y = Math.round(r[i + 1]! * f) / f;
    if (x === px && y === py) continue;
    out.push(x, y);
    px = x;
    py = y;
  }
  if (out.length >= 2 && (out[0] !== px || out[1] !== py)) out.push(out[0]!, out[1]!);
  return out.length >= 8 ? Float64Array.from(out) : null;
}

/** Sutherland–Hodgman clip of a closed ring against a box; null if nothing is left. */
export function clipRingFlat(ring: Ring, box: Box): Ring | null {
  const b = ringBox(ring);
  if (b[0] >= box[0] && b[2] <= box[2] && b[1] >= box[1] && b[3] <= box[3]) return ring;
  if (!boxesOverlap(b, box)) return null;
  let cur: number[] = Array.from(ring);
  cur.length -= 2; // drop the closing point
  for (let edge = 0; edge < 4 && cur.length >= 6; edge++) {
    const out: number[] = [];
    const n = cur.length / 2;
    let px = cur[(n - 1) * 2]!, py = cur[(n - 1) * 2 + 1]!;
    const inside = (x: number, y: number) => (edge === 0 ? x >= box[0] : edge === 1 ? x <= box[2] : edge === 2 ? y >= box[1] : y <= box[3]);
    const cut = (ax: number, ay: number, bx: number, by: number): [number, number] => {
      if (edge < 2) {
        const x = edge === 0 ? box[0] : box[2];
        return [x, ay + ((by - ay) * (x - ax)) / (bx - ax)];
      }
      const y = edge === 2 ? box[1] : box[3];
      return [ax + ((bx - ax) * (y - ay)) / (by - ay), y];
    };
    for (let i = 0; i < n; i++) {
      const x = cur[i * 2]!, y = cur[i * 2 + 1]!;
      const ci = inside(x, y), pi = inside(px, py);
      if (ci) {
        if (!pi) out.push(...cut(px, py, x, y));
        out.push(x, y);
      } else if (pi) out.push(...cut(px, py, x, y));
      px = x;
      py = y;
    }
    cur = out;
  }
  if (cur.length < 6) return null;
  cur.push(cur[0]!, cur[1]!);
  return Float64Array.from(cur);
}

/**
 * Douglas–Peucker for a closed ring. `ky` scales y so that distances are isotropic (Mercator pixels:
 * degrees of latitude are shorter than degrees of longitude by cos(lat) on screen).
 */
export function simplifyRing(r: Ring, tol: number, ky: number): Ring | null {
  const n = r.length / 2;
  if (n <= 4) return r;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const t2 = tol * tol;
  // split the ring at its farthest point from the start so both halves are proper polylines
  let far = 0, fd = -1;
  for (let i = 1; i < n - 1; i++) {
    const dx = r[i * 2]! - r[0]!, dy = (r[i * 2 + 1]! - r[1]!) * ky;
    const d = dx * dx + dy * dy;
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  keep[far] = 1;
  const stack: number[] = [0, far, far, n - 1];
  while (stack.length) {
    const b = stack.pop()!, a = stack.pop()!;
    if (b <= a + 1) continue;
    const ax = r[a * 2]!, ay = r[a * 2 + 1]! * ky, bx = r[b * 2]!, by = r[b * 2 + 1]! * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1, bd = t2;
    for (let i = a + 1; i < b; i++) {
      const x = r[i * 2]!, y = r[i * 2 + 1]! * ky;
      let d: number;
      if (len2 === 0) d = (x - ax) ** 2 + (y - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
        d = (x - (ax + t * dx)) ** 2 + (y - (ay + t * dy)) ** 2;
      }
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push(a, best, best, b);
    }
  }
  let m = 0;
  for (let i = 0; i < n; i++) if (keep[i]) m++;
  if (m < 4) return null;
  const out = new Float64Array(m * 2);
  let j = 0;
  for (let i = 0; i < n; i++)
    if (keep[i]) {
      out[j++] = r[i * 2]!;
      out[j++] = r[i * 2 + 1]!;
    }
  return out;
}
