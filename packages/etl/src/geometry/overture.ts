/**
 * Overture Maps rail extraction (DuckDB) + loading into a RailGraph.
 *
 * Cache: <workDir>/overture/<kind>-<coverage id>-<release>.parquet (raw Overture columns, rail ~220 MB); the
 * coverage id (`COVERAGE_ID`, packages/shared/src/coverage.ts) is in the name so a cached extract of another area
 * is never reused.
 * Env overrides: ETBM_RAIL_PARQUET (use this file), ETBM_OVERTURE_RELEASE (force a release).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { COVERAGE_BOXES, COVERAGE_ID, MAP_BBOX } from '@etbm/shared';
import { RailGraphBuilder, type RailGraph } from './graph.ts';
import { haversine } from './geo.ts';

export const FALLBACK_RELEASE = '2026-09-23.1';
/** Box around the extracted area (stored in the graph header); the extraction itself takes `COVERAGE_BOXES`. */
export const EXTRACT_BBOX = MAP_BBOX; // xmin ymin xmax ymax
/** File name prefix of a cached extract: `<kind>-<coverage id>-<release>.parquet`. */
export const extractPrefix = (kind: string): string => `${kind}-${COVERAGE_ID}-`;
/** SQL: an Overture row's bbox struct intersects one of the coverage boxes. */
export const coverageWhere = (): string =>
  '(' + COVERAGE_BOXES.map(([x0, y0, x1, y1]) => `(bbox.xmin < ${x1} AND bbox.xmax > ${x0} AND bbox.ymin < ${y1} AND bbox.ymax > ${y0})`).join(' OR ') + ')';
const STAC = 'https://stac.overturemaps.org/catalog.json';
/** Overture rail classes kept (tram, subway, light_rail, funicular, monorail are dropped). */
const KEEP_CLASSES = ['standard_gauge', 'narrow_gauge', 'unknown', 'high_speed'];
/**
 * Whole-segment rail_flags marking track that is (probably) not in service. OSM often tags the wrong
 * piece (a 3.5 km "disused" stub between two operating pieces of the Madrid–Cáceres line), so these
 * segments are not dropped but kept at a high cost: routing only uses them where nothing else connects.
 */
const STATUS_FLAGS = { abandoned: 'is_abandoned', disused: 'is_disused', construction: 'is_under_construction' } as const;

type Log = (s: string) => void;

const instances = new WeakMap<DuckDBConnection, DuckDBInstance>();
/** Close a connection from openDuckDB and its database (frees DuckDB's memory). */
export function closeDuckDB(c: DuckDBConnection): void {
  try { c.closeSync(); } catch { /* ignore */ }
  try { instances.get(c)?.closeSync(); } catch { /* ignore */ }
  instances.delete(c);
}

export async function openDuckDB(workDir: string, log: Log, exts: string[]): Promise<DuckDBConnection> {
  const extDir = join(workDir, 'duckdb-ext');
  mkdirSync(extDir, { recursive: true });
  const tmpDir = join(workDir, 'duckdb-tmp');
  mkdirSync(tmpDir, { recursive: true });
  // The ETL process already holds several GB when geometry runs: cap DuckDB and let it spill.
  const db = await DuckDBInstance.create(':memory:', {
    extension_directory: extDir,
    memory_limit: process.env.ETBM_GEOMETRY_DUCKDB_MEMORY || '4GB',
    threads: '4',
    temp_directory: tmpDir,
    // don't keep fetched remote parquet blocks in the buffer pool
    enable_external_file_cache: 'false',
  });
  const c = await db.connect();
  instances.set(c, db);
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

/** What to extract from Overture transportation segments. */
export interface ExtractSpec {
  /** file prefix: <kind>-<coverage id>-<release>.parquet */
  kind: 'rail' | 'road' | 'urbanrail';
  /** env var with a parquet path that overrides the extraction */
  env: string;
  /** SELECT list */
  select: string;
  /** extra WHERE conditions (bbox is added) */
  where: string;
}

const flagFilter = (col: string, flags: string[]) =>
  `NOT coalesce(list_bool_or(list_transform(${col}, f -> f.between IS NULL
     AND list_has_any(f.values, [${flags.map((k) => `'${k}'`).join(',')}]))), false)`;

export const RAIL_SPEC: ExtractSpec = {
  kind: 'rail',
  env: 'ETBM_RAIL_PARQUET',
  select: 'id, class, names.primary AS name, rail_flags, geometry',
  where: `subtype = 'rail' AND class IN (${KEEP_CLASSES.map((k) => `'${k}'`).join(',')})`,
};

/** Road classes kept for coach/bus routing (their `_link` ramps have the same class, subclass 'link'). */
export const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];
export const ROAD_SPEC: ExtractSpec = {
  kind: 'road',
  env: 'ETBM_ROAD_PARQUET',
  select: 'class, subclass, connectors, geometry',
  where: `subtype = 'road' AND class IN (${ROAD_CLASSES.map((k) => `'${k}'`).join(',')})
    AND ${flagFilter('road_flags', ['is_abandoned', 'is_under_construction'])}`,
};

