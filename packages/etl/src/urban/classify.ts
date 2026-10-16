import { fastDist } from "../util/geo.ts";
import type { Place } from "../core/cities.ts";
import { UMode, type UModeCode } from "./types.ts";

/**
 * Local-transport mode of a (extended) GTFS route_type, or null when the route is not part of the
 * local layer (heavy rail and coaches belong to the intercity network, ferries / taxis / air are out of scope).
 */
export function urbanModeOf(t: number): UModeCode | null {
  if (t === 0 || t === 5 || (t >= 900 && t <= 906)) return UMode.Tram;
  if (t === 1 || t === 12 || t === 401 || t === 402 || t === 405 || t === 400 || t === 404) return UMode.Metro;
  if (t === 6 || t === 7 || t === 1400 || (t >= 1300 && t <= 1307) || t === 1200) return t === 1200 ? null : UMode.Cable;
  if (t === 11 || t === 800 || t === 3) return UMode.Bus;
  if (t >= 700 && t <= 716) {
    // special needs, sightseeing, shuttle, school, rail replacement, demand responsive
    if ([706, 707, 710, 711, 712, 714, 715, 716].includes(t)) return null;
    return UMode.Bus;
  }
  return null;
}

/** Rail-replacement and similar services are never local transport. */
export const NOT_LOCAL_RE =
  /(\bsev\b|schienenersatz|ersatzverkehr|\bev\d*\b|rail replacement|replacement bus|bus replacement|treinvervangend|\bnáhradní|\bnahradna|\bzka\b|zastępcza|substitution|sostitutivo|ersatzbus|\bsv\s?\d|school|schul|skolebus|\bscol|shuttle|sightseeing|airport express|flixbus|flibco|blablacar)/i;

export interface CityDisc {
  lon: number;
  lat: number;
  r: number;
}

/**
 * Discs around the larger cities in which bus lines count as "city buses": radius grows with the
 * population (about 4 km for 100 000 inhabitants up to 16 km for the biggest metropolises).
 */
export function cityDiscs(places: Place[], minPop: number): CityDisc[] {
  return places
    .filter((p) => p.population >= minPop)
    .map((p) => ({ lon: p.lon, lat: p.lat, r: Math.min(16_000, Math.max(3500, 4000 * Math.sqrt(p.population / 100_000))) }));
}

/** Grid lookup of the discs. */
export class DiscIndex {
  private cells = new Map<string, CityDisc[]>();
  constructor(discs: CityDisc[]) {
    for (const d of discs) {
      const r = d.r / 111_000 + 0.01;
      for (let ix = Math.floor((d.lon - r * 1.7) * 2); ix <= Math.floor((d.lon + r * 1.7) * 2); ix++)
        for (let iy = Math.floor((d.lat - r) * 2); iy <= Math.floor((d.lat + r) * 2); iy++) {
          const k = `${ix},${iy}`;
          let a = this.cells.get(k);
          if (!a) this.cells.set(k, (a = []));
          a.push(d);
        }
    }
  }
  /** Whether a point lies in one of the discs. */
  contains(lon: number, lat: number): boolean {
    const a = this.cells.get(`${Math.floor(lon * 2)},${Math.floor(lat * 2)}`);
    if (!a) return false;
    for (const d of a) if (fastDist(lon, lat, d.lon, d.lat) <= d.r) return true;
    return false;
  }
}

/**
 * Whether a bus line is a city bus: short (the straight span of its stops is below `maxSpanKm`) and
 * at least `share` of its stops lie inside the disc of a big city.
 */
export function isCityBus(stops: { lon: number; lat: number }[], idx: DiscIndex, maxSpanKm = 30, share = 0.6): boolean {
  if (stops.length < 2) return false;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity, inside = 0;
  for (const s of stops) {
    minLon = Math.min(minLon, s.lon);
    maxLon = Math.max(maxLon, s.lon);
    minLat = Math.min(minLat, s.lat);
    maxLat = Math.max(maxLat, s.lat);
    if (idx.contains(s.lon, s.lat)) inside++;
  }
  const span = fastDist(minLon, minLat, maxLon, maxLat) / 1000;
  return span <= maxSpanKm && inside / stops.length >= share;
}
