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

/** Farthest a big city absorbs a place of its administrative unit (m), unless overridden. */
export const MAX_ABSORB_M = 30_000;

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
    // Absorbing a place only groups its stations under the big city for selection ("where can I go from
    // London"); stations are drawn individually. So the reach stays modest: ~1.8 catchment radii, 30 km at most.
    const maxD = ov ? ov * 1000 : big ? Math.min(MAX_ABSORB_M, Math.max(12_000, 1.8 * placeRadius(c.population))) : 15_000;
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
 * Part of the catchment radius inside which a station belongs to a place whatever its name:
 * 45 % for a village, growing with the population to the whole radius from 200 000 inhabitants
 * (a big city groups all its stations and suburbs; a small town only its own).
 */
export function placeCore(pop: number): number {
  const r = placeRadius(pop);
  const t = Math.min(1, Math.max(0.45, 0.45 + (0.55 * Math.log10(Math.max(pop, 1000) / 5000)) / Math.log10(40)));
  return r * t;
}

/** " foo bar " (folded, alphanumerics only) for substring tests on whole words. */
export function foldKey(name: string): string {
  const k = fold(name).replace(/[^a-z0-9]+/g, " ").trim();
  return k ? ` ${k} ` : "";
}

/** Names a station of this place may carry (the place's and, for satellites, its parent's). */
export function placeKeys(places: Place[], j: number): string[] {
  const out: string[] = [];
  for (let p: Place | undefined = places[j], depth = 0; p && depth < 2; depth++, p = p.parent != null && p.parent >= 0 ? places[p.parent] : undefined) {
    for (const n of [p.name, ...(p.altNames ?? []).slice(0, 4)]) {
      const k = foldKey(n.replace(/\s*\([^)]*\)/g, ""));
      if (k.length >= 5 && !out.includes(k)) out.push(k);
    }
  }
  return out;
}

export interface StationPoint extends StopPoint {
  /** folded names of the station's stops (foldKey) */
  names: string[];
  /**
   * Rail / coach stations are drawn as stations of a named place: beyond the core of a place they
   * only belong to it when their name carries the place's name. Bus-only stops keep the plain
   * catchment rule (nearest place, within 5 km as a fallback).
   */
  strict: boolean;
}

/** How far (m) a station whose name carries the place's name may lie from it: 1.3 radii, at least 5 km (Aix-en-Provence TGV). */
export const nameReachM = (r: number) => Math.max(1.3 * r, 5000);

/**
 * Assign each station to a place index (satellites resolve to their parent) or −1 (→ a synthetic
 * town named after the station). Candidates are the places whose catchment contains the station;
 * the lowest distance / radius wins, halved when the station's name carries the place's name. For
 * rail / coach stations a candidate must also be within the place's core or match by name
 * (villages next to a town keep their own stations: Anchamps ≠ Revin, Limerick Junction ≠ Tipperary).
 */
export function assignStations(places: Place[], stations: StationPoint[], fallbackM = 5000): Int32Array {
  const idx = new GridIndex(places.map((p) => p.lon), places.map((p) => p.lat), 0.25);
  const keyCache = new Map<number, string[]>();
  const keysOf = (j: number) => {
    let k = keyCache.get(j);
    if (!k) keyCache.set(j, (k = placeKeys(places, j)));
    return k;
  };
  const out = new Int32Array(stations.length).fill(-1);
  for (let s = 0; s < stations.length; s++) {
    const st = stations[s]!;
    let best = -1, bestScore = Infinity, nearest = -1, nearestD = Infinity;
    for (const j of idx.within(st.lon, st.lat, 24_000)) {
      const p = places[j]!;
      const d = fastDist(st.lon, st.lat, p.lon, p.lat);
      const target = p.parent != null && p.parent >= 0 ? p.parent : j;
      const r = placeRadius(p.population);
      if (d < nearestD) {
        nearestD = d;
        nearest = target;
      }
      const section = p.fcode === "PPLX";
      const reach = r;
      if (!st.strict) {
        if (d <= reach && d / r < bestScore) [best, bestScore] = [target, d / r];
        continue;
      }
      const named = st.names.length > 0 && d <= nameReachM(r) && keysOf(j).some((k) => st.names.some((n) => n.includes(k)));
      if (d > reach && !named) continue;
      if (!named && !section && d > placeCore(p.population)) continue;
      const score = (d / r) * (named ? 0.5 : 1);
      if (score < bestScore) [best, bestScore] = [target, score];
    }
    if (best >= 0) out[s] = best;
    else if (!st.strict && nearest >= 0 && nearestD <= fallbackM) out[s] = nearest;
  }
  return out;
}

export interface NamedStation extends StopPoint {
  /** normalizeStopName of the station's name */
  norm: string;
  strict: boolean;
}

/**
 * Bus-only stations keep the plain catchment rule, which can put the bus stops of an out-of-town station
 * into the nearest town (the stops "Limerick Junction", 900 m from the station, into Tipperary). A bus-only
 * station that carries exactly the name of a rail / coach station within `radiusM` joins that station's place
 * (−1 = the station's own synthetic town). Returns the number of stations moved. Mutates `placeOf`.
 */
export function adoptStationNames(stations: NamedStation[], placeOf: Int32Array, radiusM = 1000): number {
  const strict: number[] = [];
  stations.forEach((s, i) => s.strict && s.norm.length >= 4 && strict.push(i));
  if (!strict.length) return 0;
  const idx = new GridIndex(strict.map((i) => stations[i]!.lon), strict.map((i) => stations[i]!.lat), 0.02);
  let moved = 0;
  stations.forEach((s, i) => {
    if (s.strict || s.norm.length < 4) return;
    let best = -1, bd = Infinity;
    for (const k of idx.within(s.lon, s.lat, radiusM)) {
      const j = strict[k]!;
      if (stations[j]!.norm !== s.norm) continue;
      const d = fastDist(s.lon, s.lat, stations[j]!.lon, stations[j]!.lat);
      if (d < bd) [best, bd] = [j, d];
    }
    if (best >= 0 && placeOf[i] !== placeOf[best]) {
      placeOf[i] = placeOf[best]!;
      moved++;
    }
  });
  return moved;
}

/** Derive a town name from a stop name (for synthetic cities). */
export function townFromStopName(name: string): string {
  let n = name.trim();
  // "[Enschede] Voorzijde station" / "[cadavéu Cadavedo] Rotonda [CTA 16975]": a leading bracket names the place, trailing ones are codes
  const lead = /^\[([^\]]{2,30})\]/.exec(n);
  n = n.replace(/\[[^\]]*\]/g, " ").trim();
  if (lead) n = `${lead[1]!.charAt(0).toUpperCase()}${lead[1]!.slice(1)}`.trim() || n;
  n = n.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  // "Town, Stop" / "Town - Stop" / "Town/Stop"
  const parts = n.split(/\s*(?:,|\s-\s|\/|\|)\s*/);
  n = parts[0]!.trim() || n;
  n = n.replace(/\b(Hauptbahnhof|Hbf|Bahnhof|Bf|Bhf|station|Station|gare|Gare|stazione|Stazione|ZOB|Busbahnhof|railway station|Railway Station|bus station|Bus Station|Autobusové nádraží|dworzec|Dworzec|Kirche|Markt|Post|Ort|Ortsmitte|Mitte|Zentrum)\b\.?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // "Gare de Haulmé" → "Haulmé", "Station am Markt" stays
  n = n.replace(/^(?:(?:de la|de|du|des|di|del|della|van|von)\s+|de l'|d'|dell')/i, "").trim();
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