/** Tram, metro, light rail, funicular and monorail track (only used to align local-transport lines that come without shapes). */
export const URBAN_RAIL_CLASSES = ['tram', 'subway', 'light_rail', 'funicular', 'monorail'];
export const URBAN_RAIL_SPEC: ExtractSpec = {
  kind: 'urbanrail',
  env: 'ETBM_URBAN_RAIL_PARQUET',
  select: 'class, geometry',
  where: `subtype = 'rail' AND class IN (${URBAN_RAIL_CLASSES.map((k) => `'${k}'`).join(',')})`,
};
export const ensureUrbanRailExtract = (workDir: string, log: Log): Promise<string> => ensureOvertureExtract(workDir, log, URBAN_RAIL_SPEC);

/** Ensure the Europe rail extract exists in the work dir; returns its path. */
export const ensureRailExtract = (workDir: string, log: Log): Promise<string> => ensureOvertureExtract(workDir, log, RAIL_SPEC);
/** Ensure the Europe major-road extract exists in the work dir; returns its path. */
export const ensureRoadExtract = (workDir: string, log: Log): Promise<string> => ensureOvertureExtract(workDir, log, ROAD_SPEC);

export async function ensureOvertureExtract(workDir: string, log: Log, spec: ExtractSpec): Promise<string> {
  if (process.env[spec.env]) return process.env[spec.env]!;
  const dir = join(workDir, 'overture');
  mkdirSync(dir, { recursive: true });
  const re = new RegExp(`^${extractPrefix(spec.kind)}.*\\.parquet$`);
  const cached = readdirSync(dir).filter((f) => re.test(f)).sort();
  // The Overture bucket is public. DuckDB would send AWS_* credentials from the environment (e.g.
  // a CI role or a sandbox placeholder) and get 403, so hide them while DuckDB runs.
  const saved: Record<string, string> = {};
  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_DEFAULT_PROFILE']) {
    if (process.env[k] !== undefined) { saved[k] = process.env[k]!; delete process.env[k]; }
  }
  try {
    const c = await openDuckDB(workDir, log, ['httpfs', 'spatial']);
    try {
      return await extractWith(c, spec, dir, cached, log);
    } finally {
      closeDuckDB(c);
    }
  } finally {
    Object.assign(process.env, saved);
  }
}

