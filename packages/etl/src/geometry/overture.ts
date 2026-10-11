/**
 * Overture Maps rail extraction (DuckDB) + loading into a RailGraph.
 *
 * Cache: <workDir>/overture/rail-europe-<release>.parquet (raw Overture columns, ~220 MB).
 * Env overrides: ETBM_RAIL_PARQUET (use this file), ETBM_OVERTURE_RELEASE (force a release).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { RailGraphBuilder, type RailGraph } from './graph.ts';

export const FALLBACK_RELEASE = '2026-09-23.1';
export const EUROPE_BBOX = [-25, 34, 45, 72] as const; // xmin ymin xmax ymax
const STAC = 'https://stac.overturemaps.org/catalog.json';
/** Overture rail classes kept (tram, subway, light_rail, funicular, monorail are dropped). */
const KEEP_CLASSES = ['standard_gauge', 'narrow_gauge', 'unknown', 'high_speed'];
/** Whole-segment rail_flags that drop a segment. */
const DROP_FLAGS = ['is_abandoned', 'is_disused', 'is_under_construction'];

type Log = (s: string) => void;

export async function openDuckDB(workDir: string, log: Log, exts: string[]): Promise<DuckDBConnection> {
  const extDir = join(workDir, 'duckdb-ext');
  mkdirSync(extDir, { recursive: true });
  const db = await DuckDBInstance.create(':memory:', { extension_directory: extDir });
  const c = await db.connect();
  await c.run(`SET autoinstall_known_extensions=false`);
  const row = (await c.runAndReadAll(`SELECT version(), (SELECT platform FROM pragma_platform())`)).getRows()[0]!;
  const [ver, platform] = [String(row[0]), String(row[1])];
  for (const ext of exts) {
    try {
      await c.run(`LOAD ${ext}`);
      continue;
    } catch { /* not installed */ }
    try {
      await c.run(`INSTALL ${ext}`);
      await c.run(`LOAD ${ext}`);
      continue;
    } catch (e) {
      log(`  duckdb: INSTALL ${ext} failed (${String(e).slice(0, 120)}), downloading over https`);
    }
    // DuckDB downloads extensions over plain http, which some proxies reject: fetch via https.
    // same layout as DuckDB's own extension dir, so a plain `LOAD ext` works next time
    const file = join(extDir, ver, platform, `${ext}.duckdb_extension`);
    mkdirSync(join(extDir, ver, platform), { recursive: true });
    if (!existsSync(file)) {
      const url = `https://extensions.duckdb.org/${ver}/${platform}/${ext}.duckdb_extension.gz`;
      let gz: Buffer;
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        gz = Buffer.from(await r.arrayBuffer());
      } catch {
        gz = execFileSync('curl', ['-sSfL', '--retry', '3', url], { maxBuffer: 1 << 30 });
      }
      writeFileSync(file + '.tmp', gunzipSync(gz));
      renameSync(file + '.tmp', file);
    }
    await c.run(`LOAD '${file}'`);
  }
  if (exts.includes('httpfs')) {
    // these settings belong to httpfs, so only after it is loaded
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (proxy) await c.run(`SET http_proxy='${new URL(proxy).host}'`);
    const ca = process.env.SSL_CERT_FILE || process.env.NODE_EXTRA_CA_CERTS || process.env.AWS_CA_BUNDLE;
    if (ca && existsSync(ca)) await c.run(`SET ca_cert_file='${ca}'`);
  }
  return c;
}

