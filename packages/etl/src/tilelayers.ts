/**
 * Tile layers before packing: each stage (basemap, mapdata, urban) writes all tiles of a layer as ONE pack file
 * (`<build>/layers/<layer>.pack`, node 0/0/0, packages/shared/src/tilepack.ts); the pack stage (packs.ts) regroups them
 * by area. Not deployed.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodePack } from "@etbm/shared";

export const LAYERS_DIR = "layers";

/** Write one layer's tiles as `<buildDir>/layers/<layer>.pack`; returns its size. */
export async function writeLayerFile(buildDir: string, layer: string, zoom: { minzoom: number; maxzoom: number }, tiles: { z: number; x: number; y: number; data: Uint8Array | null }[]): Promise<number> {
  await mkdir(join(buildDir, LAYERS_DIR), { recursive: true });
  const buf = encodePack({ z: 0, x: 0, y: 0, zmin: zoom.minzoom, zmax: zoom.maxzoom }, tiles.map((t) => ({ ...t, layer })));
  await writeFile(join(buildDir, LAYERS_DIR, `${layer}.pack`), buf);
  return buf.length;
}
