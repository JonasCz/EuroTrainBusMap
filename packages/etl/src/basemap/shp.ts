/**
 * Minimal streaming reader for ESRI shapefile polygons (.shp), enough for the OSM land polygons
 * (osmdata.openstreetmap.de). Records whose bounding box misses `box` are skipped without
 * decoding. Rings are returned as flat [x0, y0, x1, y1, ...] Float64Arrays, each closed.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export type Box = [minX: number, minY: number, maxX: number, maxY: number];

export interface ShpRecord {
  /** Outer rings (clockwise in the file) each followed by its holes. */
  polygons: Float64Array[][];
  bbox: Box;
}

function ringArea(r: Float64Array): number {
  let a = 0;
  for (let i = 2; i < r.length; i += 2) a += (r[i - 2]! * r[i + 1]! - r[i]! * r[i - 1]!);
  return a / 2;
}

/** Iterate polygon records intersecting `box`. */
export function* readPolygons(file: string, box: Box): Generator<ShpRecord> {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    let buf = Buffer.allocUnsafe(64 << 20);
    let have = 0; // bytes valid in buf
    let pos = 100; // file position of next record header
    let bufStart = 100; // file position of buf[0]
    const fill = (need: number) => {
      // ensure buf holds [pos, pos+need)
      const off = pos - bufStart;
      if (off + need <= have) return;
      if (need > buf.length) {
        const nb = Buffer.allocUnsafe(Math.max(need, buf.length));
        buf.copy(nb, 0, off, have);
        buf = nb;
      } else buf.copy(buf, 0, off, have);
      have -= off;
      bufStart = pos;
      while (have < Math.min(buf.length, size - bufStart)) {
        const n = readSync(fd, buf, have, buf.length - have, bufStart + have);
        if (n <= 0) break;
        have += n;
      }
    };
    while (pos + 8 <= size) {
      fill(8);
      const clen = buf.readInt32BE(pos - bufStart + 4) * 2;
      fill(8 + clen);
      const o = pos - bufStart + 8;
      pos += 8 + clen;
      if (buf.readInt32LE(o) !== 5) continue; // not a polygon
      const bbox: Box = [buf.readDoubleLE(o + 4), buf.readDoubleLE(o + 12), buf.readDoubleLE(o + 20), buf.readDoubleLE(o + 28)];
      if (bbox[2] < box[0] || bbox[0] > box[2] || bbox[3] < box[1] || bbox[1] > box[3]) continue;
      const nParts = buf.readInt32LE(o + 36);
      const nPts = buf.readInt32LE(o + 40);
      const partsAt = o + 44;
      const ptsAt = partsAt + 4 * nParts;
      const polygons: Float64Array[][] = [];
      for (let p = 0; p < nParts; p++) {
        const from = buf.readInt32LE(partsAt + 4 * p);
        const to = p + 1 < nParts ? buf.readInt32LE(partsAt + 4 * (p + 1)) : nPts;
        const ring = new Float64Array((to - from) * 2);
        for (let i = from; i < to; i++) {
          ring[(i - from) * 2] = buf.readDoubleLE(ptsAt + 16 * i);
          ring[(i - from) * 2 + 1] = buf.readDoubleLE(ptsAt + 16 * i + 8);
        }
        // clockwise (negative signed area in a y-up system) = outer ring, otherwise hole of the last outer
        if (ringArea(ring) <= 0 || !polygons.length) polygons.push([ring]);
        else polygons[polygons.length - 1]!.push(ring);
      }
      yield { polygons, bbox };
    }
  } finally {
    closeSync(fd);
  }
}
