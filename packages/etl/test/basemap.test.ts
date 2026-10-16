import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { clipRingFlat, quantize, simplifyRing } from "../src/basemap/geom.ts";
import { tarEntries, untar } from "../src/basemap/tar.ts";
import { cutZoom, type Item } from "../src/basemap/tiles.ts";

const ring = (...p: number[][]) => Float64Array.from(p.flat());
const square = (x0: number, y0: number, x1: number, y1: number) => ring([x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]);

describe("basemap geometry", () => {
  it("clips and quantizes rings", () => {
    const c = clipRingFlat(square(-10, -10, 10, 10), [0, 0, 5, 5])!;
    expect(c.length / 2).toBe(5);
    expect(Math.min(...Array.from(c))).toBe(0);
    expect(clipRingFlat(square(20, 20, 30, 30), [0, 0, 5, 5])).toBeNull();
    expect(quantize(ring([0.123456, 1], [0.123457, 1], [1, 1], [1, 2], [0.123456, 1]), 1e4)!.length / 2).toBe(4);
  });
  it("simplifies a noisy edge but keeps corners", () => {
    const pts: number[][] = [[0, 0]];
    for (let i = 1; i < 100; i++) pts.push([i / 10, (i % 2) * 1e-4]);
    pts.push([10, 0], [10, 5], [0, 5], [0, 0]);
    const s = simplifyRing(ring(...pts), 0.01, 1)!;
    expect(s.length / 2).toBeLessThan(10);
    expect(s.length / 2).toBeGreaterThanOrEqual(5);
  });
});

describe("basemap tiles", () => {
  const item = (r: Float64Array, ...holes: Float64Array[]): Item => ({ poly: [r, ...holes], box: [Math.min(...r.filter((_, i) => i % 2 === 0)), Math.min(...r.filter((_, i) => i % 2 === 1)), Math.max(...r.filter((_, i) => i % 2 === 0)), Math.max(...r.filter((_, i) => i % 2 === 1))] });
  it("omits sea, marks all-land tiles, keeps coast tiles", () => {
    // z3 tiles are 45° wide: land covers x 0..~90°E, lat 0..~60 → tile (4,3) is completely land
    const land = item(square(-1, -1, 100, 60));
    const tiles = cutZoom([land], [], 3, 9, () => true);
    const byKey = new Map(tiles.map((t) => [`${t.x}/${t.y}`, t]));
    expect(byKey.get("4/3")?.pbf).toBeNull(); // 0..45E, 0..~41N: fully land
    expect(byKey.get("3/3")?.pbf).toBeInstanceOf(Uint8Array); // contains the western coast
    expect(byKey.has("0/0")).toBe(false); // sea: no tile
  });
  it("a lake keeps an otherwise all-land tile as a file", () => {
    const land = item(square(-1, -1, 100, 60));
    const lake = item(square(10, 10, 12, 12));
    const t = cutZoom([land], [lake], 3, 9, () => true).find((x) => x.x === 4 && x.y === 3)!;
    expect(t.pbf).toBeInstanceOf(Uint8Array);
    expect(gunzipSync(t.pbf!).length).toBeGreaterThan(20);
  });
  it("round-trips a tar", () => {
    const dir = mkdtempSync(join(tmpdir(), "tar-"));
    const n = untar(tarEntries([{ name: "index.json", data: Buffer.from("{}") }, { name: "tiles/3/4/5.pbf.gz", data: Buffer.alloc(1000, 7) }]), dir);
    expect(n).toBe(2);
    expect(readFileSync(join(dir, "tiles/3/4/5.pbf.gz")).length).toBe(1000);
  });
});
