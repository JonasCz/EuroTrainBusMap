/**
 * One-off vendoring script: downloads pre-built MapLibre glyph PBFs (Noto Sans,
 * SIL Open Font License 1.1) from protomaps/basemaps-assets into
 * public/glyphs/. The output is committed, so the site never fetches glyphs
 * from a third party at runtime.
 *
 *   node --experimental-strip-types scripts/fetch-glyphs.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = "https://raw.githubusercontent.com/protomaps/basemaps-assets/main/fonts";
const FONTS = ["Noto Sans Regular", "Noto Sans Medium"];
/**
 * Unicode ranges needed for European + Turkish place names:
 * Latin-1, Latin Ext-A/B (Polish, Czech, Turkish, Romanian ș/ț), Greek,
 * Cyrillic (+supplement), Latin Ext Additional, punctuation, letterlike/arrows.
 */
const RANGES = [0, 256, 512, 768, 1024, 1280, 7680, 8192, 8448].map((s) => `${s}-${s + 255}`);

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "glyphs");

for (const font of FONTS) {
  await mkdir(join(out, font), { recursive: true });
  for (const r of RANGES) {
    const url = `${SRC}/${encodeURIComponent(font)}/${r}.pbf`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    // stored gzipped: static hosts don't compress protobuf; the app inflates them (src/map/protocol.ts)
    await writeFile(join(out, font, `${r}.pbf.gz`), gzipSync(new Uint8Array(await res.arrayBuffer()), { level: 9 }));
    console.log("ok", font, r);
  }
}
const lic = await fetch(`${SRC}/OFL.txt`);
await writeFile(join(out, "OFL.txt"), await lic.text());
console.log("done");
