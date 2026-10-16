/**
 * Geometry graph assets: Overture extract → routing graph → prune → compact binary.
 *
 *   rail/rail-graph-v<N>.bin   rail (standard/narrow gauge) for train corridors
 *   road/road-graph-v<N>.bin   major roads (motorway…secondary + links) for coach/bus corridors
 *
 * Uploaded to R2 (`eurotrainbusmap-assets`) by the refresh-assets workflow
 * (packages/etl/src/assets.ts). The weekly build downloads them into `<work>/assets/<kind>/` and
 * buildGeometries loads them instead of extracting Overture.
 *
 * CLI:  pnpm --filter @etbm/etl rail:refresh [workDir] [outFile] [--road]
 *       (defaults: ./work, <workDir>/geometry/<kind>-graph-v<N>.bin)
 */
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EUROPE_BBOX, ensureRailExtract, ensureRoadExtract, ensureUrbanRailExtract, loadRailGraph, loadRoadGraph } from './overture.ts';
import { bridgeGaps, graphBytes } from './graph.ts';
import { pruneGraph, RAIL_FORMAT, serializeRailGraph, type GraphKind } from './railbin.ts';

export const graphFileName = (kind: GraphKind): string => `${kind}-graph-v${RAIL_FORMAT}.bin`;
export const RAIL_GRAPH_FILE = graphFileName('rail');
export const ROAD_GRAPH_FILE = graphFileName('road');
export const URBAN_RAIL_GRAPH_FILE = graphFileName('urbanrail');
/** R2 object keys (bucket eurotrainbusmap-assets) */
export const RAIL_GRAPH_KEY = `rail/${RAIL_GRAPH_FILE}`;
export const ROAD_GRAPH_KEY = `road/${ROAD_GRAPH_FILE}`;
/** Tram / metro / light-rail track (local-transport lines without shapes) */
export const URBAN_RAIL_GRAPH_KEY = `rail/${URBAN_RAIL_GRAPH_FILE}`;
/** Geometry tolerance of stored edges (m) */
export const RAIL_SIMPLIFY_TOL = 20;
export const ROAD_SIMPLIFY_TOL = 30;
/** Disconnected fragments with less track / road than this are dropped (m) */
export const RAIL_MIN_COMPONENT = 3000;
/** Dead ends closer than this (m) to track of another component are joined to it (graph.ts bridgeGaps) */
export const RAIL_BRIDGE_GAP = 300;
export const ROAD_BRIDGE_GAP = 0;
export const ROAD_MIN_COMPONENT = 20000;
/** Tram networks are small: keep fragments from 600 m, join dead ends up to 60 m from other track */
export const URBAN_RAIL_MIN_COMPONENT = 600;
export const URBAN_RAIL_BRIDGE_GAP = 60;

/** Default local path of a graph file inside a work dir. */
export const railGraphPath = (workDir: string): string => join(workDir, 'geometry', RAIL_GRAPH_FILE);
export const roadGraphPath = (workDir: string): string => join(workDir, 'geometry', ROAD_GRAPH_FILE);

export interface GraphAsset { key: string; file: string; release: string; bytes: number; sha256: string }

export async function buildGraphAsset(
  kind: GraphKind,
  workDir: string,
  outFile: string = join(workDir, 'geometry', graphFileName(kind)),
  log: (s: string) => void = console.log,
  opts: { roadClasses?: string[] } = {},
): Promise<GraphAsset> {
  const t0 = Date.now();
  const parquet = kind === 'rail' ? await ensureRailExtract(workDir, log) : kind === 'urbanrail' ? await ensureUrbanRailExtract(workDir, log) : await ensureRoadExtract(workDir, log);
  const release = basename(parquet).match(/-europe-(.+)\.parquet$/)?.[1] ?? 'unknown';
  const tol = kind === 'road' ? ROAD_SIMPLIFY_TOL : RAIL_SIMPLIFY_TOL;
  const minComponent = kind === 'road' ? ROAD_MIN_COMPONENT : kind === 'urbanrail' ? URBAN_RAIL_MIN_COMPONENT : RAIL_MIN_COMPONENT;
  const g0 = kind !== 'road'
    ? await loadRailGraph(parquet, workDir, log, tol, { plain: kind === 'urbanrail' })
    : await loadRoadGraph(parquet, workDir, log, { simplifyTol: tol, classes: opts.roadClasses });
  const gap = kind === 'road' ? ROAD_BRIDGE_GAP : kind === 'urbanrail' ? URBAN_RAIL_BRIDGE_GAP : RAIL_BRIDGE_GAP;
  const g = pruneGraph(gap > 0 ? bridgeGaps(g0, { maxGap: gap, log }) : g0, minComponent);
  log(`${kind}: pruned ${g0.nodeCount}→${g.nodeCount} nodes, ${g0.edgeCount}→${g.edgeCount} edges, ${g0.compSize.length}→${g.compSize.length} components (${(graphBytes(g) / 1e6).toFixed(0)} MB in memory, rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB)`);
  const buf = serializeRailGraph(g, { kind, release, bbox: EUROPE_BBOX, simplifyTol: tol, minComponent });
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile + '.tmp', buf);
  renameSync(outFile + '.tmp', outFile);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  log(`${kind}: wrote ${outFile} (${(buf.length / 1e6).toFixed(1)} MB, release ${release}) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return { key: kind === 'urbanrail' ? URBAN_RAIL_GRAPH_KEY : `${kind}/${graphFileName(kind)}`, file: outFile, release, bytes: buf.length, sha256 };
}

export const buildRailAsset = (workDir: string, outFile?: string, log?: (s: string) => void) => buildGraphAsset('rail', workDir, outFile, log);
export const buildUrbanRailAsset = (workDir: string, outFile?: string, log?: (s: string) => void) => buildGraphAsset('urbanrail', workDir, outFile, log);
export const buildRoadAsset = (workDir: string, outFile?: string, log?: (s: string) => void) => buildGraphAsset('road', workDir, outFile, log);

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const kind: GraphKind = args.includes('--road') ? 'road' : 'rail';
  const pos = args.filter((a) => !a.startsWith('--'));
  const workDir = resolve(pos[0] ?? 'work');
  const out = pos[1] ? resolve(pos[1]) : join(workDir, 'geometry', graphFileName(kind));
  const r = await buildGraphAsset(kind, workDir, out);
  console.log(JSON.stringify(r));
}