/** Latest Overture release from the STAC catalog (falls back to a known release). */
export async function resolveRelease(c: DuckDBConnection | null, log: Log): Promise<string | null> {
  if (process.env.ETBM_OVERTURE_RELEASE) return process.env.ETBM_OVERTURE_RELEASE;
  const pick = (j: { latest?: string; links?: { href?: string; latest?: boolean }[] }) =>
    j.latest ?? j.links?.find((l) => l.latest)?.href?.match(/(\d{4}-\d{2}-\d{2}\.\d+)/)?.[1] ?? null;
  try {
    const r = await fetch(STAC, { signal: AbortSignal.timeout(20000) });
    if (r.ok) { const v = pick(await r.json()); if (v) return v; }
  } catch { /* try duckdb / curl */ }
  try {
    if (c) {
      const rows = (await c.runAndReadAll(`SELECT latest FROM read_json_auto('${STAC}')`)).getRows();
      if (rows[0]?.[0]) return String(rows[0][0]);
    }
  } catch { /* try curl */ }
  try {
    const v = pick(JSON.parse(execFileSync('curl', ['-sSfL', '--max-time', '30', STAC]).toString()));
    if (v) return v;
  } catch (e) {
    log(`  overture: could not resolve latest release (${String(e).slice(0, 100)})`);
  }
  return null;
}

/** Ensure the Europe rail extract exists in the work dir; returns its path. */
export async function ensureRailExtract(workDir: string, log: Log): Promise<string> {
  if (process.env.ETBM_RAIL_PARQUET) return process.env.ETBM_RAIL_PARQUET;
  const dir = join(workDir, 'overture');
  mkdirSync(dir, { recursive: true });
  const cached = readdirSync(dir).filter((f) => /^rail-europe-.*\.parquet$/.test(f)).sort();
  const c = await openDuckDB(workDir, log, ['httpfs', 'spatial']);
  let release = await resolveRelease(c, log);
  if (!release) {
    if (cached.length) { log(`  overture: using cached ${cached[cached.length - 1]}`); return join(dir, cached[cached.length - 1]!); }
    release = FALLBACK_RELEASE;
  }
  const file = join(dir, `rail-europe-${release}.parquet`);
  if (existsSync(file) && statSync(file).size > 0) {
    log(`  overture: cached extract ${file}`);
    return file;
  }
  log(`  overture: extracting rail segments from release ${release} (takes ~10-15 min)…`);
  const t0 = Date.now();
  // Anonymous S3 access: an explicit secret without keys, so DuckDB doesn't send the AWS_* env credentials.
  await c.run(`CREATE OR REPLACE SECRET overture (TYPE s3, PROVIDER config, REGION 'us-west-2')`);
  await c.run(`SET threads=8`);
  const [x0, y0, x1, y1] = EUROPE_BBOX;
  const src = `s3://overturemaps-us-west-2/release/${release}/theme=transportation/type=segment/*.parquet`;
  const tmp = file + '.tmp';
  rmSync(tmp, { force: true });
  try {
    await c.run(`COPY (
      SELECT id, class, names.primary AS name, rail_flags, geometry
      FROM read_parquet('${src}', hive_partitioning=false)
      WHERE subtype = 'rail' AND class IN (${KEEP_CLASSES.map((k) => `'${k}'`).join(',')})
        AND bbox.xmin < ${x1} AND bbox.xmax > ${x0} AND bbox.ymin < ${y1} AND bbox.ymax > ${y0}
        AND NOT coalesce(list_bool_or(list_transform(rail_flags, f -> f.between IS NULL
              AND list_has_any(f.values, [${DROP_FLAGS.map((k) => `'${k}'`).join(',')}]))), false)
    ) TO '${tmp}' (FORMAT parquet, COMPRESSION zstd)`);
  } catch (e) {
    if (release !== FALLBACK_RELEASE) {
      log(`  overture: release ${release} failed (${String(e).slice(0, 160)}); trying ${FALLBACK_RELEASE}`);
      process.env.ETBM_OVERTURE_RELEASE = FALLBACK_RELEASE;
      try { return await ensureRailExtract(workDir, log); } finally { delete process.env.ETBM_OVERTURE_RELEASE; }
    }
    throw e;
  }
  renameSync(tmp, file);
  for (const f of cached) if (join(dir, f) !== file) rmSync(join(dir, f), { force: true });
  log(`  overture: extract done in ${((Date.now() - t0) / 1000).toFixed(0)} s (${(statSync(file).size / 1e6).toFixed(0)} MB)`);
  return file;
}

