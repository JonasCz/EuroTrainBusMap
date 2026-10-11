import { GridIndex, fastDist } from "../util/geo.ts";
import { fold, normalizeStopName } from "./names.ts";

export interface Place {
  id: number; // geonameid (or negative for synthetic)
  name: string;
  /** Candidate display names (local language variants). */
  altNames?: string[];
  lon: number;
  lat: number;
  country: string;
  population: number;
  tz: string;
  fcode: string;
  /** Admin codes [admin1, admin2, admin3, admin4]. */
  admin: [string, string, string, string];
  /** Index of the place this one is absorbed into (satellite → parent), or -1. */
  parent?: number;
}

/** Catchment radius in metres: clamp(1.5 km + 2.5 km·log10(pop/1000), 1.5, 18) km. */
export function placeRadius(pop: number): number {
  const km = 1.5 + 2.5 * Math.log10(Math.max(1, pop) / 1000);
  return Math.min(18, Math.max(1.5, km)) * 1000;
}

/** Deepest non-empty admin level (0..3), or -1. */
function deepest(p: Place): number {
  for (let i = 3; i >= 0; i--) if (p.admin[i]) return i;
  return -1;
}

function sameUnit(parent: Place, child: Place, level: number): boolean {
  if (parent.country !== child.country) return false;
  for (let i = 0; i <= level; i++) if (parent.admin[i] !== child.admin[i]) return false;
  return true;
}

/**
 * Resolve satellites in-place: city sections (PPLX) and places inside the
 * same lowest admin unit as a big city (e.g. Spandau → Berlin, Croydon →
 * London (Greater London), Pendik → İstanbul) get `parent` set.
 */
export function resolveSatellites(places: Place[], overrides: Record<string, number> = {}): void {
  const lons = places.map((p) => p.lon), lats = places.map((p) => p.lat);
  const idx = new GridIndex(lons, lats, 0.25);
  for (const p of places) p.parent = -1;
  // Big cities absorb places in their admin unit.
  const order = places.map((_, i) => i).sort((a, b) => places[b]!.population - places[a]!.population);
  for (const ci of order) {
    const c = places[ci]!;
    if (c.parent !== -1) continue;
    if (c.fcode === "PPLX") continue;
    const lvl = deepest(c);
    if (lvl < 0) continue;
    const big = c.population >= 300_000 && /^PPL(C|A|A2|A3|A4)?$/.test(c.fcode);
    const ov = overrides[`${c.country}:${c.name}`];
    const maxD = ov ? ov * 1000 : big ? Math.min(45_000, Math.max(15_000, 2.5 * placeRadius(c.population))) : 15_000;
    for (const j of idx.within(c.lon, c.lat, maxD)) {
      if (j === ci) continue;
      const p = places[j]!;
      if (p.parent !== -1 || p.population >= c.population) continue;
      if (!sameUnit(c, p, lvl)) continue;
      // PPLX are always sections of their unit's main place; other places only for big cities.
      if (p.fcode === "PPLX" || big || ov) p.parent = ci;
    }
  }
}

export interface StopPoint {
  lon: number;
  lat: number;
}

/**
 * Assign each stop to a place index (after satellite resolution) or -1.
 * Score = distance / radius; best (lowest) within radius wins; satellites
 * resolve to their parent. Unmatched stops fall back to the nearest place
 * within `fallbackM`.
 */
export function assignStops(places: Place[], stops: StopPoint[], fallbackM = 5000): Int32Array {
  const lons = places.map((p) => p.lon), lats = places.map((p) => p.lat);
  const idx = new GridIndex(lons, lats, 0.25);
  const out = new Int32Array(stops.length).fill(-1);
  for (let s = 0; s < stops.length; s++) {
    const st = stops[s]!;
    let best = -1, bestScore = Infinity, nearest = -1, nearestD = Infinity;
    for (const j of idx.within(st.lon, st.lat, 18_000)) {
      const p = places[j]!;
      const d = fastDist(st.lon, st.lat, p.lon, p.lat);
      const target = p.parent != null && p.parent >= 0 ? p.parent : j;
      // Satellites use their own radius but count with the parent's weight.
      const r = placeRadius(p.population);
      if (d <= r) {
        const score = d / r;
        if (score < bestScore) {
          bestScore = score;
          best = target;
        }
      }
      if (d < nearestD) {
        nearestD = d;
        nearest = target;
      }
    }
    if (best >= 0) out[s] = best;
    else if (nearest >= 0 && nearestD <= fallbackM) out[s] = nearest;
  }
  return out;
}

/** Derive a town name from a stop name (for synthetic cities). */
export function townFromStopName(name: string): string {
  let n = name.trim();
  n = n.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  // "Town, Stop" / "Town - Stop" / "Town/Stop"
  const parts = n.split(/\s*(?:,|\s-\s|\/|\|)\s*/);
  n = parts[0]!.trim() || n;
  n = n.replace(/\b(Hauptbahnhof|Hbf|Bahnhof|Bf|Bhf|station|Station|gare|Gare|stazione|Stazione|ZOB|Busbahnhof|railway station|Railway Station|bus station|Bus Station|Autobusové nádraží|dworzec|Dworzec|Kirche|Markt|Post|Ort|Ortsmitte|Mitte|Zentrum)\b\.?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return n || name.trim();
}

/**
 * Choose the display name of a city: among candidate names prefer the one
 * that prefixes most of its stops' names (so local names like "München",
 * "Praha", "Genève" are picked), else the first candidate.
 */
export function chooseCityName(candidates: string[], stopNames: string[]): string {
  const uniq = [...new Set(candidates.filter(Boolean))];
  if (uniq.length <= 1 || !stopNames.length) return uniq[0] ?? "";
  const folded = stopNames.slice(0, 200).map((s) => " " + fold(s).replace(/[^a-z0-9]+/g, " ").trim() + " ");
  let best = uniq[0]!, bestScore = -1;
  uniq.forEach((c, i) => {
    const fc = fold(c).replace(/[^a-z0-9]+/g, " ").trim();
    if (!fc) return;
    let n = 0;
    for (const s of folded) {
      if (s.startsWith(" " + fc + " ")) n += 2;
      else if (s.includes(" " + fc + " ")) n += 1;
    }
    // prefer earlier candidates (local preferred names) on ties; prefer longer exact matches
    const score = n * 100 - i + Math.min(fc.length, 20) * 0.01 * (n > 0 ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  });
  return best;
}

export { normalizeStopName };
