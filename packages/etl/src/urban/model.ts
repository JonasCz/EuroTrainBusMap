/** Pure logic of the local-transport layer: de-duplication, stations, zoom levels. */
import { fastDist } from "../util/geo.ts";
import { mergeStations, describeStation, type StopIn } from "../core/stations.ts";
import { DiscIndex, readableColor, stripCityName } from "./classify.ts";
import { normalizeStopName, normSimilarity } from "../core/names.ts";
import { UMode, type LonLat, type UModeCode, type UrbanFeed, type UrbanPattern } from "./types.ts";

/** A line alignment ready to be drawn. */
export interface DrawnLine {
  mode: UModeCode;
  name: string;
  desc: string;
  agency: string;
  color: string;
  tpd: number;
  coords: LonLat[];
  geom: UrbanPattern["geom"];
  /** Feed-global station indices called at (for the stop lists). */
  stops: number[];
  /** Zoom from which the line is drawn. */
  lz: number;
  /** Its feed is out of date since this day (UrbanFeed.expired; tile property `e`). */
  expired?: string;
}

export interface UrbanStation {
  name: string;
  lon: number;
  lat: number;
  /** bit per UMode (1 << mode) */
  modes: number;
  /** names of the lines serving it, most important first */
  lines: string[];
  /** importance (for thinning and label priority) */
  imp: number;
  /** zoom from which the station is shown */
  z: number;
  /** attached to an intercity station (no dot of its own) */
  ix: boolean;
  /** first zoom of the earliest line that calls here (a stop never shows before its lines) */
  lz: number;
}

/** First zoom at which a line is drawn: metro first, then trams, buses by frequency. */
export function lineZoom(mode: UModeCode, tpd: number): number {
  if (mode === UMode.Metro) return tpd >= 100 ? 10 : 10.8;
  if (mode === UMode.Tram) return tpd >= 150 ? 11.2 : tpd >= 60 ? 12 : 12.6;
  if (mode === UMode.Cable) return 12.5;
  if (tpd >= 90) return 12.4;
  if (tpd >= 50) return 13;
  if (tpd >= 25) return 13.6;
  return 14.2;
}

/** Dynamic point set with a metre grid: add points, ask whether any lies within r metres. */
export class PointGrid {
  private cells = new Map<number, number[]>();
  private xs: number[] = [];
  private ys: number[] = [];
  constructor(private readonly cell: number) {}
  private static proj(lon: number, lat: number): [number, number] {
    return [lon * 111_320 * Math.cos((lat * Math.PI) / 180), lat * 110_540];
  }
  private key(cx: number, cy: number): number {
    return (cx + 200_000) * 400_000 + (cy + 200_000);
  }
  add(lon: number, lat: number): void {
    const [x, y] = PointGrid.proj(lon, lat);
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    let a = this.cells.get(k);
    if (!a) this.cells.set(k, (a = []));
    a.push(this.xs.length);
    this.xs.push(x);
    this.ys.push(y);
  }
  /** Whether a point lies within r metres. */
  any(lon: number, lat: number, r: number): boolean {
    const [x, y] = PointGrid.proj(lon, lat);
    const n = Math.ceil(r / this.cell);
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    const r2 = r * r;
    for (let i = cx - n; i <= cx + n; i++)
      for (let j = cy - n; j <= cy + n; j++) {
        const a = this.cells.get(this.key(i, j));
        if (!a) continue;
        for (const k of a) if ((this.xs[k]! - x) ** 2 + (this.ys[k]! - y) ** 2 <= r2) return true;
      }
    return false;
  }
}

const GEOM_RANK: Record<UrbanPattern["geom"], number> = { shape: 0, rail: 1, road: 2, stops: 3 };

/** Sample points about every `stepM` metres along a polyline (including the ends). */
export function samplePath(coords: LonLat[], stepM: number): LonLat[] {
  const out: LonLat[] = [coords[0]!];
  let carry = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!, b = coords[i]!;
    const d = fastDist(a[0], a[1], b[0], b[1]);
    let t = stepM - carry;
    while (t < d) {
      const f = t / d;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      t += stepM;
    }
    carry = (carry + d) % stepM;
  }
  out.push(coords[coords.length - 1]!);
  return out;
}

/**
 * Drop alignments that repeat a line already drawn: the opposite direction of a line, the same line in
 * two feeds, branches that are mostly covered by the main alignment. Alignments only count as repeats of
 * the same mode and name; the better geometry (shape > rail > road > stops) and then the longer alignment wins.
 */
