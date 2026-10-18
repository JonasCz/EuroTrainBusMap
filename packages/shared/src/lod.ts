/**
 * Level-of-detail rules (pure, unit-tested). Everything is expressed as a
 * minimum zoom snapped to one of LEVELS, so layers can be bucketed by level
 * (MapLibre filters cannot compare zoom with feature properties).
 */
import { Cat } from "./schema.ts";

/** Zoom levels at which new detail appears. Index = "lz" bucket. */
export const LEVELS = [0, 3, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9.5] as const;
/** Features fade in over this many zoom levels from their level (style) and are in the tiles from one tile zoom earlier. */
export const FADE_ZOOM = 0.7;
/** Zoom at which cities break out into their stations. */
export const STATION_ZOOM = 10.5;
/** Station detail levels (≥ STATION_ZOOM). Index = station "lz". */
export const STATION_LEVELS = [10.5, 11.5, 12.5, 13.5] as const;

/** Unsnapped (straight) corridors longer than this are "long hops". */
export const LONG_HOP_KM = 100;
export const LONG_HOP_ZOOM = 6.5;

export function levelIndex(z: number): number {
  let i = 0;
  for (let k = 0; k < LEVELS.length; k++) if (LEVELS[k]! <= z + 1e-9) i = k;
  return i;
}

export function isLongHop(lenKm: number, snapped: boolean): boolean {
  return !snapped && lenKm > LONG_HOP_KM;
}

/** Minimum zoom of one category line on a corridor. */
export function corridorMinZoom(cat: number, tpd: number, lenKm: number, snapped: boolean): number {
  if (isLongHop(lenKm, snapped)) return LONG_HOP_ZOOM;
  switch (cat) {
    case Cat.LongDistance:
      return tpd >= 4 ? 0 : tpd >= 1 ? 4.5 : 5.5;
    case Cat.Regional:
      return tpd >= 150 && lenKm >= 20 ? 4.5 : tpd >= 120 && lenKm >= 15 ? 5.5 : tpd >= 40 ? 6.5 : tpd >= 12 ? 7.5 : 8;
    case Cat.Coach:
      return tpd >= 15 ? 6 : tpd >= 4 ? 7 : 8;
    default: // regional bus
      return tpd >= 150 ? 7.5 : tpd >= 50 ? 8 : tpd >= 15 ? 8.5 : 9.5;
  }
}

/** Zoom from which a city marker may appear, from importance (0..1). */
export function cityTierZoom(importance: number): number {
  if (importance >= 0.8) return 0;
  if (importance >= 0.75) return 4.5;
  if (importance >= 0.71) return 5.5;
  if (importance >= 0.67) return 6;
  if (importance >= 0.63) return 6.5;
  if (importance >= 0.59) return 7;
  if (importance >= 0.55) return 7.5;
  if (importance >= 0.5) return 8;
  if (importance >= 0.42) return 8.5;
  return 9.5;
}

/**
 * Station detail bucket: rail stations and the city's busiest stops first,
 * minor bus stops only when zoomed far in. `rank` = position in the city's
 * station list (ETL orders by service weight).
 */
export function stationLevel(cats: number, rank: number): number {
  const ld = (cats & Cat.LongDistance) !== 0;
  const rail = (cats & (Cat.LongDistance | Cat.Regional)) !== 0;
  if (rank === 0 || (ld && rank < 8)) return 0;
  if ((rail && rank < 20) || (cats & Cat.Coach && rank < 6)) return 1;
  if (rail || rank < 12) return 2;
  return 3;
}

/** Line width unit of one category from trips/day (log scale). */
export function catWidth(cat: number, tpd: number, snapped = true): number {
  const w = Math.min(5, 0.8 + 0.75 * Math.log1p(Math.max(0, tpd)));
  return w * (cat === Cat.Bus ? 0.6 : 1) * (snapped ? 1 : 0.65);
}

/** Trips/day behind a line width (inverse of catWidth, approximate: widths are rounded); Infinity at the widest. */
export function tpdFromWidth(cat: number, w: number, snapped = true): number {
  const base = w / ((cat === Cat.Bus ? 0.6 : 1) * (snapped ? 1 : 0.65));
  if (base >= 4.99) return Infinity;
  return Math.max(0, Math.exp((base - 0.8) / 0.75) - 1);
}

export function haversineKm(a: [number, number], b: [number, number]): number {
  const r = Math.PI / 180;
  const h = Math.sin(((b[1] - a[1]) * r) / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