/** Cost multipliers per class / usage (≥ 1; routing prefers plain passenger main lines). */
export const COST = { unknown: 1.05, narrowGauge: 1.0, freightOnly: 1.4, highSpeed: 0.85, newLine: 0.93 };
/**
 * Overture has no speed / high-speed tag for rail, but OSM line names often say it. Named
 * segments of high-speed lines get a lower cost so e.g. Eurostar takes LGV Nord rather than the
 * (slightly shorter) classic line via Amiens.
 */
export const HIGH_SPEED_NAME =
  '(\\bLGV\\b|grande vitesse|high speed|\\bHS[1-9]\\b|\\bHSL\\b|alta velocit|alta velocidad|alta velocidade|alta capacit|hızlı tren|hızlı demiryolu|hogesnelheid|vysokorychlost|dużych prędkości|Centralna Magistrala)';
/** German new lines: often parallel to upgraded classic lines that trains still use, so a smaller bonus. */
export const NEW_LINE_NAME = '(schnellfahrstrecke|neubaustrecke|snabbtåg)';

/** Read the extract (WKB linestrings) into a RailGraph. */
export async function loadRailGraph(parquet: string, workDir: string, log: Log, simplifyTol = 20): Promise<RailGraph> {
  const c = await openDuckDB(workDir, log, ['spatial']);
  const t0 = Date.now();
  const b = new RailGraphBuilder();
  const res = await c.stream(`
    SELECT
      CASE class WHEN 'unknown' THEN ${COST.unknown} WHEN 'narrow_gauge' THEN ${COST.narrowGauge} ELSE 1.0 END
      * CASE WHEN coalesce(list_bool_or(list_transform(rail_flags, f -> f.between IS NULL
            AND list_contains(f.values, 'is_freight') AND NOT list_contains(f.values, 'is_passenger'))), false)
          THEN ${COST.freightOnly} ELSE 1.0 END
      * CASE WHEN regexp_matches(coalesce(name, ''), '${HIGH_SPEED_NAME}', 'i') THEN ${COST.highSpeed}
             WHEN regexp_matches(coalesce(name, ''), '${NEW_LINE_NAME}', 'i') THEN ${COST.newLine} ELSE 1.0 END AS mult,
      ST_AsWKB(geometry) AS wkb
    FROM read_parquet('${parquet}')
    WHERE NOT coalesce(list_bool_or(list_transform(rail_flags, f -> f.between IS NULL
          AND list_has_any(f.values, [${DROP_FLAGS.map((k) => `'${k}'`).join(',')}]))), false)`);
  let flat = new Float64Array(4096);
  for (;;) {
    const ch = await res.fetchChunk();
    if (!ch || ch.rowCount === 0) break;
    const mv = ch.getColumnVector(0), gv = ch.getColumnVector(1);
    for (let i = 0; i < ch.rowCount; i++) {
      const blob = gv.getItem(i) as { bytes: Uint8Array } | null;
      if (!blob) continue;
      const bytes = blob.bytes;
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const le = dv.getUint8(0) === 1;
      const type = dv.getUint32(1, le) % 1000;
      const mult = Number(mv.getItem(i));
      const lines: number[] = []; // byte offsets of each linestring's point count
      if (type === 2) lines.push(5);
      else if (type === 5) {
        const nl = dv.getUint32(5, le);
        let off = 9;
        for (let k = 0; k < nl; k++) { lines.push(off + 5); off += 9 + 16 * dv.getUint32(off + 5, le); }
      } else continue;
      for (const off of lines) {
        const n = dv.getUint32(off, le);
        if (flat.length < 2 * n) flat = new Float64Array(4 * n);
        for (let k = 0; k < 2 * n; k++) flat[k] = dv.getFloat64(off + 4 + 8 * k, le);
        b.addLine(flat.subarray(0, 2 * n), mult);
      }
    }
  }
  log(`  graph: read ${b.lineCount} lines / ${b.vertexCount} vertices in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const t1 = Date.now();
  const g = b.build({ simplifyTol, log });
  log(`  graph: built in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  return g;
}
