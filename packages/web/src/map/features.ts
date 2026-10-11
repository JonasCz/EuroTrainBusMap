/**
 * Client-built GeoJSON for the selection layers. The base network itself comes
 * pre-built as vector tiles (see @etbm/shared netmap.ts and the ETL); here we
 * only draw what depends on the selection: the highlighted corridors (from the
 * per-shard geo files), the reachable cities and the selected cities' stations.
 */
import { CAT_BITS, catWidth, cityTierZoom, levelIndex, mergeLines, segId, shortStationName, stationLevel, terminalGeometry, type City, type Corridor, type Station } from "@etbm/shared";
import { Cat } from "@etbm/shared";
import type * as GeoJSON from "geojson";
import type { GeoStore } from "../data/load.ts";
import { effectiveCats, type Filters } from "../logic/filters.ts";

type FC = GeoJSON.FeatureCollection;
type Feature = GeoJSON.Feature;

export { shortStationName };

/** Gap between bundled lines, in width units (same as the tile style). */
export const GAP = 0.3;

const round2 = (x: number) => Math.round(x * 100) / 100;

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

/** Cat bits of a corridor visible under the filter. */
export function visibleCats(cities: City[], hasDtCats: boolean, c: Corridor, f: Filters): number {
  let cats = c.cats & effectiveCats(f);
  if (f.dticket) {
    if (hasDtCats) cats &= c.dtCats ?? 0;
    else if (cities[c.a]?.country !== "DE" || cities[c.b]?.country !== "DE") cats = 0;
  }
  return cats;
}

/**
 * Highlighted corridors (selection), drawn on their segments with the traffic
 * of the highlighted corridors only. g = 0: city-level geometry; g = 1:
 * station zoom (end pieces re-drawn to the stations).
 */
export function highlightData(geo: GeoStore, stations: (Station | undefined)[], hl: Map<number, number>): { lines: FC; casing: FC } {
  const lines: Feature[] = [];
  const casing: Feature[] = [];
  const segCats = new Map<number, number>();
  const segTpd = new Map<number, Record<number, number>>();
  const interior = new Set<number>();
  const ends: { c: Corridor; ka: number; kb: number }[] = [];
  for (const [cid, cats] of hl) {
    const c = geo.corridors.get(cid);
    if (!c?.segs?.length || !cats) continue;
    const seen = new Set<number>();
    for (const code of c.segs) {
      const s = segId(code);
      if (seen.has(s)) continue;
      seen.add(s);
      segCats.set(s, (segCats.get(s) ?? 0) | cats);
      const t = segTpd.get(s) ?? {};
      for (const k of CAT_BITS) if (cats & k && c.tpd[k]) t[k] = (t[k] ?? 0) + c.tpd[k]!;
      segTpd.set(s, t);
    }
    const [ka, kb] = geo.cut.get(cid) ?? [0, c.segs.length - 1];
    c.segs.forEach((code, i) => {
      if (i > ka && i < kb) interior.add(segId(code));
    });
    ends.push({ c, ka, kb });
  }
  // g: 0 = city-level geometry only, 1 = station zoom only, 2 = both
  const bundle = (sid: number, coords: [number, number][], g: number) => {
    const s = geo.segments.get(sid)!;
    const cats = segCats.get(sid)!;
    const tpd = segTpd.get(sid)!;
    const present = CAT_BITS.filter((k) => cats & k);
    // quantised widths / sort keys so neighbouring segments merge into long lines
    const widths = present.map((k) => Math.round(Math.max(1.6, catWidth(k, tpd[k] ?? 0, s.snapped)) * 4) / 4);
    const p = pack(widths);
    present.forEach((k, i) =>
      lines.push({ type: "Feature", properties: { cat: k, w: widths[i]!, o: p.offsets[i], g, hop: 0, k: Math.round(Math.log2(1 + (tpd[k] ?? 0)) * 2) }, geometry: { type: "LineString", coordinates: coords } }),
    );
    casing.push({ type: "Feature", properties: { t: p.total, g }, geometry: { type: "LineString", coordinates: coords } });
  };
  for (const [sid, cats] of segCats) {
    const s = geo.segments.get(sid);
    if (!s || s.coords.length < 2) continue;
    if (s.hop) {
      for (const k of CAT_BITS) if (cats & k) lines.push({ type: "Feature", properties: { cat: k, w: 1.6, o: 0, g: 0, hop: 1, k: 0 }, geometry: { type: "LineString", coordinates: s.coords } });
      continue;
    }
    bundle(sid, s.coords, interior.has(sid) ? 2 : 0);
  }
  // station-zoom end pieces
  const done = new Set<string>();
  for (const { c, ka, kb } of ends) {
    for (const end of ["a", "b"] as const) {
      const t = terminalGeometry((sid) => geo.segments.get(sid)?.coords, (id) => stations[id], c, ka, kb, end);
      if (!t) continue;
      if (geo.segments.get(t.sid)?.hop) continue;
      const key = `${t.sid}:${end === "a" ? c.sa : c.sb}`;
      if (done.has(key)) continue;
      done.add(key);
      bundle(t.sid, t.coords, 1);
    }
  }
  return { lines: { type: "FeatureCollection", features: mergeLines(lines) }, casing: { type: "FeatureCollection", features: mergeLines(casing) } };
}

export interface Emphasis {
  /** Cities to emphasise (selection + reachable). */
  focus: Set<number>;
  /** When true, everything not in focus is greyed out. */
  active: boolean;
  origin?: number;
  dest?: number;
}

/** Selection layer: reachable cities as small dots, labels by importance. */
export function focusCityData(cities: City[], em: Emphasis): FC {
  const features: Feature[] = [];
  for (const id of em.focus) {
    const c = cities[id];
    if (!c) continue;
    const sel = id === em.origin ? 1 : id === em.dest ? 2 : 0;
    features.push({
      type: "Feature",
      id,
      properties: {
        id,
        name: c.name,
        imp: c.importance,
        sel,
        // reachable places appear 1 (label) / 2 (dot) LOD levels earlier than in the base map
        lz: sel ? 0 : Math.max(0, levelIndex(cityTierZoom(c.importance)) - 1),
        dz: sel ? 0 : Math.max(0, levelIndex(cityTierZoom(c.importance)) - 2),
        rank: sel ? -1 : round2(1 - c.importance),
      },
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Stations of the given (selected) cities. */
export function stationData(cities: City[], stations: (Station | undefined)[], only: Set<number>): FC {
  const features: Feature[] = [];
  for (const cid of only) {
    const c = cities[cid];
    if (!c) continue;
    c.stations.forEach((sid, rank) => {
      const s = stations[sid];
      if (!s) return;
      const lz = stationLevel(s.cats, rank);
      features.push({
        type: "Feature",
        id: sid,
        properties: { name: shortStationName(s.name, c.name), city: s.city, lz, rail: s.cats & (Cat.LongDistance | Cat.Regional) ? 1 : 0, major: lz === 0 ? 1 : 0, rank: rank + (lz === 0 ? 0 : 100) },
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      });
    });
  }
  return { type: "FeatureCollection", features };
}