async function extractWith(c: DuckDBConnection, spec: ExtractSpec, dir: string, cached: string[], log: Log): Promise<string> {
  let release = await resolveRelease(c, log);
  if (!release) {
    if (cached.length) { log(`  overture: using cached ${cached[cached.length - 1]}`); return join(dir, cached[cached.length - 1]!); }
    release = FALLBACK_RELEASE;
  }
  const file = join(dir, `${extractPrefix(spec.kind)}${release}.parquet`);
  if (existsSync(file) && statSync(file).size > 0) {
    log(`  overture: cached extract ${file}`);
    return file;
  }
  log(`  overture: extracting ${spec.kind} segments from release ${release} (takes ~15-30 min)…`);
  const t0 = Date.now();
  // Anonymous S3 access: an explicit secret without keys, so DuckDB doesn't send the AWS_* env credentials.
  await c.run(`CREATE OR REPLACE SECRET overture (TYPE s3, PROVIDER config, KEY_ID '', SECRET '', REGION 'us-west-2')`);
  const src = `s3://overturemaps-us-west-2/release/${release}/theme=transportation/type=segment/*.parquet`;
  const tmp = file + '.tmp';
  rmSync(tmp, { force: true });
  try {
    await c.run(`COPY (
      SELECT ${spec.select}
      FROM read_parquet('${src}', hive_partitioning=false)
      WHERE ${coverageWhere()}
        AND ${spec.where}
    ) TO '${tmp}' (FORMAT parquet, COMPRESSION zstd)`);
  } catch (e) {
    if (release !== FALLBACK_RELEASE) {
      log(`  overture: release ${release} failed (${String(e).slice(0, 160)}); trying ${FALLBACK_RELEASE}`);
      process.env.ETBM_OVERTURE_RELEASE = FALLBACK_RELEASE;
      try { return await extractWith(c, spec, dir, cached, log); } finally { delete process.env.ETBM_OVERTURE_RELEASE; }
    }
    throw e;
  }
  renameSync(tmp, file);
  for (const f of cached) if (join(dir, f) !== file) rmSync(join(dir, f), { force: true });
  log(`  overture: ${spec.kind} extract done in ${((Date.now() - t0) / 1000).toFixed(0)} s (${(statSync(file).size / 1e6).toFixed(0)} MB)`);
  return file;
}

/** Cost multipliers per class / usage (≥ 1; routing prefers plain passenger main lines). */
export const COST = { unknown: 1.05, narrowGauge: 1.0, freightOnly: 1.4, highSpeed: 0.85, newLine: 0.93, construction: 3, disused: 4, abandoned: 6 };

