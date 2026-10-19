/**
 * Corridor geometries.
 *
 * rail: shortest path on the Overture rail graph between the (snapped) stations of the
 *       corridor's representative hop; feed shapes are used when routing fails or detours.
 * road: feed shape if plausible, else a gentle great-circle curve.
 * Every line is then attached to the city points a / b, smoothed (adaptive Chaikin) and
 * rounded to 5 decimals.
 */
import { existsSync, readFileSync } from 'node:fs';
import { COVERAGE_ID } from '@etbm/shared';
import { ensureRailExtract, ensureRoadExtract, loadRailGraph, loadRoadGraph } from './overture.ts';
import { join } from 'node:path';
import { deserializeRailGraph, pruneGraph, type GraphKind } from './railbin.ts';
import { RAIL_SIMPLIFY_TOL, ROAD_MIN_COMPONENT, ROAD_SIMPLIFY_TOL, graphFileName } from './refresh-rail.ts';
import { graphBytes, type RailGraph } from './graph.ts';
import { Router, type RouteResult } from './route.ts';
import { dedupe, dist, gentleCurve, mPerDeg, polylineLength, roundCoords, simplify, smooth, type LonLat } from './geo.ts';
import {
  HS_AVOID_MULT, OFF_SHAPE_MULT, TrackUsage, USAGE_MAX_MULT, USAGE_MIN_HOP, avoidHighSpeed, coverage, highSpeedEdges, highSpeedHop, hsAvoidMult, hsLength,
  onTrack, shapeEdgeMult, usesHs,
} from './guide.ts';

export interface GeometryRequest {
  id: number;
  mode: 'rail' | 'road';
  /** representative station-to-station hops (most frequent first, up to 3) */
  hops: { from: [number, number]; to: [number, number]; shape?: [number, number][] }[];
  /** city representative points */
  a: [number, number];
  b: [number, number];
  /**
   * The city points are stations (each city's main station): a line must pass through its own
   * end stations, so it is only trimmed where it really passes the city point, and joined by a
   * plain stub otherwise (no Bézier shortcut past the station).
   */
  anchored?: boolean;
  /** rail trains per day on the corridor (weights its track usage, see guide.ts) */
  tpd?: number;
  /** of which long-distance trains */
  tpdLong?: number;
  /** of which high-speed services (TGV, ICE, AVE…; see guide.ts `highSpeedEdges`) */
  tpdHs?: number;
  /** fastest scheduled time (min) between the two stations of high-speed services / of other trains */
  minHs?: number;
  minConv?: number;
}
export interface GeometryResult { id: number; coords: [number, number][]; snapped: boolean }

export interface BuildOptions {
  workDir: string;
  log: (s: string) => void;
  /** rail graph file (default: env ETBM_RAIL_GRAPH, else <workDir>/geometry/ or <workDir>/assets/rail/rail-graph-v<N>.bin) */
  railGraph?: string;
  /** road graph file (default: env ETBM_ROAD_GRAPH, else <workDir>/geometry/ or <workDir>/assets/road/road-graph-v<N>.bin) */
  roadGraph?: string;
  /** if a graph file is missing: true → unsnapped curves; false (default) → slow Overture extraction */
  noExtract?: boolean;
}

/** Max routed track length relative to the station distance. */
export const MAX_DETOUR = (gc: number) => 2.2 * gc + 5000;
const ROAD_BULGE = 0.05;
/** Corridors shorter than this (m) are drawn as a straight line without routing. */
const TRIVIAL_M = 60;
const SHAPE_TOL = 10;
/** A feed shape with at least this share of its length on track (≤ 150 m) guides the rail route. */
const SHAPE_ON_TRACK = 0.9;
/** The shape-guided route is kept when it covers this share of the shape (≤ 300 m), else the shape is drawn. */
const SHAPE_COVERED = 0.9;

/**
 * Trains do not reverse at junctions (route.ts `reversalCost`): a reversal costs as much as half
 * the hop's straight-line distance in track, at most 50 km (Libourne → Angoulême stays on the
 * classic line instead of backing onto LGV SEA at Ambarès).
 */
export const RAIL_ROUTER_OPTS = { reversalCost: 50000, reversalShare: 0.5 };

