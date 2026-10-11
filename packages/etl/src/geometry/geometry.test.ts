import { describe, expect, it } from 'vitest';
import { RailGraphBuilder } from './graph.ts';
import { Router } from './route.ts';
import { attach, buildGeometries, buildWithRouter, type GeometryRequest } from './index.ts';
import { deserializeRailGraph, pruneGraph, readRailHeader, serializeRailGraph } from './railbin.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dist, gentleCurve, polylineLength, simplify, smooth, type LonLat } from './geo.ts';

/** Densified line through the given points (vertex every ~100 m), as flat array. */
function line(...pts: LonLat[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    const n = Math.max(1, Math.round(dist(a, b) / 100));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) out.push(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n);
  }
  return out;
}

/**
 * Synthetic network around lat 50:
 *   A(0,50) ── J1(0.5,50) ── B(1,50)            straight main line, split into 2 segments at J1
 *   J1 ── C(0.5,50.5)                            branch
 *   A ── D(0.5,49.7) ── B                        slower detour (longer)
 *   F(0.6,50.1) ─ G(0.6,50.2)                    tiny isolated fragment (should be ignored)
 *   E(5,50) ─ H(5.5,50)                          separate island
 */
function synthetic() {
  const b = new RailGraphBuilder();
  b.addLine(line([0, 50], [0.25, 50]));
  b.addLine(line([0.25, 50], [0.5, 50])); // end-to-end join → contracted
  b.addLine(line([0.5, 50], [1, 50]));
  b.addLine(line([0.5, 50], [0.5, 50.5]));
  b.addLine(line([0, 50], [0.5, 49.7], [1, 50]));
  b.addLine(line([0.6, 50.1], [0.6, 50.12]));
  b.addLine(line([5, 50], [5.5, 50]));
  return b.build({ simplifyTol: 15 });
}

describe('graph building', () => {
  const g = synthetic();
  it('contracts degree-2 chains and keeps junctions', () => {
    // A and B have degree 2 (main line + detour), the 0.25 joint too: all contracted. The loop
    // J1→B→D→A→J1 is split at a boundary node (B) so it isn't lost.
    // nodes: J1, B, C, E, H, F, G
    expect(g.nodeCount).toBe(7);
    // edges: J1-B, B-(D)-A-J1, J1-C, F-G, E-H
    expect(g.edgeCount).toBe(5);
    const lens = Array.from(g.edgeLen).map((l) => Math.round(l / 1000)).sort((a, b) => a - b);
    expect(lens).toEqual([2, 36, 36, 56, 134]);
  });
  it('simplifies straight geometry to its end points', () => {
    for (let e = 0; e < g.edgeCount; e++) {
      const n = g.geoStart[e + 1]! - g.geoStart[e]!;
      expect(n).toBeLessThanOrEqual(4); // corners at D and A only
    }
  });
  it('labels components', () => {
    expect(new Set(Array.from(g.comp)).size).toBe(3);
  });
});

describe('routing', () => {
  const g = synthetic();
  const r = new Router(g, { minComponent: 3000 });
  it('takes the shortest path between snapped stations', () => {
    const res = r.route([0.1, 50.003], [0.9, 49.998], 200000)!;
    expect(res).not.toBeNull();
    expect(res.length / 1000).toBeCloseTo(57.3, 0);
    expect(res.coords.every((c) => Math.abs(c[1] - 50) < 1e-6)).toBe(true);
    expect(res.snapA).toBeGreaterThan(300);
    expect(res.snapA).toBeLessThan(400);
  });
  it('routes onto a branch through the junction', () => {
    const res = r.route([0.1, 50], [0.5, 50.4], 200000)!;
    expect(res.length / 1000).toBeCloseTo(28.6 + 44.5, 0);
  });
  it('handles both stations on the same edge, in either direction', () => {
    const f = r.route([0.6, 50], [0.8, 50], 100000)!;
    const b = r.route([0.8, 50], [0.6, 50], 100000)!;
    expect(f.length).toBeCloseTo(b.length, 3);
    expect(f.coords[0]![0]).toBeCloseTo(0.6, 5);
    expect(b.coords[0]![0]).toBeCloseTo(0.8, 5);
  });
  it('ignores tiny fragments and fails between components', () => {
    const s = r.snap([0.6, 50.11]);
    expect(s.every((c) => g.compSize[g.comp[g.edgeU[c.edge]!]!]! >= 3000)).toBe(true);
    expect(r.route([0.1, 50], [5.2, 50], 1e6)).toBeNull();
  });
  it('respects the detour bound', () => {
    expect(r.route([0.1, 50], [0.9, 50], 30000)).toBeNull();
  });
  it('fails when nothing is within the snap radius', () => {
    expect(r.route([0.1, 51], [0.9, 50], 1e6)).toBeNull();
  });
});

