/**
 * Integration demo: routes well-known city pairs on the real Overture rail graph, writes GeoJSON
 * and renders a PNG preview (rail network in grey, corridor in colour).
 *
 *   node --experimental-strip-types src/geometry/demo.ts [workDir] [outDir]
 *
 * workDir defaults to ./work (rail extract cached in workDir/overture), outDir to workDir/geom-demo.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { ensureRailExtract, loadRailGraph } from './overture.ts';
import { graphBytes, Q, querySegments, type RailGraph } from './graph.ts';
import { Router } from './route.ts';
import { buildWithRouter, MAX_DETOUR, type GeometryRequest, type GeometryResult } from './index.ts';
import { dist, polylineLength, type LonLat } from './geo.ts';

interface Pair { name: string; from: LonLat; to: LonLat; a: LonLat; b: LonLat; alt?: [LonLat, LonLat]; mode?: 'rail' | 'road'; expect?: LonLat[] }
const PAIRS: Pair[] = [
  { name: 'Berlin Hbf → Hamburg Hbf', from: [13.3695, 52.5251], to: [10.0067, 53.5528], a: [13.405, 52.52], b: [9.9937, 53.5511] },
  // via the Köln–Rhein/Main high-speed line: passes Montabaur and Limburg Süd
  { name: 'Köln Hbf → Frankfurt(Main) Hbf', from: [6.9589, 50.943], to: [8.663, 50.107], a: [6.9603, 50.9375], b: [8.6821, 50.1109], expect: [[7.8267, 50.4446], [8.0442, 50.3833]] },
  { name: 'Wien Hbf → Salzburg Hbf', from: [16.3752, 48.1852], to: [13.0459, 47.813], a: [16.3738, 48.2082], b: [13.055, 47.8095], expect: [[15.6243, 48.2086], [14.2913, 48.2902]] },
  { name: 'Zürich HB → Bern', from: [8.5402, 47.3782], to: [7.4391, 46.949], a: [8.5417, 47.3769], b: [7.4474, 46.948], expect: [[7.9076, 47.3519]] },
  // LGV Sud-Est: through Le Creusot TGV / Mâcon-Loché TGV area, not via Dijon
  { name: 'Paris Gare de Lyon → Lyon Part-Dieu', from: [2.3733, 48.8443], to: [4.8597, 45.7606], a: [2.3522, 48.8566], b: [4.8357, 45.764], expect: [[4.4983, 46.7653], [4.7790, 46.2830]] },
  // HS1 + Channel Tunnel + LGV Nord
  { name: 'London St Pancras → Paris Nord', from: [-0.1254, 51.532], to: [2.3553, 48.8809], a: [-0.1276, 51.5072], b: [2.3522, 48.8566], expect: [[1.5, 51.03], [2.8325, 49.859]] },
  { name: 'Milano Centrale → Roma Termini', from: [9.2047, 45.4862], to: [12.5018, 41.901], a: [9.19, 45.4642], b: [12.4964, 41.9028], expect: [[11.2475, 43.7764]] },
  { name: 'İstanbul Söğütlüçeşme → Ankara', from: [29.0381, 40.9937], to: [32.8441, 39.9364], a: [28.9784, 41.0082], b: [32.8597, 39.9334], alt: [[28.7826, 41.0168], [32.8441, 39.9364]], expect: [[30.5194, 39.7806]] },
  { name: 'Oslo S → Bergen', from: [10.7522, 59.9111], to: [5.3326, 60.3904], a: [10.7522, 59.9139], b: [5.3221, 60.3913], expect: [[7.5036, 60.6015]] },
  { name: 'København H → Malmö C', from: [12.5649, 55.6728], to: [13.0003, 55.6094], a: [12.5683, 55.6761], b: [13.0038, 55.605], expect: [[12.75, 55.585]] },
  { name: 'Berlin → Dresden (coach curve)', from: [13.3695, 52.5251], to: [13.7323, 51.0403], a: [13.405, 52.52], b: [13.7373, 51.0504], mode: 'road' },
];

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#f032e6', '#9a6324', '#800000', '#000075', '#808000'];

async function main() {
  const workDir = resolve(process.argv[2] ?? 'work');
  const outDir = resolve(process.argv[3] ?? join(workDir, 'geom-demo'));
  mkdirSync(outDir, { recursive: true });
  const log = (s: string) => console.log(s);

  const t0 = Date.now();
  const parquet = await ensureRailExtract(workDir, log);
  const tExtract = Date.now() - t0;
  const g = await loadRailGraph(parquet, workDir, log);
  const tGraph = Date.now() - t0 - tExtract;
  const router = new Router(g);
  log(`extract ${(tExtract / 1000).toFixed(1)} s, graph ${(tGraph / 1000).toFixed(1)} s, ${g.nodeCount} nodes, ${g.edgeCount} edges, ${(graphBytes(g) / 1e6).toFixed(0)} MB typed arrays, rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);

  const reqs: GeometryRequest[] = PAIRS.map((p, id) => ({
    id, mode: p.mode ?? 'rail', a: p.a, b: p.b,
    hops: [{ from: p.from, to: p.to }, ...(p.alt ? [{ from: p.alt[0], to: p.alt[1] }] : [])],
  }));
  const t1 = Date.now();
  const res = buildWithRouter(reqs, router, log);
  log(`demo pairs routed in ${Date.now() - t1} ms`);

  // checks
  let ok = 0;
  const rows: string[] = [];
  res.forEach((r, i) => {
    const p = PAIRS[i]!;
    const len = polylineLength(r.coords);
    const gc = dist(p.from, p.to);
    const misses = (p.expect ?? []).filter((e) => Math.min(...r.coords.map((c) => dist(c, e))) > 6000);
    const good = (p.mode === 'road' || r.snapped) && misses.length === 0;
    if (good) ok++;
    rows.push(`${good ? 'OK ' : 'BAD'} ${p.name.padEnd(36)} snapped=${r.snapped} ${(len / 1000).toFixed(0)} km (gc ${(gc / 1000).toFixed(0)} km, ×${(len / gc).toFixed(2)}) ${r.coords.length} pts${misses.length ? ` misses ${JSON.stringify(misses)}` : ''}`);
  });
  rows.forEach((r) => log(r));
  log(`success ${ok}/${res.length}`);

  // throughput: random station pairs 20–150 km apart drawn from graph nodes in the main component
  const tp = throughput(router, g);
  log(tp);

  writeFileSync(join(outDir, 'demo.geojson'), JSON.stringify({
    type: 'FeatureCollection',
    features: res.map((r, i) => ({ type: 'Feature', properties: { name: PAIRS[i]!.name, snapped: r.snapped }, geometry: { type: 'LineString', coordinates: r.coords } })),
  }));
  await render(g, res, outDir, log);
}

function throughput(router: Router, g: RailGraph): string {
  // pseudo-random but deterministic
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const main = 0; // components are numbered by first node; pick the largest
  let big = main, bs = -1;
  g.compSize.forEach((s, i) => { if (s > bs) { bs = s; big = i; } });
  const nodes: number[] = [];
  for (let i = 0; i < g.nodeCount; i++) if (g.comp[i] === big && rnd() < 0.02) nodes.push(i);
  const pairs: [LonLat, LonLat][] = [];
  while (pairs.length < 2000) {
    const a = nodes[Math.floor(rnd() * nodes.length)]!, b = nodes[Math.floor(rnd() * nodes.length)]!;
    const pa: LonLat = [g.nodeX[a]! / Q + 0.002, g.nodeY[a]! / Q + 0.001], pb: LonLat = [g.nodeX[b]! / Q - 0.001, g.nodeY[b]! / Q + 0.002];
    const d = dist(pa, pb);
    if (d > 20000 && d < 150000) pairs.push([pa, pb]);
  }
  const s0 = router.stats.settled;
  const t = Date.now();
  let found = 0;
  for (const [a, b] of pairs) if (router.route(a, b, MAX_DETOUR(dist(a, b)))) found++;
  const ms = Date.now() - t;
  return `throughput: ${pairs.length} random 20-150 km pairs in ${ms} ms (${(ms / pairs.length).toFixed(2)} ms/route, ${found} found, ${(((router.stats.settled - s0) / pairs.length) | 0)} nodes settled/route)`;
}

async function render(g: RailGraph, res: GeometryResult[], outDir: string, log: (s: string) => void) {
  const W = 560;
  const panels: string[] = [];
  const mx = (lon: number) => (lon + 180) / 360;
  const my = (lat: number) => { const s = Math.sin((lat * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
  const panel = (title: string, focus: { coords: LonLat[]; color: string }[], marks: LonLat[], bbox?: [number, number, number, number]) => {
    const all = focus.flatMap((f) => f.coords).concat(marks);
    let [x0, y0, x1, y1] = bbox ?? [Math.min(...all.map((c) => c[0])), Math.min(...all.map((c) => c[1])), Math.max(...all.map((c) => c[0])), Math.max(...all.map((c) => c[1]))];
    const X0 = mx(x0), X1 = mx(x1), Y0 = my(y1), Y1 = my(y0);
    const span = Math.max(X1 - X0, Y1 - Y0) * 1.1;
    const cx = (X0 + X1) / 2, cy = (Y0 + Y1) / 2;
    const px = (lon: number) => ((mx(lon) - cx) / span + 0.5) * W;
    const py = (lat: number) => ((my(lat) - cy) / span + 0.5) * W;
    // rail network around
    const lonC = (x0 + x1) / 2, latC = (y0 + y1) / 2;
    const rad = Math.max(dist([x0, latC], [x1, latC]), dist([lonC, y0], [lonC, y1])) * 0.62;
    const segs = new Set<number>();
    querySegments(g, lonC, latC, rad, segs);
    let bg = '';
    for (const s of segs) {
      bg += `M${px(g.geoX[s]! / Q).toFixed(1)},${py(g.geoY[s]! / Q).toFixed(1)}L${px(g.geoX[s + 1]! / Q).toFixed(1)},${py(g.geoY[s + 1]! / Q).toFixed(1)}`;
    }
    const lines = focus.map((f) => `<path d="${f.coords.map((c, i) => `${i ? 'L' : 'M'}${px(c[0]).toFixed(1)},${py(c[1]).toFixed(1)}`).join('')}" stroke="${f.color}" stroke-width="3" fill="none" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>`).join('');
    const pts = focus.length === 1 ? focus[0]!.coords.map((c) => `<circle cx="${px(c[0]).toFixed(1)}" cy="${py(c[1]).toFixed(1)}" r="1.2" fill="#000"/>`).join('') : '';
    const mk = marks.map((c) => `<circle cx="${px(c[0]).toFixed(1)}" cy="${py(c[1]).toFixed(1)}" r="5" fill="#fff" stroke="#000" stroke-width="2"/>`).join('');
    panels.push(`<div class="p"><svg width="${W}" height="${W}"><rect width="${W}" height="${W}" fill="#fafaf7"/><path d="${bg}" stroke="#bbb" stroke-width="0.8" fill="none"/>${lines}${pts}${mk}</svg><div class="t">${title}</div></div>`);
  };
  res.forEach((r, i) => {
    const p = PAIRS[i]!;
    const km = (polylineLength(r.coords) / 1000).toFixed(0);
    panel(`${p.name} — ${km} km, ${r.coords.length} pts${r.snapped ? '' : ' (not snapped)'}`, [{ coords: r.coords, color: COLORS[i % COLORS.length]! }], [p.a, p.b]);
  });
  // zooms to check smoothness / track-following near stations
  const zoom = (title: string, c: LonLat, km: number) => {
    const dLat = km / 111, dLon = dLat / Math.cos((c[1] * Math.PI) / 180);
    panel(title, res.map((r, i) => ({ coords: r.coords, color: COLORS[i % COLORS.length]! })), [], [c[0] - dLon, c[1] - dLat, c[0] + dLon, c[1] + dLat]);
  };
  zoom('zoom: Köln 6 km', [6.97, 50.94], 3);
  zoom('zoom: Frankfurt 8 km', [8.63, 50.1], 4);
  zoom('zoom: Paris 10 km', [2.37, 48.86], 5);
  zoom('zoom: Øresund 30 km', [12.78, 55.62], 15);
  const html = `<!doctype html><html><head><style>body{margin:0;font:13px sans-serif;display:flex;flex-wrap:wrap;width:${4 * (W + 8)}px}.p{margin:4px}.t{padding:2px 4px}</style></head><body>${panels.join('')}</body></html>`;
  writeFileSync(join(outDir, 'demo.html'), html);
  let chromium: { launch: (o?: object) => Promise<any> };
  try {
    chromium = (await import('playwright' as string)).chromium;
  } catch {
    const root = execSync('npm root -g').toString().trim();
    chromium = createRequire(join(root, 'noop.js'))('playwright').chromium;
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 4 * (W + 8), height: 800 } });
  await page.setContent(html);
  await page.screenshot({ path: join(outDir, 'demo.png'), fullPage: true });
  await browser.close();
  log(`wrote ${join(outDir, 'demo.png')}, demo.geojson, demo.html`);
}

await main();