/** SQL: whole-segment flag test */
const hasFlag = (flag: string) => `coalesce(list_bool_or(list_transform(rail_flags, f -> f.between IS NULL AND list_contains(f.values, '${flag}'))), false)`;
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
export async function loadRailGraph(parquet: string, workDir: string, log: Log, simplifyTol = 20, opts: { plain?: boolean } = {}): Promise<RailGraph> {
  const c = await openDuckDB(workDir, log, ['spatial']);
  const t0 = Date.now();
  const b = new RailGraphBuilder();
  const res = await c.stream(opts.plain ? `SELECT 1.0 AS mult, ST_AsWKB(geometry) AS wkb FROM read_parquet('${parquet}')` : `
    SELECT
      CASE class WHEN 'unknown' THEN ${COST.unknown} WHEN 'narrow_gauge' THEN ${COST.narrowGauge} ELSE 1.0 END
      * CASE WHEN coalesce(list_bool_or(list_transform(rail_flags, f -> f.between IS NULL
            AND list_contains(f.values, 'is_freight') AND NOT list_contains(f.values, 'is_passenger'))), false)
          THEN ${COST.freightOnly} ELSE 1.0 END
      * CASE WHEN regexp_matches(coalesce(name, ''), '${HIGH_SPEED_NAME}', 'i') THEN ${COST.highSpeed}
             WHEN regexp_matches(coalesce(name, ''), '${NEW_LINE_NAME}', 'i') THEN ${COST.newLine} ELSE 1.0 END
      * CASE WHEN ${hasFlag(STATUS_FLAGS.abandoned)} THEN ${COST.abandoned}
             WHEN ${hasFlag(STATUS_FLAGS.disused)} THEN ${COST.disused}
             WHEN ${hasFlag(STATUS_FLAGS.construction)} THEN ${COST.construction} ELSE 1.0 END AS mult,
      ST_AsWKB(geometry) AS wkb
    FROM read_parquet('${parquet}')`);
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
  closeDuckDB(c);
  log(`  graph: read ${b.lineCount} lines / ${b.vertexCount} vertices in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const t1 = Date.now();
  const g = b.build({ simplifyTol, log });
  log(`  graph: built in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  return g;
}

/**
 * Typical coach speeds (km/h) per Overture road class; `_link` ramps (subclass 'link') use
 * ROAD_LINK_SPEED. Edge cost = length × (motorway speed / class speed), so cost ≥ length.
 */
export const ROAD_SPEED: Record<string, number> = { motorway: 110, trunk: 90, primary: 70, secondary: 60, tertiary: 50 };
export const ROAD_LINK_SPEED = 50;

/**
 * Read the major-road extract into a graph. Topology comes from Overture connector ids (roads
 * cross and join mid-segment, unlike rail): each segment is cut at its connectors.
 */
export async function loadRoadGraph(
  parquet: string, workDir: string, log: Log,
  opts: { simplifyTol?: number; classes?: string[] } = {},
): Promise<RailGraph> {
  const classes = opts.classes ?? ROAD_CLASSES;
  const vmax = Math.max(...Object.values(ROAD_SPEED));
  const c = await openDuckDB(workDir, log, ['spatial']);
  const t0 = Date.now();
  const b = new RailGraphBuilder();
  // 64-bit connector hash split into two int32 halves (collisions are negligible)
  const res = await c.stream(`
    SELECT
      CASE WHEN subclass = 'link' THEN ${vmax / ROAD_LINK_SPEED}
        ${Object.entries(ROAD_SPEED).map(([k, v]) => `WHEN class = '${k}' THEN ${vmax / v}`).join(' ')} ELSE ${vmax / 50} END AS mult,
      list_transform(connectors, x -> ((hash(x.connector_id) >> 32)::BIGINT - 2147483648)::INTEGER) AS khi,
      list_transform(connectors, x -> ((hash(x.connector_id) & 4294967295)::BIGINT - 2147483648)::INTEGER) AS klo,
      list_transform(connectors, x -> x."at") AS kat,
      ST_AsWKB(geometry) AS wkb
    FROM read_parquet('${parquet}')
    WHERE class IN (${classes.map((k) => `'${k}'`).join(',')})`);
  let flat = new Float64Array(4096);
  let cum = new Float64Array(2048);
  const idx: number[] = [], hi: number[] = [], lo: number[] = [];
  for (;;) {
    const ch = await res.fetchChunk();
    if (!ch || ch.rowCount === 0) break;
    const mv = ch.getColumnVector(0), hv = ch.getColumnVector(1), lv = ch.getColumnVector(2), av = ch.getColumnVector(3), gv = ch.getColumnVector(4);
    for (let i = 0; i < ch.rowCount; i++) {
      const blob = gv.getItem(i) as { bytes: Uint8Array } | null;
      if (!blob) continue;
      const bytes = blob.bytes;
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const le = dv.getUint8(0) === 1;
      if (dv.getUint32(1, le) % 1000 !== 2) continue; // segments are linestrings
      const n = dv.getUint32(5, le);
      if (flat.length < 2 * n) flat = new Float64Array(4 * n);
      if (cum.length < n) cum = new Float64Array(2 * n);
      for (let k = 0; k < 2 * n; k++) flat[k] = dv.getFloat64(9 + 8 * k, le);
      // cumulative length fraction per vertex, to place connectors given as `at` (0..1)
      cum[0] = 0;
      for (let k = 1; k < n; k++) cum[k] = cum[k - 1]! + haversine(flat[2 * k - 2]!, flat[2 * k - 1]!, flat[2 * k]!, flat[2 * k + 1]!);
      const total = cum[n - 1]! || 1;
      const H = (hv.getItem(i) as { items: readonly unknown[] } | null)?.items ?? [];
      const L = (lv.getItem(i) as { items: readonly unknown[] } | null)?.items ?? [];
      const A = (av.getItem(i) as { items: readonly unknown[] } | null)?.items ?? [];
      idx.length = 0; hi.length = 0; lo.length = 0;
      const order = A.map((a, k) => [Number(a), k] as const).sort((x, y) => x[0] - y[0]);
      let j = 0;
      for (const [a, k] of order) {
        const target = a * total;
        while (j < n - 1 && Math.abs(cum[j + 1]! - target) <= Math.abs(cum[j]! - target)) j++;
        idx.push(j); hi.push(Number(H[k])); lo.push(Number(L[k]));
      }
      b.addLine(flat.subarray(0, 2 * n), Number(mv.getItem(i)), { idx, hi, lo });
    }
  }
  closeDuckDB(c);
  log(`  road graph: read ${b.lineCount} segments / ${b.vertexCount} vertices in ${((Date.now() - t0) / 1000).toFixed(1)} s, rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
  const t1 = Date.now();
  const g = b.build({ simplifyTol: opts.simplifyTol ?? 50, log });
  log(`  road graph: built in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  return g;
}
