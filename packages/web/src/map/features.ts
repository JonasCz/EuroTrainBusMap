/**
 * Client-built GeoJSON for the selection layers. The base network itself comes
 * pre-built as vector tiles (see @etbm/shared netmap.ts and the ETL); here we
 * only draw what depends on the selection: the highlighted corridors (from the
 * per-shard geo files), the reachable cities and the selected cities' stations.
 */
import { CAT_BITS, catWidth, cityTierZoom, isMajorStation, levelIndex, mergeLines, segId, shortStationName, stationLevel, type City, type Station } from "@etbm/shared";
import { Cat } from "@etbm/shared";
import type * as GeoJSON from "geojson";
import type { GeoStore } from "../data/load.ts";
import type { Filters } from "../logic/filters.ts";

type FC = GeoJSON.FeatureCollection;
type Feature = GeoJSON.Feature;

export { shortStationName };

/** Gap between bundled lines, in width units (same as the tile style). */
export const GAP = 0.3;

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Narrowest highlighted line (width units). The selection's own traffic is often a few trips a day
 * (a pair, a journey leg), which the base scale would draw hairline-thin; selected lines stay bold.
 */
export const HL_MIN_W = 2.2;

/** Offsets (centre of each line) for a bundle of widths. */
export function pack(widths: number[]): { offsets: number[]; total: number } {
  const total = widths.reduce((s, w) => s + w, 0) + GAP * Math.max(0, widths.length - 1);
  let acc = -total / 2;
  const offsets = widths.map((w) => {
    const o = acc + w / 2;
    acc += w + GAP;
    return round2(o);
  });
  return { offsets, total: round2(total) };
}

/**
 * Highlighted corridors (selection), drawn on their segments. Widths come from `traffic`, the trips/day
 * of the selected services on each corridor (a selected city's own trips, not everything on the line), so
 * a through route keeps one width as long as the number of selected trips stays the same; without it the
 * corridors' total traffic is used. Corridors join stations, so there are no end pieces to add; approximate
 * alignments (not on any track or road) are drawn dashed.
 */
export function highlightData(geo: GeoStore, hl: Map<number, number>, traffic?: Map<number, Partial<Record<number, number>>>): { lines: FC; casing: FC } {
  const lines: Feature[] = [];
  const casing: Feature[] = [];
  const segCats = new Map<number, number>();
  const segTpd = new Map<number, Record<number, number>>();
  for (const [cid, cats] of hl) {
    const c = geo.corridors.get(cid);
    if (!c?.segs?.length || !cats) continue;
    const tpd = traffic ? (traffic.get(cid) ?? {}) : c.tpd;
    const seen = new Set<number>();
    for (const code of c.segs) {
      const s = segId(code);
      if (seen.has(s)) continue;
      seen.add(s);
      segCats.set(s, (segCats.get(s) ?? 0) | cats);
      const t = segTpd.get(s) ?? {};
      for (const k of CAT_BITS) if (cats & k && tpd[k]) t[k] = (t[k] ?? 0) + tpd[k]!;
      segTpd.set(s, t);
    }
  }
  for (const [sid, cats] of segCats) {
    const s = geo.segments.get(sid);
    if (!s || s.coords.length < 2) continue;
    if (s.hop || !s.snapped) {
      for (const k of CAT_BITS) if (cats & k) lines.push({ type: "Feature", properties: { cat: k, w: 1.6, o: 0, hop: 1, k: 0 }, geometry: { type: "LineString", coordinates: s.coords } });
      continue;
    }
    const tpd = segTpd.get(sid)!;
    const present = CAT_BITS.filter((k) => cats & k);
    // quantised widths / sort keys so neighbouring segments merge into long lines
    const widths = present.map((k) => Math.round(Math.max(HL_MIN_W, catWidth(k, tpd[k] ?? 0, s.snapped)) * 4) / 4);
    const p = pack(widths);
    present.forEach((k, i) =>
      lines.push({ type: "Feature", properties: { cat: k, w: widths[i]!, o: p.offsets[i], hop: 0, k: Math.round(Math.log2(1 + (tpd[k] ?? 0)) * 2) }, geometry: { type: "LineString", coordinates: s.coords } }),
    );
    casing.push({ type: "Feature", properties: { t: p.total }, geometry: { type: "LineString", coordinates: s.coords } });
  }
  return { lines: { type: "FeatureCollection", features: mergeLines(lines) }, casing: { type: "FeatureCollection", features: mergeLines(casing) } };
}

/**
 * Context lines: the parts of a selected vehicle run that are not ridden (before boarding, after
 * alighting), drawn thin and faded under the highlight. One feature per segment and category.
 */
export function contextData(geo: GeoStore, corridors: Map<number, number>): FC {
  const segCats = new Map<number, number>();
  for (const [cid, cats] of corridors) {
    const c = geo.corridors.get(cid);
    if (!c?.segs?.length || !cats) continue;
    for (const code of c.segs) {
      const s = segId(code);
      segCats.set(s, (segCats.get(s) ?? 0) | cats);
    }
  }
  const lines: Feature[] = [];
  for (const [sid, cats] of segCats) {
    const s = geo.segments.get(sid);
    if (!s || s.coords.length < 2) continue;
    // one colour per segment: the most prominent category (rail before road)
    const k = CAT_BITS.find((b) => cats & b)!;
    lines.push({ type: "Feature", properties: { cat: k, hop: s.hop || !s.snapped ? 1 : 0 }, geometry: { type: "LineString", coordinates: s.coords } });
  }
  return { type: "FeatureCollection", features: mergeLines(lines) };
}