describe('buildWithRouter', () => {
  const g = synthetic();
  const router = new Router(g);
  it('produces snapped rail lines from city to city', () => {
    const reqs: GeometryRequest[] = [
      { id: 7, mode: 'rail', a: [0.11, 50.01], b: [0.89, 50.01], hops: [{ from: [0.1, 50.001], to: [0.9, 50.001] }] },
      // reversed hop orientation is fixed automatically, result identical on shared track
      { id: 8, mode: 'rail', a: [0.89, 50.01], b: [0.11, 50.01], hops: [{ from: [0.1, 50.001], to: [0.9, 50.001] }] },
      // unroutable → fallback curve
      { id: 9, mode: 'rail', a: [0.1, 50], b: [5.2, 50], hops: [{ from: [0.1, 50], to: [5.2, 50] }] },
      { id: 10, mode: 'road', a: [0, 50], b: [1, 50], hops: [] },
    ];
    const res = buildWithRouter(reqs, router);
    expect(res.map((r) => r.id)).toEqual([7, 8, 9, 10]);
    expect(res[0]!.snapped).toBe(true);
    expect(res[0]!.coords[0]).toEqual([0.11, 50.01]);
    expect(res[0]!.coords[res[0]!.coords.length - 1]).toEqual([0.89, 50.01]);
    const onTrack = res[0]!.coords.filter((c) => c[1] === 50);
    expect(onTrack.length).toBeGreaterThan(0);
    expect(res[1]!.coords.slice().reverse()).toEqual(res[0]!.coords);
    expect(res[2]!.snapped).toBe(false);
    const road = res[3]!;
    expect(road.snapped).toBe(false);
    // bulges north (left of west→east) by ~5 %
    const maxLat = Math.max(...road.coords.map((c) => c[1]));
    expect(maxLat).toBeGreaterThan(50.015);
    expect(maxLat).toBeLessThan(50.04);
    for (const r of res) for (const c of r.coords) expect(c.every((v) => Math.round(v * 1e5) / 1e5 === v)).toBe(true);
  });
  it('uses a plausible feed shape when routing fails', () => {
    const shape: LonLat[] = [];
    for (let i = 0; i <= 100; i++) shape.push([5 + i * 0.04, 50 + 0.05 * Math.sin((i / 100) * Math.PI)]);
    const [res] = buildWithRouter([{ id: 1, mode: 'rail', a: [5, 50], b: [9, 50], hops: [{ from: [5, 50], to: [9, 50], shape }] }], router);
    expect(res!.snapped).toBe(true);
    expect(Math.max(...res!.coords.map((c) => c[1]))).toBeGreaterThan(50.04);
  });
});

describe('geo helpers', () => {
  it('simplify keeps ends and drops collinear points', () => {
    const c: LonLat[] = [[0, 0], [0.001, 0], [0.002, 0.00001], [0.003, 0]];
    expect(simplify(c, 5)).toEqual([[0, 0], [0.003, 0]]);
  });
  it('smooth cuts sharp corners only, keeps endpoints and straight parts', () => {
    const c: LonLat[] = [[0, 0], [0.01, 0], [0.02, 0], [0.02, 0.01]];
    const s = smooth(c);
    expect(s[0]).toEqual([0, 0]);
    expect(s[s.length - 1]).toEqual([0.02, 0.01]);
    expect(s).toContainEqual([0.01, 0]);
    expect(s.length).toBeGreaterThan(c.length);
    expect(polylineLength(s)).toBeLessThan(polylineLength(c));
  });
  it('gentleCurve starts and ends exactly', () => {
    const c = gentleCurve([1, 2], [3, 4], 0.05);
    expect(c[0]).toEqual([1, 2]);
    expect(c[c.length - 1]).toEqual([3, 4]);
  });
  it('attach trims a path that runs past the city point', () => {
    // path starts 5 km west of city a and passes right by it
    const path: LonLat[] = [[-0.07, 50], [0, 50.0005], [0.3, 50], [1, 50]];
    const out = attach([0, 50.001], path, [1, 50.001]);
    expect(out[0]).toEqual([0, 50.001]);
    expect(out.some((p) => p[0] < -0.01)).toBe(false);
  });
});

describe('rail graph file', () => {
  const g = synthetic();
  it('prunes small components and round-trips through the binary format', () => {
    const p = pruneGraph(g, 3000);
    expect(p.edgeCount).toBe(4); // F-G fragment (2 km) dropped
    const buf = serializeRailGraph(p, { release: 'test', bbox: [0, 0, 1, 1], simplifyTol: 15, minComponent: 3000 });
    expect(readRailHeader(buf).header.release).toBe('test');
    const { graph: q } = deserializeRailGraph(buf);
    for (const k of ['nodeX', 'nodeY', 'edgeU', 'edgeV', 'edgeLen', 'edgeCost', 'geoStart', 'geoX', 'geoY'] as const) {
      expect(Array.from(q[k])).toEqual(Array.from(p[k]));
    }
    const a = new Router(p).route([0.1, 50.003], [0.9, 49.998], 2e5)!;
    const b = new Router(q).route([0.1, 50.003], [0.9, 49.998], 2e5)!;
    expect(b.coords).toEqual(a.coords);
  });
  it('buildGeometries loads the file and falls back to curves with noExtract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rail-'));
    const file = join(dir, 'g.bin');
    writeFileSync(file, serializeRailGraph(g, { release: 't', bbox: [0, 0, 1, 1], simplifyTol: 15, minComponent: 0 }));
    const req: GeometryRequest = { id: 1, mode: 'rail', a: [0.11, 50.01], b: [0.89, 50.01], hops: [{ from: [0.1, 50.001], to: [0.9, 50.001] }] };
    const logs: string[] = [];
    const [r1] = await buildGeometries([req], { workDir: dir, log: (s) => logs.push(s), railGraph: file });
    expect(r1!.snapped).toBe(true);
    const [r2] = await buildGeometries([req], { workDir: dir, log: (s) => logs.push(s), railGraph: join(dir, 'missing.bin'), noExtract: true });
    expect(r2!.snapped).toBe(false);
    expect(logs.some((l) => l.includes('WARNING no rail graph'))).toBe(true);
  });
});
