import { describe, expect, it } from "vitest";
import { encodePack, type PackTile, type TilePacks } from "@etbm/shared";
import { PACK_URL_RE, PackStore } from "./packs.ts";

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 13 + seed) & 255);
const toBuf = (u: Uint8Array) => u.slice().buffer;

// two packs of the main set: an overview pack (root, z2–4) and a z4 pack (z5–11); a fill-only node; a mode-filter set
const overview: PackTile[] = [
  { layer: "net", z: 2, x: 2, y: 1, data: bytes(40) },
  { layer: "base", z: 2, x: 2, y: 1, data: bytes(30, 2) },
  { layer: "base", z: 4, x: 9, y: 5, data: null }, // all land from z4 on
];
const city: PackTile[] = [
  { layer: "net", z: 9, x: 275, y: 167, data: bytes(60, 3) },
  { layer: "urb-bus", z: 11, x: 1100, y: 670, data: bytes(20, 4) },
  { layer: "base", z: 6, x: 34, y: 21, data: null },
];
const files: Record<string, Uint8Array> = {
  "http://x/b/packs/aaaa.pack": encodePack({ z: 0, x: 0, y: 0, zmin: 2, zmax: 4 }, overview),
  "http://x/b/packs/bbbb.pack": encodePack({ z: 4, x: 8, y: 5, zmin: 5, zmax: 11 }, city),
  "http://x/b/packs/cccc.pack": encodePack({ z: 0, x: 0, y: 0, zmin: 2, zmax: 6 }, [{ layer: "net-m", z: 3, x: 4, y: 2, data: bytes(10, 5) }]),
};
const packs: TilePacks = {
  version: 1,
  dir: "packs/",
  layers: { base: { minzoom: 2, maxzoom: 9 }, net: { minzoom: 2, maxzoom: 9 }, "urb-bus": { minzoom: 11, maxzoom: 11 }, "net-m": { minzoom: 2, maxzoom: 6 } },
  sets: [
    { layers: ["base", "net", "urb-bus"], fill: "base", nodes: [0, 0, 0, 2, 4, 4, 8, 5, 5, 11, 4, 9, 5, 5, 11], files: ["aaaa", "bbbb", ""] },
    { layers: ["net-m"], nodes: [0, 0, 0, 2, 6], files: ["cccc"] },
  ],
};

function store(maxBytes?: number) {
  const fetched: string[] = [];
  const s = new PackStore(
    packs,
    "http://x/b/",
    async (url) => {
      fetched.push(url);
      await new Promise((r) => setTimeout(r, 1));
      if (!files[url]) throw new Error(`404 ${url}`);
      return toBuf(files[url]!);
    },
    maxBytes,
  );
  return { s, fetched };
}

describe("PackStore", () => {
  it("serves tiles out of the packs, fetching each pack once", async () => {
    const { s, fetched } = store();
    const all = await Promise.all([s.tile("net", 2, 2, 1), s.tile("base", 2, 2, 1), s.tile("net", 9, 275, 167), s.tile("urb-bus", 11, 1100, 670)]);
    expect(all.map((r) => (r.kind === "data" ? [...r.gz] : r.kind))).toEqual([[...bytes(40)], [...bytes(30, 2)], [...bytes(60, 3)], [...bytes(20, 4)]]);
    expect(fetched.sort()).toEqual(["http://x/b/packs/aaaa.pack", "http://x/b/packs/bbbb.pack"]); // in-flight requests shared
    await s.tile("net", 2, 2, 1);
    expect(fetched).toHaveLength(2);
    expect(await s.tile("net-m", 3, 4, 2)).toMatchObject({ kind: "data" });
  });

  it("answers land, sea and empty tiles", async () => {
    const { s, fetched } = store();
    expect((await s.tile("base", 4, 9, 5)).kind).toBe("fill"); // fill entry
    expect((await s.tile("base", 7, 9 * 8 + 1, 5 * 8 + 7)).kind).toBe("fill"); // fill-only node 4/9/5, no file
    expect((await s.tile("net", 7, 9 * 8 + 1, 5 * 8 + 7)).kind).toBe("empty"); // fill-only node: other layers empty
    expect((await s.tile("base", 9, 34 * 8, 21 * 8 + 3)).kind).toBe("fill"); // below a fill entry of the city pack
    expect((await s.tile("base", 9, 275, 167)).kind).toBe("empty"); // sea inside a pack
    expect((await s.tile("base", 9, 10, 10)).kind).toBe("empty"); // no pack there
    expect((await s.tile("urb-rail", 10, 1, 1)).kind).toBe("empty"); // unknown layer
    expect(fetched.filter((u) => u.endsWith("cccc.pack"))).toHaveLength(0);
  });

  it("drops the least recently used packs beyond its budget and fetches them again", async () => {
    const { s, fetched } = store(1); // room for one pack only
    await s.tile("net", 2, 2, 1);
    await s.tile("net", 9, 275, 167);
    expect(s.size).toBe(1);
    await s.tile("net", 2, 2, 1);
    expect(fetched).toEqual(["http://x/b/packs/aaaa.pack", "http://x/b/packs/bbbb.pack", "http://x/b/packs/aaaa.pack"]);
  });

  it("retries a pack whose download failed", async () => {
    let fail = true;
    const s = new PackStore(packs, "http://x/b/", async (url) => {
      if (fail) throw new Error("offline");
      return toBuf(files[url]!);
    });
    await expect(s.tile("net", 2, 2, 1)).rejects.toThrow("offline");
    fail = false;
    expect((await s.tile("net", 2, 2, 1)).kind).toBe("data");
  });

  it("parses pack tile URLs", () => {
    expect(PACK_URL_RE.exec("pack/net-m/5/17/10")?.slice(1)).toEqual(["net-m", "5", "17", "10"]);
    expect(PACK_URL_RE.exec("http://x/glyphs/a/0-255.pbf.gz")).toBeNull();
  });
});