export function dedupeLines<T extends { mode: number; name: string; coords: LonLat[]; geom: UrbanPattern["geom"]; expired?: string }>(items: T[], coverM = 45, share = 0.85): T[] {
  // a line from a current feed before one from a stale feed (UrbanFeed.expired), then by geometry quality and length
  const order = items
    .map((_, i) => i)
    .sort((a, b) => Number(!!items[a]!.expired) - Number(!!items[b]!.expired) || GEOM_RANK[items[a]!.geom] - GEOM_RANK[items[b]!.geom] || pathLen(items[b]!.coords) - pathLen(items[a]!.coords));
  const occupied = new Map<string, PointGrid>();
  const kept: number[] = [];
  const cell = coverM * 2;
  for (const i of order) {
    const it = items[i]!;
    const key = `${it.mode}|${it.name.toLowerCase()}`;
    let g = occupied.get(key);
    const pts = samplePath(it.coords, coverM);
    if (g) {
      let covered = 0;
      for (const p of pts) if (g.any(p[0], p[1], coverM)) covered++;
      if (covered / pts.length >= share) continue;
    } else {
      g = new PointGrid(cell);
      occupied.set(key, g);
    }
    for (const p of samplePath(it.coords, coverM / 2)) g.add(p[0], p[1]);
    kept.push(i);
  }
  return kept.sort((a, b) => a - b).map((i) => items[i]!);
}

function pathLen(c: LonLat[]): number {
  let s = 0;
  for (let i = 1; i < c.length; i++) s += fastDist(c[i - 1]![0], c[i - 1]![1], c[i]![0], c[i]![1]);
  return s;
}

