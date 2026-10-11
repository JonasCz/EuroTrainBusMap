/**
 * Builds the minimal basemap GeoJSON layers used by the web map from Natural
 * Earth 1:50m data (public domain), clipped to Europe + Turkey.
 *
 * Outputs into <outDir>:
 *   land.json     Polygon/MultiPolygon features (land masses)
 *   borders.json  LineString/MultiLineString features (country borders on land)
 *   lakes.json    Polygon features (large lakes)
 *   labels.json   Point features with country names (optional for the web)
 *
 * CLI:   node --experimental-strip-types scripts/basemap.ts <outDir> [--cache <dir>]
 * API:   import { buildBasemap } from "@etbm/web/scripts/basemap.ts"
 *        await buildBasemap({ outDir, cacheDir })
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type BBox = [minLon: number, minLat: number, maxLon: number, maxLat: number];
export const EUROPE_BBOX: BBox = [-25, 34, 45, 72];

const NE_BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson";

type Pos = [number, number];
type Ring = Pos[];
interface Feature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: any } | null;
}
interface FC {
  type: "FeatureCollection";
  features: Feature[];
}

export interface BasemapOptions {
  outDir: string;
  /** Directory to cache downloaded Natural Earth files (default: no cache). */
  cacheDir?: string;
  bbox?: BBox;
  /** Coordinate precision in decimals (default 3 ≈ 100 m, plenty for 1:50m). */
  precision?: number;
  log?: (msg: string) => void;
}

async function fetchNE(name: string, cacheDir?: string): Promise<FC> {
  const file = `${name}.geojson`;
  if (cacheDir) {
    const p = join(cacheDir, file);
    if (existsSync(p)) return JSON.parse(await readFile(p, "utf8")) as FC;
  }
  const res = await fetch(`${NE_BASE}/${file}`);
  if (!res.ok) throw new Error(`Natural Earth download failed: ${file} ${res.status}`);
  const text = await res.text();
  if (cacheDir) {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, file), text);
  }
  return JSON.parse(text) as FC;
}

// ---------------------------------------------------------------------------
// Clipping (pure, exported for tests / reuse)

/** Sutherland–Hodgman clip of a closed ring against an axis-aligned box. */
export function clipRing(ring: Ring, [x0, y0, x1, y1]: BBox): Ring {
  const edges: [(p: Pos) => boolean, (a: Pos, b: Pos) => Pos][] = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ];
  let out = ring.slice();
  if (out.length && samePos(out[0]!, out[out.length - 1]!)) out.pop();
  for (const [inside, cut] of edges) {
    if (!out.length) break;
    const input = out;
    out = [];
    let prev = input[input.length - 1]!;
    for (const cur of input) {
      const ci = inside(cur);
      const pi = inside(prev);
      if (ci) {
        if (!pi) out.push(cut(prev, cur));
        out.push(cur);
      } else if (pi) {
        out.push(cut(prev, cur));
      }
      prev = cur;
    }
  }
  if (out.length < 3) return [];
  out.push(out[0]!);
  return out;
}

/** Clip a polyline to a box; returns zero or more pieces (Liang–Barsky). */
export function clipLine(line: Pos[], [x0, y0, x1, y1]: BBox): Pos[][] {
  const pieces: Pos[][] = [];
  let cur: Pos[] = [];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    let t0 = 0;
    let t1 = 1;
    let ok = true;
    for (const [p, q] of [
      [-dx, a[0] - x0],
      [dx, x1 - a[0]],
      [-dy, a[1] - y0],
      [dy, y1 - a[1]],
    ] as const) {
      if (p === 0) {
        if (q < 0) ok = false;
      } else {
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
      }
    }
    if (!ok || t0 > t1) {
      if (cur.length > 1) pieces.push(cur);
      cur = [];
      continue;
    }
    const pa: Pos = [a[0] + t0 * dx, a[1] + t0 * dy];
    const pb: Pos = [a[0] + t1 * dx, a[1] + t1 * dy];
    if (!cur.length || !samePos(cur[cur.length - 1]!, pa)) {
      if (cur.length > 1) pieces.push(cur);
      cur = [pa];
    }
    cur.push(pb);
    if (t1 < 1) {
      pieces.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) pieces.push(cur);
  return pieces;
}

function samePos(a: Pos, b: Pos): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function roundRing(r: Pos[], f: number): Pos[] {
  const out: Pos[] = [];
  for (const p of r) {
    const q: Pos = [Math.round(p[0] * f) / f, Math.round(p[1] * f) / f];
    if (!out.length || !samePos(out[out.length - 1]!, q)) out.push(q);
  }
  return out;
}

