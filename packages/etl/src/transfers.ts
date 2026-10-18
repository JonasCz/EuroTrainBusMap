/**
 * Transfer timetable (see packages/shared/src/tt.ts): every pattern and trip of the timetable shards,
 * deduplicated, in compact gzipped chunks – the trunk (long-distance rail + coach, all of Europe) and
 * regional chunks (regional rail + bus by area) – for the web app's search of connections with changes.
 */
import { gzipSync } from "node:zlib";
import { Cat, canBoard, TT_ALPHABET, TT_VERSION, encodeTtChunk, routeBrand, encodeTtLines, segId, type City, type CityFile, type Segment, type TtIndex, type TtLinesIn, type TtPatternIn } from "@etbm/shared";
import { simplifyLine } from "./util/geo.ts";

/** Geometry tolerance of the lines drawn for connections with changes (thin, faded lines). */
export const TT_SIMPLIFY_M = 100;
/** Regional chunks: a region is split while it holds more than this share of the regional / bus departures. */
const REGION_SHARE = 1 / 28;

interface Pat extends TtPatternIn {
  corridors: number[];
  tripKeys: Set<string>;
}

export class TransferCollector {
  private byKey = new Map<string, Pat>();
  private list: Pat[] = [];
  private walk = new Map<number, Map<string, [number, number, number]>>();
  /** transit pairs (TransitPair) per city */
  private transit = new Map<number, number[][]>();
  /** brand names (routeBrand) → index */
  private brands = new Map<string, number>();

  /** Add the patterns / trips / walking transfers of one CityFile (patterns seen before are merged). */
  add(cf: CityFile): void {
    const refs: Pat[] = [];
    cf.patterns.forEach((p, i) => {
      const route = cf.routes[p.route];
      const cat = route?.cat ?? Cat.Bus;
      const tz = cf.patternTz[i] ?? 0;
      // regional buses: the mode is enough (route names are line numbers or place lists)
      const bn = route && cat !== Cat.Bus ? routeBrand(route.name, route.agency, cat, route.brand) : "";
      let brand = this.brands.get(bn);
      if (brand === undefined) this.brands.set(bn, (brand = this.brands.size));
      const key = `${cat}|${tz}|${brand}|${p.stations.join(",")}|${p.arr.join(",")}|${p.dep.join(",")}|${(p.limits ?? []).join(",")}`;
      let e = this.byKey.get(key);
      if (!e) {
        e = { id: this.list.length, cat, tz, brand, stations: p.stations, arr: p.arr, dep: p.dep, trips: [], corridors: p.corridors, tripKeys: new Set() };
        if (p.limits) e.limits = p.limits;
        this.byKey.set(key, e);
        this.list.push(e);
      }
      refs[i] = e;
    });
    for (const [pi, start, cal] of cf.trips) {
      const e = refs[pi];
      if (!e) continue;
      const k = `${start},${cal}`;
      if (e.tripKeys.has(k)) continue;
      e.tripKeys.add(k);
      e.trips.push([start, cal]);
    }
    let w = this.walk.get(cf.city);
    if (!w) this.walk.set(cf.city, (w = new Map()));
    for (const [a, b, m] of cf.transfers) {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const k = `${lo},${hi}`;
      const old = w.get(k);
      if (!old || m < old[2]) w.set(k, [lo, hi, m]);
    }
    if (cf.transit?.length) this.transit.set(cf.city, cf.transit);
  }

  get patterns(): number {
    return this.list.length;
  }

  /**
   * Build the chunks. `write(rel, bytes)` stores a file under the build directory.
   */
  async write(
    cities: City[],
    segments: Segment[],
    corridors: { id: number; a: number; b: number; segs?: number[] }[],
    write: (rel: string, data: string | Uint8Array) => Promise<void>,
    log: (m: string) => void = console.log,
  ): Promise<{ index: TtIndex; files: number; bytes: number }> {
    const stationCity = new Map<number, number>();
    for (const c of cities) for (const s of c.stations) stationCity.set(s, c.id);
    const trunkCat = Cat.LongDistance | Cat.Coach;
    // ---- regions: k-d split of the cities, weighted by regional rail / bus departures boarding there
    const weight = new Float64Array(cities.length);
    for (const p of this.list) {
      if (p.cat & trunkCat) continue;
      for (const c of boardingCities(p, stationCity)) weight[c]! += p.trips.length;
    }
    const total = weight.reduce((s, x) => s + x, 0);
    const chunkOf = new Uint8Array(cities.length);
    let nChunks = 1;
    const split = (ids: number[], depth: number) => {
      const w = ids.reduce((s, i) => s + weight[i]!, 0);
      if (w <= total * REGION_SHARE || ids.length < 2 || depth > 12 || nChunks >= TT_ALPHABET.length - 1) {
        const k = nChunks++;
        for (const i of ids) chunkOf[i] = k;
        return;
      }
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const i of ids) {
        const c = cities[i]!;
        x0 = Math.min(x0, c.lon); x1 = Math.max(x1, c.lon); y0 = Math.min(y0, c.lat); y1 = Math.max(y1, c.lat);
      }
      const byLon = (x1 - x0) * Math.cos((((y0 + y1) / 2) * Math.PI) / 180) > y1 - y0;
      const sorted = [...ids].sort((a, b) => (byLon ? cities[a]!.lon - cities[b]!.lon : cities[a]!.lat - cities[b]!.lat));
      let acc = 0, cut = 0;
      for (; cut < sorted.length - 1; cut++) {
        acc += weight[sorted[cut]!]!;
        if (acc >= w / 2) break;
      }
      split(sorted.slice(0, cut + 1), depth + 1);
      split(sorted.slice(cut + 1), depth + 1);
    };
    split(cities.map((c) => c.id), 0);