/** Metres per screen pixel at a latitude and (512 px tile) map zoom. */
export function metresPerPixel(lat: number, zoom: number): number {
  return (40_075_017 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
}

/**
 * Adaptive thinning of points over zoom levels ("several levels of merging"): in order of
 * importance every point takes the first zoom of `levels` at which no more important point that is
 * already shown at that zoom lies within `spacingPx` screen pixels; so crowded centres show their key
 * stations first and fill in as the map zooms. Returns the zoom per point.
 */
export function thinZooms(pts: { lon: number; lat: number; imp: number }[], levels: number[], spacingPx: number): Float32Array {
  const out = new Float32Array(pts.length).fill(levels[levels.length - 1]!);
  const grids = levels.map((z) => {
    // grid cell ~ the spacing at that zoom at 50° N
    return new PointGrid(Math.max(5, spacingPx * metresPerPixel(50, z)));
  });
  const order = pts.map((_, i) => i).sort((a, b) => pts[b]!.imp - pts[a]!.imp || a - b);
  for (const i of order) {
    const p = pts[i]!;
    let chosen = levels.length - 1;
    for (let li = 0; li < levels.length - 1; li++) {
      const r = spacingPx * metresPerPixel(p.lat, levels[li]!);
      if (!grids[li]!.any(p.lon, p.lat, r)) {
        chosen = li;
        break;
      }
    }
    out[i] = levels[chosen]!;
    for (let li = chosen; li < levels.length; li++) grids[li]!.add(p.lon, p.lat);
  }
  return out;
}

export interface BuiltUrban {
  lines: DrawnLine[];
  stations: UrbanStation[];
}

const MODE_W = { [UMode.Metro]: 8, [UMode.Tram]: 4, [UMode.Cable]: 3, [UMode.Bus]: 1 } as const;

/** Zoom levels at which rail-like (metro / tram) stations and bus stops can appear. */
export const RAIL_STATION_LEVELS = [10.5, 11.5, 12.5, 13.5, 14.5];
export const BUS_STATION_LEVELS = [14, 14.8];

/**
 * Combine the extracted feeds: de-duplicated alignments, merged stations (name / proximity based, the same
 * rules as the intercity stations), line lists and zoom levels.
 */
export function buildUrban(feeds: UrbanFeed[], intercity: { lon: number; lat: number; name?: string }[] = [], cities?: DiscIndex, attachM = 90): BuiltUrban {
  // ---- global stops
  const stopBase: number[] = [];
  const stopsIn: StopIn[] = [];
  const stopMode: number[] = []; // bit mask of modes calling at the stop
  feeds.forEach((f, fi) => {
    stopBase.push(stopsIn.length);
    f.stops.forEach((s) => {
      stopsIn.push({ lon: s.lon, lat: s.lat, name: s.name, rail: false, parent: s.parent ? `${fi}:${s.parent}` : null, feed: fi, weight: 0 });
      stopMode.push(0);
    });
  });
  // ---- alignments
  const items: (DrawnLine & { fi: number })[] = [];
  feeds.forEach((f, fi) => {
    for (const l of f.lines)
      for (const p of l.patterns) {
        if (p.coords.length < 2) continue;
        items.push({ mode: l.mode, name: l.name, desc: l.desc, agency: l.agency, color: readableColor(l.color), tpd: l.tpd, coords: p.coords, geom: p.geom, stops: p.stops.map((s) => stopBase[fi]! + s), lz: lineZoom(l.mode, l.tpd), fi, ...(f.expired ? { expired: f.expired } : {}) });
        for (const s of p.stops) {
          const g = stopBase[fi]! + s;
          stopMode[g]! |= 1 << l.mode;
          stopsIn[g]!.weight += p.trips;
          if (l.mode !== UMode.Bus) stopsIn[g]!.rail = true;
        }
      }
  });
  const lines = dedupeLines(items);
  // ---- stations (only stops that a kept alignment calls at)
  const used = new Uint8Array(stopsIn.length);
  for (const l of lines) for (const s of l.stops) used[s] = 1;
  const ids: number[] = [];
  for (let i = 0; i < stopsIn.length; i++) if (used[i]) ids.push(i);
  const merged = mergeStations(ids.map((i) => stopsIn[i]!));
  const members: number[][] = Array.from({ length: merged.count }, () => []);
  ids.forEach((g, k) => members[merged.stationOf[k]!]!.push(g));
  const stationOfStop = new Int32Array(stopsIn.length).fill(-1);
  const stations: UrbanStation[] = members.map((m, si) => {
    for (const g of m) stationOfStop[g] = si;
    const d = describeStation(m.map((g) => stopsIn[g]!));
    let modes = 0;
    for (const g of m) modes |= stopMode[g]!;
    const name = cities ? stripCityName(d.name, cities.cityAt(d.lon, d.lat)) : d.name;
    return { name, lon: d.lon, lat: d.lat, modes, lines: [], imp: 0, z: 15, ix: false, lz: 99 };
  });
  // lines per station, importance
  const lineSets: Map<string, number>[] = stations.map(() => new Map());
  const railLz: number[] = stations.map(() => 99), busLz: number[] = stations.map(() => 99);
  for (const l of lines) {
    const w = MODE_W[l.mode] * (1 + Math.min(l.tpd, 200) / 100);
    const seen = new Set<number>();
    for (const g of l.stops) {
      const si = stationOfStop[g]!;
      if (si < 0 || seen.has(si)) continue;
      seen.add(si);
      if (l.mode === UMode.Bus) busLz[si] = Math.min(busLz[si]!, l.lz);
      else railLz[si] = Math.min(railLz[si]!, l.lz);
      const key = `${l.mode}:${l.name}`;
      const m = lineSets[si]!;
      m.set(key, Math.max(m.get(key) ?? 0, w));
    }
  }
  stations.forEach((s, i) => {
    const m = [...lineSets[i]!.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en", { numeric: true }));
    s.lines = m.map(([k]) => k.slice(k.indexOf(":") + 1));
    s.imp = m.reduce((a, [, w]) => a + w, 0);
  });
  // lines re-indexed to station indices
  for (const l of lines) l.stops = [...new Set(l.stops.map((g) => stationOfStop[g]!).filter((x) => x >= 0))];
  // ---- attach to intercity stations
  if (intercity.length) {
    // an intercity station's own stop (≤ attachM) or one with the same name nearby (the tram stop in front of the
    // station) belongs to the station: no second dot, no second label
    const near = new PointGrid(attachM * 2), named = new PointGrid(400);
    const byCell = new Map<string, string[]>();
    for (const c of intercity) {
      near.add(c.lon, c.lat);
      if (c.name) {
        named.add(c.lon, c.lat);
        const k = `${Math.round(c.lon * 250)},${Math.round(c.lat * 400)}`;
        (byCell.get(k) ?? byCell.set(k, []).get(k)!).push(normalizeStopName(c.name));
      }
    }
    for (const s of stations) {
      if (near.any(s.lon, s.lat, attachM)) {
        s.ix = true;
        continue;
      }
      if (!named.any(s.lon, s.lat, 350)) continue;
      const ns = normalizeStopName(s.name);
      const cx = Math.round(s.lon * 250), cy = Math.round(s.lat * 400);
      for (let dx = -2; dx <= 2 && !s.ix; dx++)
        for (let dy = -2; dy <= 2 && !s.ix; dy++) if (byCell.get(`${cx + dx},${cy + dy}`)?.some((n) => n && ns && normSimilarity(ns, n) >= 0.8)) s.ix = true;
    }
  }
  // ---- zoom levels of the stations
  const rail = stations.map((s, i) => i).filter((i) => stations[i]!.modes & ~(1 << UMode.Bus));
  const bus = stations.map((s, i) => i).filter((i) => !(stations[i]!.modes & ~(1 << UMode.Bus)));
  for (const [set, levels, px] of [[rail, RAIL_STATION_LEVELS, 24], [bus, BUS_STATION_LEVELS, 12]] as const) {
    const z = thinZooms(set.map((i) => stations[i]!), levels, px);
    set.forEach((i, k) => {
      const s = stations[i]!;
      s.lz = set === rail ? railLz[i]! : busLz[i]!;
      // a stop shows with its first line, not before: a dot in the middle of nowhere reads as an error
      s.z = Math.max(z[k]!, s.lz < 99 ? s.lz : 0);
    });
  }
  return { lines: lines.map(({ fi: _fi, ...l }) => l as DrawnLine), stations };
}
