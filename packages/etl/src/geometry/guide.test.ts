import { describe, expect, it } from 'vitest';
import { RailGraphBuilder } from './graph.ts';
import { Router } from './route.ts';
import { buildWithRouter, type GeometryRequest } from './index.ts';
import { dist, polylineLength, type LonLat } from './geo.ts';
import { TrackUsage, USAGE_MAX_MULT, coverage, onTrack, resample, shapeEdgeMult, usageMult } from './guide.ts';

/** Points every ~100 m through the given corners. */
function pts(...c: LonLat[]): LonLat[] {
  const out: LonLat[] = [];
  for (let i = 0; i < c.length - 1; i++) {
    const a = c[i]!, b = c[i + 1]!;
    const n = Math.max(1, Math.round(dist(a, b) / 100));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}
const flat = (p: LonLat[]) => p.flat();

/**
 * X(0,50) ── straight "branch" ── Y(1,50)                      (≈72 km, shortest)
 * X ── M1(0.25,50.075) ── M2(0.5,50.15) ── M3(0.75,50.075) ── Y  (≈79 km, the main line)
 * plus a stub of track beyond X and beyond Y
 */
const MAIN: LonLat[] = [[0, 50], [0.25, 50.075], [0.5, 50.15], [0.75, 50.075], [1, 50]];
function twoLines(parallel = false) {
  const b = new RailGraphBuilder();
  b.addLine(flat(pts([0, 50], [1, 50])));
  // lines continue beyond X and Y (so both are junctions)
  b.addLine(flat(pts([-0.1, 50], [0, 50])));
  b.addLine(flat(pts([1, 50], [1.1, 50])));
  for (let i = 0; i + 1 < MAIN.length; i++) b.addLine(flat(pts(MAIN[i]!, MAIN[i + 1]!)));
  // second track of the main line between M1 and M2, 20 m to the north, joined at both ends
  if (parallel) b.addLine(flat(pts(MAIN[1]!, [0.2502, 50.0752], [0.4998, 50.1502], MAIN[2]!)));
  return b.build({ simplifyTol: 5 });
}

describe('guide helpers', () => {
  it('resample places points every step along the line, ends included', () => {
    const line: LonLat[] = [[0, 50], [0.1, 50]];
    const r = resample(line, 1000);
    const len = polylineLength(line);
    expect(r.length).toBe(Math.ceil(len / 1000) + 1);
    expect(r[0]).toEqual([0, 50]);
    expect(r[r.length - 1]).toEqual([0.1, 50]);
    for (let i = 1; i < r.length - 1; i++) expect(dist(r[i - 1]!, r[i]!)).toBeCloseTo(1000, 0);
  });
  it('coverage measures how much of a line runs along another', () => {
    const a = pts([0, 50], [1, 50]);
    expect(coverage(a, a)).toBe(1);
    expect(coverage(a, pts([0, 50.001], [1, 50.001]))).toBe(1); // 111 m apart
    expect(coverage(a, pts([0, 50.01], [1, 50.01]))).toBe(0); // 1.1 km apart
    expect(coverage(a, pts([0, 50], [0.5, 50]))).toBeCloseTo(0.5, 1);
  });
  it('usageMult falls from the maximum for unused track to 1 for busy track', () => {
    expect(usageMult(0)).toBe(USAGE_MAX_MULT);
    expect(usageMult(10)).toBeLessThan(usageMult(1));
    expect(usageMult(100)).toBeLessThan(usageMult(10));
    expect(usageMult(1e6)).toBe(1);
  });
  it('onTrack tells shapes drawn on the track from chords', () => {
    const g = twoLines();
    expect(onTrack(g, pts(...MAIN))).toBe(1);
    expect(onTrack(g, pts([0, 50], [0.5, 50.3], [1, 50]))).toBeLessThan(0.2);
  });
  it('shapeEdgeMult makes track away from the shape expensive', () => {
    const g = twoLines();
    const m = shapeEdgeMult(g, pts(...MAIN));
    const mults = Array.from({ length: g.edgeCount }, (_, e) => m(e));
    // the straight line is off the shape, the main line on it
    expect(Math.max(...mults)).toBeGreaterThan(3.5);
    expect(Math.min(...mults)).toBeLessThan(1.1);
  });
  it('spread gives parallel track the usage of the track next to it', () => {
    const g = twoLines(true);
    const r = new Router(g);
    const res = r.route([0.26, 50.078], [0.49, 50.147], 1e5)!;
    const u = new TrackUsage(g);
    u.add(res.edges, 10, 0);
    const before = Array.from(u.long).filter((v) => v > 0).length;
    u.spread();
    expect(Array.from(u.long).filter((v) => v > 0).length).toBeGreaterThan(before);
  });
});

describe('rail routes follow the track trains use', () => {
  const g = twoLines();
  const router = new Router(g);
  const north = (c: [number, number][]) => Math.max(...c.map((p) => p[1]));
  const long: GeometryRequest = { id: 1, mode: 'rail', a: [0.02, 50], b: [0.98, 50], anchored: true, hops: [{ from: [0.02, 50], to: [0.98, 50] }], tpd: 10, tpdLong: 10 };
  // stopping trains on the main line: short hops, little choice
  const stops: GeometryRequest[] = [];
  for (let i = 0; i + 1 < MAIN.length; i++) {
    const from = MAIN[i]!, to = MAIN[i + 1]!;
    stops.push({ id: 10 + i, mode: 'rail', a: from, b: to, anchored: true, hops: [{ from, to }], tpd: 80, tpdLong: 40 });
  }

  it('without other information a non-stop hop takes the shortest track', () => {
    const [res] = buildWithRouter([long], router);
    expect(north(res!.coords)).toBeLessThan(50.01);
  });
  it('a feed shape on the track guides the route even when it is longer', () => {
    const shape = pts([0.02, 50.006], ...MAIN.slice(1, -1), [0.98, 50.006]);
    const [res] = buildWithRouter([{ ...long, tpd: 0, tpdLong: 0, hops: [{ ...long.hops[0]!, shape }] }], router);
    expect(north(res!.coords)).toBeGreaterThan(50.14);
    // the result follows the graph's track, not the shape's own vertices
    expect(coverage(res!.coords, pts(...MAIN), 30)).toBeGreaterThan(0.95);
  });
  it('a long non-stop hop moves to the line the stopping trains use', () => {
    const res = buildWithRouter([long, ...stops], router);
    expect(north(res[0]!.coords)).toBeGreaterThan(50.14);
    // the stopping trains themselves stay where they are
    expect(north(res[3]!.coords)).toBeGreaterThan(50.14);
  });
  it('stays on the shortest track when that is the busy one', () => {
    const branchStops: GeometryRequest[] = [0, 0.25, 0.5, 0.75].map((x, i) => ({
      id: 20 + i, mode: 'rail', a: [x, 50], b: [x + 0.25, 50], anchored: true, hops: [{ from: [x, 50] as LonLat, to: [x + 0.25, 50] as LonLat }], tpd: 80, tpdLong: 40,
    }));
    const [res] = buildWithRouter([long, ...branchStops], router);
    expect(north(res!.coords)).toBeLessThan(50.01);
  });
});
