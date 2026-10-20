import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodePack, PACK_ENTRY_BYTES, PackLookup, TilePack, type PackTile, type TilePacks } from "@etbm/shared";
import { basemapLayerTiles } from "../src/basemap/tiles.ts";
import { readTar, tarEntries } from "../src/basemap/tar.ts";
import { planPacks, writePacks } from "../src/packs.ts";
import { writeLayerFile } from "../src/tilelayers.ts";

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

/** Look a tile up the way the web client does: pack index → pack file → entry. */
function readTile(dir: string, packs: TilePacks, layer: string, z: number, x: number, y: number): Uint8Array | "fill" | null {
  const ref = new PackLookup(packs).find(layer, z, x, y);
  if (!ref) return null;
  if (!ref.file) return ref.set.fill === layer ? "fill" : null;
  const p = new TilePack(readFileSync(join(dir, packs.dir, `${ref.file}.pack`)));
  const t = p.get(layer, z, x, y);
  return t instanceof Uint8Array ? new Uint8Array(t) : t;
}

describe("tile pack format", () => {
  it("round-trips entries and finds fill tiles through their ancestors", () => {
    const tiles: PackTile[] = [
      { layer: "net", z: 5, x: 17, y: 10, data: bytes(100) },
      { layer: "base", z: 5, x: 17, y: 10, data: bytes(50, 2) },
      { layer: "base", z: 6, x: 34, y: 22, data: null },
      { layer: "urb-bus", z: 11, x: 1100, y: 671, data: bytes(7, 3) },
    ];
    const buf = encodePack({ z: 4, x: 8, y: 5, zmin: 5, zmax: 11 }, tiles);
    const p = new TilePack(buf);
    expect(p.node).toEqual({ z: 4, x: 8, y: 5, zmin: 5, zmax: 11 });
    expect(p.size).toBe(4);
    expect(p.get("net", 5, 17, 10)).toEqual(bytes(100));
    expect(p.get("base", 5, 17, 10)).toEqual(bytes(50, 2));
    expect(p.get("urb-bus", 11, 1100, 671)).toEqual(bytes(7, 3));
    expect(p.get("base", 6, 34, 22)).toBe("fill");
    expect(p.get("base", 9, 34 * 8 + 7, 22 * 8 + 3)).toBe("fill"); // descendant of the fill tile
    expect(p.get("net", 9, 34 * 8 + 7, 22 * 8 + 3)).toBeNull(); // fill is per layer
    expect(p.get("base", 6, 35, 22)).toBeNull();
    expect(p.get("rail", 5, 17, 10)).toBeNull();
    expect([...p.entries()].map((t) => `${t.layer}/${t.z}/${t.x}/${t.y}/${t.data?.length ?? "fill"}`).sort()).toEqual(
      tiles.map((t) => `${t.layer}/${t.z}/${t.x}/${t.y}/${t.data?.length ?? "fill"}`).sort(),
    );
    expect(() => new TilePack(buf.subarray(0, buf.length - 1))).toThrow();
  });
});

describe("planPacks (quadtree)", () => {
  it("keeps everything in one root pack when it fits", () => {
    const tiles: PackTile[] = [
      { layer: "net", z: 2, x: 2, y: 1, data: bytes(1000) },
      { layer: "net", z: 9, x: 270, y: 170, data: bytes(1000) },
    ];
    const p = planPacks(tiles, { target: 10_000, maxZoom: 11 });
    expect(p).toHaveLength(1);
    expect(p[0]!.node).toEqual({ z: 0, x: 0, y: 0, zmin: 2, zmax: 11 });
  });

  it("splits dense areas into children, every tile in exactly one pack, packs within the target", () => {
    const tiles: PackTile[] = [];
    // z4..z9 tiles under the z4 tile 8/5, each 1 KB; a sparse single tile elsewhere
    for (let z = 4; z <= 9; z++) {
      const s = 2 ** (z - 4);
      for (let x = 8 * s; x < 9 * s; x++) for (let y = 5 * s; y < 6 * s; y++) tiles.push({ layer: "net", z, x, y, data: bytes(1000, x + y) });
    }
    tiles.push({ layer: "net", z: 9, x: 10, y: 10, data: bytes(1000) });
    const target = 20_000;
    const packs = planPacks(tiles, { target, minZoom: 4, maxZoom: 9 });
    expect(packs.length).toBeGreaterThan(10);
    const seen = new Map<string, number>();
    for (const p of packs) {
      expect(p.bytes).toBeLessThanOrEqual(target);
      for (const t of p.tiles) {
        expect(t.z).toBeGreaterThanOrEqual(p.node.zmin);
        expect(t.z).toBeLessThanOrEqual(p.node.zmax);
        expect(t.x >> (t.z - p.node.z)).toBe(p.node.x);
        const k = `${t.z}/${t.x}/${t.y}`;
        seen.set(k, (seen.get(k) ?? 0) + 1);
      }
    }
    expect(seen.size).toBe(tiles.length);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    // the sparse corner is one large-area pack, the dense area many small ones
    const sparse = packs.find((p) => p.tiles.some((t) => t.x === 10 && t.y === 10))!;
    expect(sparse.node.z).toBeLessThan(4);
  });

  it("an oversized single tile gets a pack of its own", () => {
    const tiles: PackTile[] = [{ layer: "net", z: 3, x: 4, y: 2, data: bytes(5000) }, { layer: "net", z: 4, x: 8, y: 4, data: bytes(10) }];
    const packs = planPacks(tiles, { target: 1000, maxZoom: 9 });
    const big = packs.find((p) => p.tiles.some((t) => t.z === 3))!;
    expect(big.node).toMatchObject({ z: 3, x: 4, y: 2, zmin: 3, zmax: 3 });
    expect(packs.find((p) => p.tiles.some((t) => t.z === 4))!.node.zmin).toBe(4);
  });
});

