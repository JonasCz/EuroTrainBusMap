import { fastDist, haversine, type LonLat } from "../util/geo.ts";

function nearest(pts: LonLat[], p: LonLat, from = 0, to = pts.length): { i: number; d: number } {
  let bi = -1, bd = Infinity;
  for (let i = from; i < to; i++) {
    const d = fastDist(p[0], p[1], pts[i]![0], pts[i]![1]);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  return { i: bi, d: bd };
}

/**
 * Slice a shape polyline between stops a and b (nearest-point projection).
 * Returns null if the stops are far from the shape or the slice is implausible.
 */
export function sliceShape(pts: LonLat[], a: LonLat, b: LonLat, maxOff = 1500): LonLat[] | null {
  if (pts.length < 2) return null;
  const na = nearest(pts, a);
  if (na.d > maxOff) return null;
  // search b after a first (direction of travel), else anywhere
  let nb = nearest(pts, b, na.i + 1);
  let reversed = false;
  if (nb.i < 0 || nb.d > maxOff) {
    nb = nearest(pts, b, 0, na.i);
    reversed = true;
    if (nb.i < 0 || nb.d > maxOff) return null;
  }
  const lo = Math.min(na.i, nb.i), hi = Math.max(na.i, nb.i);
  let seg = pts.slice(lo, hi + 1);
  if (reversed) seg = seg.reverse();
  if (seg.length < 2) return null;
  let len = 0;
  for (let i = 1; i < seg.length; i++) len += haversine(seg[i - 1]![0], seg[i - 1]![1], seg[i]![0], seg[i]![1]);
  const gc = haversine(a[0], a[1], b[0], b[1]);
  if (len > 3 * gc + 5000) return null;
  return seg;
}
