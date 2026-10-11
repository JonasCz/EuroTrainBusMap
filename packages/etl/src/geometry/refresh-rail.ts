/**
 * Rail graph asset: Overture extract → routing graph → prune → compact binary.
 *
 * The result is uploaded to R2 (`eurotrainbusmap-assets`, key RAIL_GRAPH_KEY) by the
 * refresh-assets workflow (packages/etl/src/assets.ts); the weekly build downloads it to
 * `<workDir>/geometry/` and buildGeometries loads it instead of extracting Overture.
 *
 * CLI:  pnpm --filter @etbm/etl rail:refresh [workDir] [outFile]
 *       (defaults: ./work, <workDir>/geometry/rail-graph-v<N>.bin)
 */
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EUROPE_BBOX, ensureRailExtract, loadRailGraph } from './overture.ts';
import { graphBytes } from './graph.ts';
import { pruneGraph, RAIL_FORMAT, serializeRailGraph } from './railbin.ts';

export const RAIL_GRAPH_FILE = `rail-graph-v${RAIL_FORMAT}.bin`;
/** R2 object key (bucket eurotrainbusmap-assets) */
export const RAIL_GRAPH_KEY = `rail/${RAIL_GRAPH_FILE}`;
/** Track tolerance of stored geometry (m) */
export const RAIL_SIMPLIFY_TOL = 20;
/** Disconnected fragments with less track than this are dropped (m) */
export const RAIL_MIN_COMPONENT = 3000;

/** Default local path of the graph file inside a work dir. */
export const railGraphPath = (workDir: string): string => join(workDir, 'geometry', RAIL_GRAPH_FILE);

export async function buildRailAsset(
  workDir: string,
  outFile: string = railGraphPath(workDir),
  log: (s: string) => void = console.log,
): Promise<{ key: string; file: string; release: string; bytes: number; sha256: string }> {
  const t0 = Date.now();
  const parquet = await ensureRailExtract(workDir, log);
  const release = basename(parquet).match(/rail-europe-(.+)\.parquet$/)?.[1] ?? 'unknown';
  const g0 = await loadRailGraph(parquet, workDir, log, RAIL_SIMPLIFY_TOL);
  const g = pruneGraph(g0, RAIL_MIN_COMPONENT);
  log(`rail: pruned ${g0.nodeCount}→${g.nodeCount} nodes, ${g0.edgeCount}→${g.edgeCount} edges, ${g0.compSize.length}→${g.compSize.length} components (${(graphBytes(g) / 1e6).toFixed(0)} MB in memory)`);
  const buf = serializeRailGraph(g, { release, bbox: EUROPE_BBOX, simplifyTol: RAIL_SIMPLIFY_TOL, minComponent: RAIL_MIN_COMPONENT });
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile + '.tmp', buf);
  renameSync(outFile + '.tmp', outFile);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  log(`rail: wrote ${outFile} (${(buf.length / 1e6).toFixed(1)} MB, release ${release}) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return { key: RAIL_GRAPH_KEY, file: outFile, release, bytes: buf.length, sha256 };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const workDir = resolve(process.argv[2] ?? 'work');
  const out = process.argv[3] ? resolve(process.argv[3]) : railGraphPath(workDir);
  const r = await buildRailAsset(workDir, out);
  console.log(JSON.stringify(r));
}