/**
 * Lines reached with changes (connections search): one feature per segment and level (2 = one change, 3 = two),
 * coloured by the most prominent category, drawn thin and more transparent with every change.
 */
export function xferData(geo: GeoStore, xfer: Map<number, { level: number; cats: number }>): FC {
  const segs = new Map<number, { level: number; cats: number }>();
  for (const [cid, v] of xfer) {
    const c = geo.corridors.get(cid);
    if (!c?.segs?.length) continue;
    for (const code of c.segs) {
      const s = segId(code);
      const o = segs.get(s);
      if (!o || v.level < o.level) segs.set(s, { level: v.level, cats: v.cats });
      else if (o.level === v.level) o.cats |= v.cats;
    }
  }
  const lines: Feature[] = [];
  for (const [sid, v] of segs) {
    const s = geo.segments.get(sid);
    if (!s || s.coords.length < 2) continue;
    const k = CAT_BITS.find((b) => v.cats & b)!;
    lines.push({ type: "Feature", properties: { cat: k, lvl: v.level }, geometry: { type: "LineString", coordinates: s.coords } });
  }
  return { type: "FeatureCollection", features: mergeLines(lines) };
}

export interface Emphasis {
  /** Cities to emphasise (selection + reachable). */
  focus: Set<number>;
  /** When true, everything not in focus is greyed out. */
  active: boolean;
  origin?: number;
  /** The origin narrowed to one of its stations. */
  originStation?: number;
  dest?: number;
  /** Cities reached only with changes: city → level (2 = one change, 3 = two); drawn lighter, after the direct ones. */
  levels?: Map<number, number>;
}

/** Selection layer: reachable cities as small dots, labels by importance. */
export function focusCityData(cities: City[], em: Emphasis): FC {
  const features: Feature[] = [];
  const ids = em.levels?.size ? new Set([...em.focus, ...em.levels.keys()]) : em.focus;
  for (const id of ids) {
    const c = cities[id];
    if (!c) continue;
    const sel = id === em.origin ? 1 : id === em.dest ? 2 : 0;
    const x = sel ? 0 : Math.max(0, (em.levels?.get(id) ?? 1) - 1);
    // places reached with changes keep their own LOD level (no early labels) and rank after the direct ones
    const boost = x ? 0 : 1;
    features.push({
      type: "Feature",
      id,
      properties: {
        id,
        name: c.name,
        imp: c.importance,
        sel,
        // reachable places appear 1 (label) / 2 (dot) LOD levels earlier than in the base map
        lz: sel ? 0 : Math.max(0, levelIndex(cityTierZoom(c.importance)) - boost),
        dz: sel ? 0 : Math.max(0, levelIndex(cityTierZoom(c.importance)) - 2 * boost),
        rank: sel ? -1 : round2(x + 1 - c.importance),
        x,
      },
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Stations of the given (selected) cities; `current` is the one chosen as origin. */
export function stationData(cities: City[], stations: (Station | undefined)[], only: Set<number>, current?: number): FC {
  const features: Feature[] = [];
  for (const cid of only) {
    const c = cities[cid];
    if (!c) continue;
    c.stations.forEach((sid, rank) => {
      const s = stations[sid];
      if (!s) return;
      const lz = stationLevel(s.cats, rank, c.stations.length);
      const major = isMajorStation(s.cats, rank);
      features.push({
        type: "Feature",
        id: sid,
        properties: { id: sid, name: shortStationName(s.name, c.name), city: s.city, lz, cur: sid === current ? 1 : 0, rail: s.cats & (Cat.LongDistance | Cat.Regional) ? 1 : 0, major: major ? 1 : 0, rank: rank + (major ? 0 : 100) },
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      });
    });
  }
  return { type: "FeatureCollection", features };
}

/** Hover / tap targets: one feature per segment of the highlighted corridors, `s` = segment id (not merged). */
export function trackHitData(geo: GeoStore, corridors: Iterable<number>): FC {
  const seen = new Set<number>();
  const features: Feature[] = [];
  for (const cid of corridors) {
    const c = geo.corridors.get(cid);
    if (!c?.segs?.length) continue;
    for (const code of c.segs) {
      const s = segId(code);
      if (seen.has(s)) continue;
      seen.add(s);
      const g = geo.segments.get(s);
      if (g && g.coords.length >= 2) features.push({ type: "Feature", properties: { s }, geometry: { type: "LineString", coordinates: g.coords } });
    }
  }
  return { type: "FeatureCollection", features };
}

/** Segment ids a corridor is drawn on (empty when its geometry is not loaded). */
export function corridorSegs(geo: GeoStore, corridor: number): number[] {
  return (geo.corridors.get(corridor)?.segs ?? []).map(segId);
}