/** Bus stops in small towns can be a few km from the nearest secondary road; the gap becomes a stub. */
export const ROAD_ROUTER_OPTS = { snapRadius: 5000, snapSlack: 300, minComponent: 20000 };

/** Candidate graph files for a kind: option, env, <workDir>/geometry/, <workDir>/assets/<kind>/. */
function graphFiles(kind: GraphKind, opts: BuildOptions): string[] {
  const opt = kind === 'rail' ? opts.railGraph : opts.roadGraph;
  const env = process.env[kind === 'rail' ? 'ETBM_RAIL_GRAPH' : 'ETBM_ROAD_GRAPH'];
  const name = graphFileName(kind);
  return [opt, env, join(opts.workDir, 'geometry', name), join(opts.workDir, 'assets', kind, name)].filter((f): f is string => !!f);
}

/** Load a routing graph: prebuilt binary if present, else (unless noExtract) extract Overture. */
export async function loadRouter(opts: BuildOptions, kind: GraphKind = 'rail'): Promise<Router | null> {
  const { log } = opts;
  const t0 = Date.now();
  const files = graphFiles(kind, opts);
  const file = files.find((f) => existsSync(f));
  const ropts = kind === 'road' ? ROAD_ROUTER_OPTS : RAIL_ROUTER_OPTS;
  const what = kind === 'rail' ? 'rail corridors' : 'coach/bus corridors';
  try {
    if (file) {
      const { graph, header } = deserializeRailGraph(readFileSync(file));
      log(`geometry: ${kind} graph ${file} (Overture ${header.release}, built ${header.created}) loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${graph.nodeCount} nodes, ${graph.edgeCount} edges, ${(graphBytes(graph) / 1e6).toFixed(0)} MB`);
      if (header.coverage !== COVERAGE_ID) {
        log(`geometry: WARNING ${kind} graph covers ${header.coverage ?? 'the Europe-only box'}, not ${COVERAGE_ID} — ${what} outside it will be unsnapped curves (run the refresh-assets workflow with only=rail,urbanrail,road)`);
      }
      return new Router(graph, ropts);
    }
    if (opts.noExtract) {
      log(`geometry: WARNING no ${kind} graph (${files[0]}; set ETBM_${kind.toUpperCase()}_GRAPH or run the assets refresh) — ${what} will be unsnapped curves`);
      return null;
    }
    log(`geometry: WARNING no ${kind} graph at ${files[0]} — extracting Overture ${kind} now (slow, ~15-30 min; prebuild with the assets refresh)`);
    const g = kind === 'rail'
      ? await loadRailGraph(await ensureRailExtract(opts.workDir, log), opts.workDir, log, RAIL_SIMPLIFY_TOL)
      : pruneGraph(await loadRoadGraph(await ensureRoadExtract(opts.workDir, log), opts.workDir, log, { simplifyTol: ROAD_SIMPLIFY_TOL }), ROAD_MIN_COMPONENT);
    log(`geometry: ${kind} graph ready in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${(graphBytes(g) / 1e6).toFixed(0)} MB`);
    return new Router(g, ropts);
  } catch (e) {
    log(`geometry: WARNING ${kind} graph unavailable, ${what} will be unsnapped curves (${String(e).slice(0, 300)})`);
    return null;
  }
}

export async function buildGeometries(reqs: GeometryRequest[], opts: BuildOptions): Promise<GeometryResult[]> {
  const rail = reqs.some((r) => r.mode === 'rail') ? await loadRouter(opts, 'rail') : null;
  const road = reqs.some((r) => r.mode === 'road') ? await loadRouter(opts, 'road') : null;
  return buildWithRouter(reqs, rail, opts.log, road);
}