function polygonsOf(g: Feature["geometry"]): Ring[][] {
  if (!g) return [];
  if (g.type === "Polygon") return [g.coordinates as Ring[]];
  if (g.type === "MultiPolygon") return g.coordinates as Ring[][];
  return [];
}
function linesOf(g: Feature["geometry"]): Pos[][] {
  if (!g) return [];
  if (g.type === "LineString") return [g.coordinates as Pos[]];
  if (g.type === "MultiLineString") return g.coordinates as Pos[][];
  return [];
}

export function clipPolygons(fc: FC, bbox: BBox, precision: number, keep: (p: Record<string, unknown>) => Record<string, unknown> = () => ({})): FC {
  const f = 10 ** precision;
  const features: Feature[] = [];
  for (const feat of fc.features) {
    const polys: Ring[][] = [];
    for (const poly of polygonsOf(feat.geometry)) {
      const outer = roundRing(clipRing(poly[0] ?? [], bbox), f);
      if (outer.length < 4) continue;
      const holes = poly
        .slice(1)
        .map((h) => roundRing(clipRing(h, bbox), f))
        .filter((h) => h.length >= 4);
      polys.push([outer, ...holes]);
    }
    if (!polys.length) continue;
    features.push({
      type: "Feature",
      properties: keep(feat.properties ?? {}),
      geometry: polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys },
    });
  }
  return { type: "FeatureCollection", features };
}

export function clipLines(fc: FC, bbox: BBox, precision: number, keep: (p: Record<string, unknown>) => Record<string, unknown> = () => ({})): FC {
  const f = 10 ** precision;
  const features: Feature[] = [];
  for (const feat of fc.features) {
    const lines: Pos[][] = [];
    for (const l of linesOf(feat.geometry)) {
      for (const piece of clipLine(l, bbox)) {
        const r = roundRing(piece, f);
        if (r.length > 1) lines.push(r);
      }
    }
    if (!lines.length) continue;
    features.push({
      type: "Feature",
      properties: keep(feat.properties ?? {}),
      geometry: lines.length === 1 ? { type: "LineString", coordinates: lines[0] } : { type: "MultiLineString", coordinates: lines },
    });
  }
  return { type: "FeatureCollection", features };
}

// ---------------------------------------------------------------------------

export async function buildBasemap(opts: BasemapOptions): Promise<void> {
  const bbox = opts.bbox ?? EUROPE_BBOX;
  const precision = opts.precision ?? 3;
  const log = opts.log ?? ((m: string) => console.log(m));
  await mkdir(opts.outDir, { recursive: true });

  const [land, borders, lakes, countries] = await Promise.all([
    fetchNE("ne_50m_land", opts.cacheDir),
    fetchNE("ne_50m_admin_0_boundary_lines_land", opts.cacheDir),
    fetchNE("ne_50m_lakes", opts.cacheDir),
    fetchNE("ne_50m_admin_0_countries", opts.cacheDir),
  ]);

  const out: Record<string, FC> = {
    land: clipPolygons(land, bbox, precision),
    borders: clipLines(borders, bbox, precision),
    lakes: clipPolygons(lakes, bbox, precision, (p) => ({ name: p.name ?? null })),
    labels: {
      type: "FeatureCollection",
      features: countries.features
        .map((c): Feature | null => {
          const p = c.properties;
          const x = Number(p.LABEL_X);
          const y = Number(p.LABEL_Y);
          if (!(x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3])) return null;
          return {
            type: "Feature",
            properties: {
              name: String(p.NAME_EN ?? p.NAME ?? ""),
              iso: String(p.ISO_A2_EH ?? p.ISO_A2 ?? ""),
              rank: Number(p.LABELRANK ?? 5),
              minzoom: Number(p.MIN_LABEL ?? 3),
            },
            geometry: { type: "Point", coordinates: [Math.round(x * 100) / 100, Math.round(y * 100) / 100] },
          };
        })
        .filter((f): f is Feature => f !== null),
    },
  };

  for (const [name, fc] of Object.entries(out)) {
    const json = JSON.stringify(fc);
    await writeFile(join(opts.outDir, `${name}.json`), json);
    log(`basemap/${name}.json: ${fc.features.length} features, ${(json.length / 1024).toFixed(0)} KiB`);
  }
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const ci = args.indexOf("--cache");
  const cacheDir = ci >= 0 ? args[ci + 1] : undefined;
  const outDir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--cache");
  if (!outDir) {
    console.error("usage: basemap.ts <outDir> [--cache <dir>]");
    process.exit(1);
  }
  await buildBasemap({ outDir, cacheDir });
}