describe("writePacks", () => {
  it("regroups the layer files and serves every tile, fill and sea tile through the index", async () => {
    const dir = mkdtempSync(join(tmpdir(), "packs-"));
    try {
      // basemap asset: a coast tile, an all-land z4 tile (fill for all its descendants), sea elsewhere
      const index = { version: 2, minzoom: 2, maxzoom: 9, tiles: { 2: [2, 1], 9: [270, 170] }, land: { 4: [8, 6] } };
      const tar = tarEntries([
        { name: "index.json", data: Buffer.from(JSON.stringify(index)) },
        { name: "tiles/2/2/1.pbf.gz", data: bytes(3000, 9) },
        { name: "tiles/9/270/170.pbf.gz", data: bytes(2000, 8) },
      ]);
      expect(readTar(tar).map((e) => e.name)).toEqual(["index.json", "tiles/2/2/1.pbf.gz", "tiles/9/270/170.pbf.gz"]);
      const base = basemapLayerTiles(tar);
      expect(base.tiles.filter((t) => !t.data)).toEqual([{ z: 4, x: 8, y: 6, data: null }]);
      await writeLayerFile(dir, "base", { minzoom: 2, maxzoom: 9 }, base.tiles);
      // dense network around 270/170 (z9) so the quadtree splits there
      const net: { z: number; x: number; y: number; data: Uint8Array }[] = [];
      for (let z = 2; z <= 9; z++) {
        const s = 2 ** (9 - z);
        net.push({ z, x: Math.floor(270 / s), y: Math.floor(170 / s), data: bytes(4000, z) });
        if (z === 9) for (let i = 0; i < 8; i++) net.push({ z, x: 264 + i, y: 168, data: bytes(4000, i) });
      }
      await writeLayerFile(dir, "net", { minzoom: 2, maxzoom: 9 }, net);
      await writeLayerFile(dir, "net-m", { minzoom: 2, maxzoom: 6 }, [{ z: 3, x: 4, y: 2, data: bytes(500) }]);
      await writeLayerFile(dir, "urb-bus", { minzoom: 11, maxzoom: 11 }, [{ z: 11, x: 1080, y: 680, data: bytes(900) }]);
      const { packs, stats } = await writePacks(dir, { target: 12_000, log: () => undefined });
      expect(packs.layers.base).toEqual({ minzoom: 2, maxzoom: 9 });
      expect(packs.sets.map((s) => s.layers)).toEqual([["base", "net", "urb-bus"], ["net-m"]]);
      expect(stats.files).toBeGreaterThan(2);
      for (const t of net) expect(readTile(dir, packs, "net", t.z, t.x, t.y)).toEqual(t.data);
      expect(readTile(dir, packs, "base", 2, 2, 1)).toEqual(bytes(3000, 9));
      expect(readTile(dir, packs, "base", 9, 270, 170)).toEqual(bytes(2000, 8));
      expect(readTile(dir, packs, "urb-bus", 11, 1080, 680)).toEqual(bytes(900));
      expect(readTile(dir, packs, "net-m", 3, 4, 2)).toEqual(bytes(500));
      // land: the z4 tile and all of its descendants, wherever their packs are
      expect(readTile(dir, packs, "base", 4, 8, 6)).toBe("fill");
      expect(readTile(dir, packs, "base", 7, 8 * 8 + 3, 6 * 8 + 5)).toBe("fill");
      expect(readTile(dir, packs, "base", 9, 8 * 32 + 31, 6 * 32)).toBe("fill");
      // sea / empty
      expect(readTile(dir, packs, "base", 9, 10, 10)).toBeNull();
      expect(readTile(dir, packs, "base", 4, 8, 7)).toBeNull();
      expect(readTile(dir, packs, "net", 9, 1, 1)).toBeNull();
      // the pack files are content addressed
      for (const s of packs.sets) for (const f of s.files) if (f) expect(f).toMatch(/^[0-9a-f]{16}$/);
      expect(PACK_ENTRY_BYTES).toBe(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