    // ---- patterns per chunk
    const chunkPats: Pat[][] = Array.from({ length: nChunks }, () => []);
    for (const p of this.list) {
      if (!p.trips.length) continue;
      if (p.cat & trunkCat) chunkPats[0]!.push(p);
      else {
        const ks = new Set<number>();
        for (const c of boardingCities(p, stationCity)) ks.add(chunkOf[c]!);
        for (const k of ks) chunkPats[k]!.push(p);
      }
    }
    const corrById = new Map<number, { id: number; a: number; b: number; segs?: number[] }>();
    for (const c of corridors) corrById.set(c.id, c);
    const simplified = new Map<number, [number, number][]>();
    const segCoords = (id: number) => {
      let s = simplified.get(id);
      if (!s) {
        const seg = segments[id];
        s = seg ? (simplifyLine(seg.coords, TT_SIMPLIFY_M) as [number, number][]) : [];
        simplified.set(id, s);
      }
      return s;
    };
    const index: TtIndex = { version: TT_VERSION, chunks: [], cityChunk: "", brands: [...this.brands.keys()] };
    let bytes = 0, transitPairs = 0;
    for (let k = 0; k < nChunks; k++) {
      const pats = chunkPats[k]!;
      const cids = new Set<number>();
      for (const p of pats) for (const c of p.corridors) if (c >= 0) cids.add(c);
      const cors: TtLinesIn["corridors"] = [];
      const sids = new Set<number>();
      for (const id of cids) {
        const c = corrById.get(id);
        if (!c) continue;
        cors.push({ id, a: Math.min(c.a, c.b), b: Math.max(c.a, c.b), segs: c.segs ?? [] });
        for (const code of c.segs ?? []) sids.add(segId(code));
      }
      const walk: [number, number, number][] = [];
      const transit: number[][] = [];
      if (k > 0)
        for (const c of cities) {
          if (chunkOf[c.id] !== k) continue;
          for (const t of this.walk.get(c.id)?.values() ?? []) walk.push(t);
          for (const t of this.transit.get(c.id) ?? []) transit.push(t);
        }
      transitPairs += transit.length;
      const data = gzipSync(encodeTtChunk({ patterns: pats, walk, transit }), { level: 9 });
      const lines = gzipSync(encodeTtLines({ corridors: cors, segments: [...sids].map((id) => ({ id, coords: segCoords(id) })) }), { level: 9 });
      const file = `tt/${k}.bin.gz`, lfile = `tt/${k}.lines.gz`;
      await write(file, data);
      await write(lfile, lines);
      bytes += data.length + lines.length;
      index.chunks.push({ file, lines: lfile, bytes: data.length, lineBytes: lines.length, patterns: pats.length, trips: pats.reduce((s, p) => s + p.trips.length, 0) });
    }
    index.cityChunk = Array.from(chunkOf, (k) => TT_ALPHABET[k]!).join("");
    await write("tt/index.json", JSON.stringify(index));
    const mb = (x: number) => (x / 1e6).toFixed(2);
    const tb = index.chunks.reduce((s, c) => s + c.bytes, 0);
    log(
      `mapdata: transfer timetable ${this.list.length} patterns in ${nChunks} chunks, ${mb(tb)} MB gz + lines ${mb(bytes - tb)} MB ` +
        `(trunk ${mb(index.chunks[0]!.bytes)} + ${mb(index.chunks[0]!.lineBytes)} MB, regions ${index.chunks.slice(1).map((c) => mb(c.bytes)).join(" ")}), ` +
        `${transitPairs} transit pairs`,
    );
    return { index, files: 2 * nChunks + 1, bytes };
  }
}

/** Cities where a pattern can be boarded (every stop but the last, unless boarding is not allowed there). */
function boardingCities(p: TtPatternIn, stationCity: Map<number, number>): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < p.stations.length - 1; i++) {
    if (!canBoard(p, i)) continue;
    const c = stationCity.get(p.stations[i]!);
    if (c !== undefined) out.add(c);
  }
  return out;
}
