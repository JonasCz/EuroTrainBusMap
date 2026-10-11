export type LonLat = [number, number];

const R = 6371008.8;
const RAD = Math.PI / 180;

/** Great-circle distance in metres. */
export function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Fast equirectangular approximation in metres (good for < ~50 km). */
export function fastDist(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const x = (lon2 - lon1) * RAD * Math.cos(((lat1 + lat2) / 2) * RAD);
  const y = (lat2 - lat1) * RAD;
  return Math.sqrt(x * x + y * y) * R;
}

export function round5(x: number): number {
  return Math.round(x * 1e5) / 1e5;
}

/**
 * Simple uniform grid spatial index over points (lon/lat), cell size in degrees.
 * Queries return candidate indices within a radius (metres).
 */
export class GridIndex {
  private cells = new Map<number, number[]>();
  constructor(
    private readonly lons: ArrayLike<number>,
    private readonly lats: ArrayLike<number>,
    private readonly cell = 0.1,
  ) {
    for (let i = 0; i < lons.length; i++) this.insert(i);
  }

  private key(cx: number, cy: number): number {
    return (cx + 4000) * 10000 + (cy + 4000);
  }

  insert(i: number): void {
    const k = this.key(Math.floor(this.lons[i]! / this.cell), Math.floor(this.lats[i]! / this.cell));
    let arr = this.cells.get(k);
    if (!arr) this.cells.set(k, (arr = []));
    arr.push(i);
  }

  /** Indices of points within `radius` metres of (lon, lat). */
  within(lon: number, lat: number, radius: number): number[] {
    const dLat = radius / 111_000;
    const dLon = radius / (111_000 * Math.max(0.1, Math.cos(lat * RAD)));
    const x0 = Math.floor((lon - dLon) / this.cell), x1 = Math.floor((lon + dLon) / this.cell);
    const y0 = Math.floor((lat - dLat) / this.cell), y1 = Math.floor((lat + dLat) / this.cell);
    const out: number[] = [];
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const arr = this.cells.get(this.key(x, y));
        if (!arr) continue;
        for (const i of arr) if (fastDist(lon, lat, this.lons[i]!, this.lats[i]!) <= radius) out.push(i);
      }
    return out;
  }
}

/** Sample a great-circle between a and b into n+1 points. */
export function greatCircle(a: LonLat, b: LonLat, maxSegKm = 25): LonLat[] {
  const d = haversine(a[0], a[1], b[0], b[1]) / 1000;
  const n = Math.max(1, Math.min(64, Math.ceil(d / maxSegKm)));
  if (n === 1) return [a, b];
  const [l1, p1, l2, p2] = [a[0] * RAD, a[1] * RAD, b[0] * RAD, b[1] * RAD];
  const v1 = [Math.cos(p1) * Math.cos(l1), Math.cos(p1) * Math.sin(l1), Math.sin(p1)];
  const v2 = [Math.cos(p2) * Math.cos(l2), Math.cos(p2) * Math.sin(l2), Math.sin(p2)];
  const dot = Math.min(1, Math.max(-1, v1[0]! * v2[0]! + v1[1]! * v2[1]! + v1[2]! * v2[2]!));
  const om = Math.acos(dot);
  const out: LonLat[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (om < 1e-9) {
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      continue;
    }
    const s1 = Math.sin((1 - t) * om) / Math.sin(om), s2 = Math.sin(t * om) / Math.sin(om);
    const x = s1 * v1[0]! + s2 * v2[0]!, y = s1 * v1[1]! + s2 * v2[1]!, z = s1 * v1[2]! + s2 * v2[2]!;
    out.push([Math.atan2(y, x) / RAD, Math.atan2(z, Math.sqrt(x * x + y * y)) / RAD]);
  }
  return out;
}

/** Douglas–Peucker simplification with tolerance in metres (equirectangular). */
export function simplifyLine(pts: LonLat[], tolM: number): LonLat[] {
  if (pts.length <= 2) return pts;
  const lat0 = (pts[0]![1] * Math.PI) / 180;
  const kx = 111_320 * Math.cos(lat0), ky = 110_540;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = pts[a]![0] * kx, ay = pts[a]![1] * ky, bx = pts[b]![0] * kx, by = pts[b]![1] * ky;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let best = -1, bestD = tolM;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i]![0] * kx, py = pts[i]![1] * ky;
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