/** Same as buildGeometries but with ready routers (tests / demo). */
export function buildWithRouter(
  reqs: GeometryRequest[], router: Router | null, log: (s: string) => void = () => {}, roadRouter: Router | null = null,
): GeometryResult[] {
  const t0 = Date.now();
  const cache = new Map<string, RouteResult | null>();
  const roadCache = new Map<string, RouteResult | null>();
  const counts: Counts = { rail: 0, routed: 0, guided: 0, shape: 0, usage: 0, offHs: 0, railRoad: 0, fallback: 0, road: 0, roadShape: 0, roadRouted: 0, roadFallback: 0 };
  const hs = router ? highSpeedEdges(router.g) : null;
  const routedRail: RoutedRail[] = [];
  const out: GeometryResult[] = [];
  let lastLog = Date.now();
  let tRoad = 0;
  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i]!;
    let res: GeometryResult;
    // two stops a few tens of metres apart (two platforms, a bay and the entrance): a plain short line
    if (dist(r.a, r.b) < TRIVIAL_M) {
      out.push({ id: r.id, coords: roundCoords([r.a, r.b]), snapped: true });
      continue;
    }
    try {
      if (r.mode === 'rail') res = railGeometry(r, router, hs, cache, counts, roadRouter, roadCache, (x, route) => routedRail.push({ ...x, i: out.length, edges: Int32Array.from(route.edges), coords: x.guided || x.gc < USAGE_MIN_HOP ? undefined : route.coords }));
      else {
        const t = performance.now();
        res = roadGeometry(r, roadRouter, roadCache, counts);
        tRoad += performance.now() - t;
      }
    } catch (e) {
      log(`geometry: request ${r.id} failed (${String(e).slice(0, 200)}), using fallback`);
      res = { id: r.id, coords: finish(gentleCurve(r.a, r.b, 0), 0), snapped: false };
    }
    out.push(res);
    if (Date.now() - lastLog > 30000) {
      lastLog = Date.now();
      log(`geometry: ${i + 1}/${reqs.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
  }
  if (router) rerouteByUsage(router, hs!, routedRail, out, counts, log);
  const s = (Date.now() - t0) / 1000;
  log(`geometry: ${reqs.length} corridors in ${s.toFixed(1)} s — rail ${counts.rail} (routed ${counts.routed}, along feed shape ${counts.guided}, shape ${counts.shape}, moved to busier track ${counts.usage}, kept off high-speed lines ${counts.offHs}, on roads ${counts.railRoad}, approximate ${counts.fallback}), road ${counts.road} (routed ${counts.roadRouted}, shape ${counts.roadShape}, fallback ${counts.roadFallback}; ${(tRoad / 1000).toFixed(1)} s)`);
  return out;
}

type Counts = { rail: number; routed: number; guided: number; shape: number; usage: number; offHs: number; railRoad: number; fallback: number; road: number; roadShape: number; roadRouted: number; roadFallback: number };

/** A rail corridor drawn from a graph route in pass one (re-routed by track usage in pass two). */
interface RoutedRail {
  i: number; r: GeometryRequest; from: LonLat; to: LonLat; gc: number; guided: boolean;
  /** a conventional train: high-speed lines stay expensive in pass two as well (guide.ts) */
  avoidHs?: boolean;
  edges: Int32Array;
  /** pass-one path, kept only for hops that pass two may re-route */
  coords?: LonLat[];
}

/**
 * Pass two: re-route long rail hops without a guiding shape with lightly used track made more
 * expensive (guide.ts), so non-stop trains stay on the main lines that the stopping trains of
 * pass one mark (Berlin → Brno via Pardubice, Hamburg → København via Jutland). Conventional
 * trains kept off high-speed lines in pass one keep them expensive here too.
 */
function rerouteByUsage(router: Router, hs: Uint8Array, routed: RoutedRail[], out: GeometryResult[], counts: Counts, log: (s: string) => void): void {
  if (!routed.some((x) => (x.r.tpd ?? 0) > 0)) return;
  const t0 = Date.now();
  const usage = new TrackUsage(router.g);
  const share = (x: RoutedRail) => {
    const long = x.r.tpdLong ?? 0;
    return [long, Math.max(0, (x.r.tpd ?? 0) - long)] as const;
  };
  for (const x of routed) usage.add(x.edges, ...share(x));
  usage.spread();
  const t1 = Date.now();
  for (const x of routed) {
    if (!x.coords) continue;
    const um = usage.multFor(x.edges, ...share(x), x.gc);
    const re = x.avoidHs
      ? router.route(x.from, x.to, MAX_DETOUR(x.gc), { edgeMult: (e) => um(e) * (hs[e] ? HS_AVOID_MULT : 1), maxMult: USAGE_MAX_MULT * HS_AVOID_MULT })
      : router.route(x.from, x.to, MAX_DETOUR(x.gc), { edgeMult: um, maxMult: USAGE_MAX_MULT });
    if (!re || coverage(re.coords, x.coords) >= 0.95) continue;
    counts.usage++;
    out[x.i] = { id: x.r.id, coords: finish(attach(x.r.a, re.coords, x.r.b, x.r.anchored), 1), snapped: true };
  }
  log(`geometry: track usage of ${routed.length} routed rail hops (${((t1 - t0) / 1000).toFixed(1)} s), ${counts.usage} long hops moved to busier track (${((Date.now() - t1) / 1000).toFixed(1)} s)`);
}

function orient(h: GeometryRequest['hops'][number], a: LonLat, b: LonLat) {
  if (dist(h.from, a) + dist(h.to, b) <= dist(h.from, b) + dist(h.to, a)) return h;
  return { from: h.to, to: h.from, shape: h.shape ? h.shape.slice().reverse() : undefined };
}

/** A feed shape is used only if it ends near the stations, isn't a wild detour and has real detail. */
function plausibleShape(h: { from: LonLat; to: LonLat; shape?: LonLat[] }): LonLat[] | null {
  const s = h.shape;
  if (!s || s.length < 2) return null;
  const gc = dist(h.from, h.to);
  if (dist(s[0]!, h.from) > 1000 || dist(s[s.length - 1]!, h.to) > 1000) return null;
  const len = polylineLength(s);
  if (len > 2 * gc + 2000) return null;
  // a shape that is just the straight stop-to-stop line adds nothing
  if (s.length < Math.max(4, gc / 5000)) return null;
  return s;
}

const key = (p: LonLat, q: LonLat) => `${p[0].toFixed(4)},${p[1].toFixed(4)};${q[0].toFixed(4)},${q[1].toFixed(4)}`;

function railGeometry(
  r: GeometryRequest, router: Router | null, hs: Uint8Array | null, cache: Map<string, RouteResult | null>, counts: Counts,
  roadRouter: Router | null = null, roadCache: Map<string, RouteResult | null> = new Map(),
  onRouted: (x: Omit<RoutedRail, 'i' | 'edges' | 'coords'>, route: RouteResult) => void = () => {},
): GeometryResult {
  counts.rail++;
  let shapeFallback: LonLat[] | null = null;
  for (const raw of r.hops.slice(0, 3)) {
    const h = orient(raw, r.a, r.b);
    const shape = plausibleShape(h);
    const gc = dist(h.from, h.to);
    // A feed shape drawn on the track is the real path (Praha → Brno via Pardubice, not across a
    // shorter branch line): route along it, so the line keeps the graph's exact track geometry.
    if (router && shape && gc > 30 && onTrack(router.g, shape) >= SHAPE_ON_TRACK) {
      const guided = router.route(h.from, h.to, MAX_DETOUR(gc), { edgeMult: shapeEdgeMult(router.g, shape), maxMult: OFF_SHAPE_MULT });
      if (guided && coverage(shape, guided.coords) >= SHAPE_COVERED) {
        counts.guided++;
        onRouted({ r, from: h.from, to: h.to, gc, guided: true }, guided);
        return { id: r.id, coords: finish(attach(r.a, guided.coords, r.b, r.anchored), 1), snapped: true };
      }
      counts.shape++;
      return { id: r.id, coords: finish(attach(r.a, simplify(shape, SHAPE_TOL), r.b, r.anchored), 1), snapped: true };
    }
    let routed: RouteResult | null = null;
    if (router && gc > 30) {
      const k = key(h.from, h.to), kr = key(h.to, h.from);
      if (cache.has(k)) routed = cache.get(k)!;
      else if (cache.has(kr)) {
        const c = cache.get(kr)!;
        routed = c && { ...c, coords: c.coords.slice().reverse(), snapA: c.snapB, snapB: c.snapA, edges: c.edges.slice().reverse() };
      } else {
        routed = router.route(h.from, h.to, MAX_DETOUR(gc));
        cache.set(k, routed);
      }
    }
    if (routed) {
      if (shape && routed.length > 1.3 * polylineLength(shape)) {
        counts.shape++;
        return { id: r.id, coords: finish(attach(r.a, simplify(shape, SHAPE_TOL), r.b, r.anchored), 1), snapped: true };
      }
      let avoidHs = false;
      if (router && hs) {
        // High-speed lines are cheap in the graph: keep conventional trains (night trains, TER,
        // Intercités, RE) off them unless their timetable needs them (guide.ts).
        const hsLen = hsLength(router.g, hs, routed.edges);
        if (usesHs(hsLen, routed.length)) {
          if (!highSpeedHop(r) || avoidHighSpeed(r, 0, routed.length)) {
            const alt = router.route(h.from, h.to, MAX_DETOUR(gc), { edgeMult: hsAvoidMult(hs), maxMult: HS_AVOID_MULT });
            if (alt && hsLength(router.g, hs, alt.edges) < 0.5 * hsLen && avoidHighSpeed(r, alt.length, routed.length)) {
              routed = alt;
              avoidHs = true;
              counts.offHs++;
            }
          }
        } else avoidHs = !highSpeedHop(r) && avoidHighSpeed(r, routed.length, routed.length);
      }
      counts.routed++;
      onRouted({ r, from: h.from, to: h.to, gc, guided: false, avoidHs }, routed);
      return { id: r.id, coords: finish(attach(r.a, routed.coords, r.b, r.anchored), 1), snapped: true };
    }
    if (shape && !shapeFallback) shapeFallback = shape;
  }
  if (shapeFallback) {
    counts.shape++;
    return { id: r.id, coords: finish(attach(r.a, simplify(shapeFallback, SHAPE_TOL), r.b, r.anchored), 1), snapped: true };
  }
  // Not on any track of the rail graph (a stop far from the railway, a tram-train, a rail replacement bus):
  // follow the road network if the stations are connected by it, else an approximate alignment (drawn dashed).
  if (roadRouter) {
    for (const raw of r.hops.slice(0, 3)) {
      const h = orient(raw, r.a, r.b);
      const gc = dist(h.from, h.to);
      if (gc <= 30) continue;
      const routed = cachedRoute(roadRouter, roadCache, h.from, h.to, MAX_DETOUR(gc));
      if (routed) {
        counts.railRoad++;
        return { id: r.id, coords: finish(attach(r.a, routed.coords, r.b, r.anchored), 3), snapped: true };
      }
    }
  }
  counts.fallback++;
  const [from, to] = curveEnds(r);
  return { id: r.id, coords: finish(attach(r.a, gentleCurve(from, to, 0), r.b, r.anchored), 0), snapped: false };
}

/** End points of an unsnapped curve: the stations of the main hop (so it starts where the line really does). */
function curveEnds(r: GeometryRequest): [LonLat, LonLat] {
  const h = r.hops[0];
  if (!h || !r.anchored) return [r.a, r.b];
  const o = orient(h, r.a, r.b);
  return [o.from, o.to];
}

function roadGeometry(r: GeometryRequest, router: Router | null, cache: Map<string, RouteResult | null>, counts: Counts): GeometryResult {
  counts.road++;
  const hops = r.hops.slice(0, 3).map((h) => orient(h, r.a, r.b));
  // a plausible feed shape is the real bus path: prefer it
  for (const h of hops) {
    const shape = plausibleShape(h);
    if (shape) {
      counts.roadShape++;
      return { id: r.id, coords: finish(attach(r.a, simplify(shape, SHAPE_TOL), r.b, r.anchored), 2), snapped: true };
    }
  }
  if (router) {
    // stops of the representative hops, else the city points themselves
    const tries = hops.length ? hops.map((h) => [h.from, h.to] as const) : [[r.a, r.b] as const];
    for (const [from, to] of tries) {
      const gc = dist(from, to);
      if (gc < 30) continue;
      const routed = cachedRoute(router, cache, from, to, MAX_DETOUR(gc));
      if (routed) {
        counts.roadRouted++;
        return { id: r.id, coords: finish(attach(r.a, routed.coords, r.b, r.anchored), 3), snapped: true };
      }
    }
  }
  counts.roadFallback++;
  // bulge to the left of west→east, so a↔b and b↔a give the same curve
  const [from, to] = curveEnds(r);
  const sign = from[0] < to[0] || (from[0] === to[0] && from[1] < to[1]) ? 1 : -1;
  return { id: r.id, coords: finish(attach(r.a, gentleCurve(from, to, sign * ROAD_BULGE), r.b, r.anchored), 0), snapped: false };
}

/** Route with a per-run cache keyed by the (~10 m rounded) endpoint pair, in both directions. */
function cachedRoute(router: Router, cache: Map<string, RouteResult | null>, from: LonLat, to: LonLat, maxLen: number): RouteResult | null {
  const k = key(from, to), kr = key(to, from);
  if (cache.has(k)) return cache.get(k)!;
  if (cache.has(kr)) {
    const c = cache.get(kr)!;
    return c && { ...c, coords: c.coords.slice().reverse(), snapA: c.snapB, snapB: c.snapA };
  }
  const r = router.route(from, to, maxLen);
  cache.set(k, r);
  return r;
}

/**
 * Join city point a → path → city point b. The path is trimmed to its closest approach to the
 * city point (searched within the first / last 35 % of its length), so a line never runs past
 * the city dot and back; the remaining gap becomes a straight stub that smoothing rounds off.
 */
export function attach(a: LonLat, path: readonly LonLat[], b: LonLat, anchored = false): LonLat[] {
  let P = dedupe(path);
  if (P.length < 2) return [a, b];
  if (anchored) {
    // City points are stations: trim only a run past the city's station and keep the line's own end
    // station. A line ends where it really ends: it is only joined to the city point by a (short)
    // straight stub, never by a long one — big cities with several terminals would otherwise be a
    // starburst of straight lines into one point (the city dot is just a marker).
    P = trimStart(a, P, PASS_M);
    P = trimStart(b, P.slice().reverse(), PASS_M).reverse();
    P = stub(a, P);
    P = stub(b, P.slice().reverse()).reverse();
    return dedupe(P);
  }
  P = trimStart(a, P);
  P = trimStart(b, P.slice().reverse()).reverse();
  P = lead(a, P);
  P = lead(b, P.slice().reverse()).reverse();
  return dedupe(P);
}

/** A line passing within this distance (m) of an anchored city point is cut there. */
const PASS_M = 300;
/**
 * Longest straight stub (m) from a city point to a line's own end station (same rule for every
 * city). Farther away, the line simply ends at its terminal and the city dot stays a separate marker.
 */
export const STUB_MAX_M = 1000;

/** Prefix the path with point a: snapped onto it when close, else a short straight stub, else nothing. */
function stub(a: LonLat, P: LonLat[]): LonLat[] {
  const d = dist(a, P[0]!);
  if (d < 40) return [a, ...P.slice(1)];
  return d <= STUB_MAX_M ? [a, ...P] : P;
}

/**
 * Prefix the path with city point a. A short gap is a straight stub; when the stub would make a
 * sharp turn into the path (city dot "behind" the station) a cubic Bézier leaves a and merges
 * tangentially into the path further along, so there is no hook.
 */
function lead(a: LonLat, P: LonLat[]): LonLat[] {
  const d = dist(a, P[0]!);
  if (d < 40) return [a, ...P.slice(1)];
  const total = polylineLength(P);
  const { kx, ky } = mPerDeg(a[1]);
  const toM = (p: LonLat): [number, number] => [(p[0] - a[0]) * kx, (p[1] - a[1]) * ky];
  const toLL = (x: number, y: number): LonLat => [a[0] + x / kx, a[1] + y / ky];
  // path direction near its start
  const ahead = pointAt(P, Math.min(300, total / 2));
  const [sx, sy] = toM(P[0]!), [hx, hy] = toM(ahead.p);
  const tx = hx - sx, ty = hy - sy;
  const cos = (sx * tx + sy * ty) / ((Math.hypot(sx, sy) || 1) * (Math.hypot(tx, ty) || 1));
  if (cos > 0.5) return [a, ...P]; // turn < 60°: plain stub, smoothing rounds it
  // city dot behind the station: join the path further on, where a stub meets it at a gentle angle
  const lim = Math.min(0.35 * total, 6000);
  for (let s = 100; s <= lim; s += 100) {
    const q = pointAt(P, s), q2 = pointAt(P, Math.min(total, s + 200));
    const [qx, qy] = toM(q.p), [rx, ry] = toM(q2.p);
    const dq = Math.hypot(qx, qy);
    if (dq > Math.max(2.5 * d, 1500)) continue;
    const c = (qx * (rx - qx) + qy * (ry - qy)) / ((dq || 1) * (Math.hypot(rx - qx, ry - qy) || 1));
    if (c > 0.75) return [...bezierJoin(q.p, pointAt(P, Math.max(0, s - 200)).p), q.p, ...P.slice(q.k + 1)];
  }
  // merge point: far enough along that the curve can turn gently
  const m = pointAt(P, Math.min(0.3 * total, Math.max(2 * d, 800)));
  const back = pointAt(P, Math.max(0, m.s - 300));
  return [...bezierJoin(m.p, back.p), m.p, ...P.slice(m.k + 1)];

  /** cubic Bézier from a to p (exclusive), arriving tangent to the direction back→p */
  function bezierJoin(p: LonLat, back: LonLat): LonLat[] {
    const [mx, my] = toM(p), [bx, by] = toM(back);
    const tl = Math.hypot(mx - bx, my - by) || 1;
    const L = Math.hypot(mx, my);
    const c2x = mx - ((mx - bx) / tl) * (L / 2.5), c2y = my - ((my - by) / tl) * (L / 2.5);
    const c1x = c2x / 3, c1y = c2y / 3;
    const out: LonLat[] = [];
    const n = Math.max(4, Math.min(16, Math.ceil(L / 150)));
    for (let i = 0; i < n; i++) {
      const t = i / n, u = 1 - t;
      out.push(toLL(3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * mx, 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * my));
    }
    return out;
  }
}

/** Point at distance s along P; k = index of the vertex before it. */
function pointAt(P: LonLat[], s: number): { p: LonLat; k: number; s: number } {
  let cum = 0;
  for (let k = 0; k < P.length - 1; k++) {
    const l = dist(P[k]!, P[k + 1]!);
    if (cum + l >= s) {
      const t = l > 0 ? (s - cum) / l : 0;
      return { p: [P[k]![0] + t * (P[k + 1]![0] - P[k]![0]), P[k]![1] + t * (P[k + 1]![1] - P[k]![1])], k, s };
    }
    cum += l;
  }
  return { p: P[P.length - 1]!, k: P.length - 2, s: cum };
}

/** Cut P at its closest approach to a (within the first 35 %); with maxDist, only if it comes that close. */
function trimStart(a: LonLat, P: LonLat[], maxDist = Infinity): LonLat[] {
  const total = polylineLength(P);
  const lim = 0.35 * total;
  const { kx, ky } = mPerDeg(a[1]);
  let best = Infinity, bk = 0, bt = 0, cum = 0;
  for (let k = 0; k < P.length - 1 && cum <= lim; k++) {
    const p = P[k]!, q = P[k + 1]!;
    const ax = (p[0] - a[0]) * kx, ay = (p[1] - a[1]) * ky;
    const dx = (q[0] - p[0]) * kx, dy = (q[1] - p[1]) * ky;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const segLen = Math.sqrt(l2);
    if (cum + t * segLen > lim) t = Math.max(0, (lim - cum) / (segLen || 1));
    const d = Math.hypot(ax + t * dx, ay + t * dy) + 0.05 * (cum + t * segLen);
    if (d < best) { best = d; bk = k; bt = t; }
    cum += segLen;
  }
  if (bk === 0 && bt === 0) return P;
  const p = P[bk]!, q = P[bk + 1]!;
  const start: LonLat = [p[0] + bt * (q[0] - p[0]), p[1] + bt * (q[1] - p[1])];
  if (dist(a, start) > maxDist) return P;
  const rest = P.slice(bt >= 1 ? bk + 2 : bk + 1);
  return dedupe([start, ...rest]);
}

/** Smooth + round. style 0 = already smooth curve, 1 = rail (stay on track), 2 = feed shape (road), 3 = road graph. */
function finish(c: LonLat[], style: 0 | 1 | 2 | 3): [number, number][] {
  if (style === 1) c = smooth(c, { iterations: 2, maxCut: 120, minTurnDeg: [6, 20] });
  else if (style === 2) c = smooth(c, { iterations: 2, maxCut: 200, minTurnDeg: 4 });
  else if (style === 3) c = smooth(c, { iterations: 2, maxCut: 120, minTurnDeg: [6, 20] });
  return roundCoords(c);
}

export type { RailGraph };
export { Router } from './route.ts';
