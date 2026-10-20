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
  name: string;
}

/**
 * Discs around the larger cities (radius grows with the population: about 4 km for 100 000 inhabitants up to 16 km
 * for the biggest metropolises): the city a stop name may repeat (stripCityName) and the cities of the transit profiles.
 */
export function cityDiscs(places: Place[], minPop: number): CityDisc[] {
  return places
    .filter((p) => p.population >= minPop)
    .map((p) => ({ lon: p.lon, lat: p.lat, r: Math.min(16_000, Math.max(3500, 4000 * Math.sqrt(p.population / 100_000))), name: p.name }));
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
  /** Name of the biggest-disc city around a point (for tidying "City, Stop" names), or "". */
  cityAt(lon: number, lat: number): string {
    const a = this.cells.get(`${Math.floor(lon * 2)},${Math.floor(lat * 2)}`);
    let best: CityDisc | null = null;
    if (a) for (const d of a) if (fastDist(lon, lat, d.lon, d.lat) <= d.r && (!best || d.r > best.r)) best = d;
    return best?.name ?? "";
  }
  /** Whether a point lies in one of the discs. */
  contains(lon: number, lat: number): boolean {
    const a = this.cells.get(`${Math.floor(lon * 2)},${Math.floor(lat * 2)}`);
    if (!a) return false;
    for (const d of a) if (fastDist(lon, lat, d.lon, d.lat) <= d.r) return true;
    return false;
  }
}

/** Longest straight stop span (km) of a local bus line whose buses the intercity network does not carry. */
export const LOCAL_BUS_MAX_KM = 30;

/**
 * Straight-line span (km) of a set of stops: the diagonal of their bounding box, the same measure as the intercity
 * loader's short-bus filter (gtfs/load.ts `minBusKm`).
 */
export function stopSpanKm(stops: { lon: number; lat: number }[]): number {
  if (!stops.length) return 0;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity, sumLat = 0;
  for (const s of stops) {
    minLon = Math.min(minLon, s.lon);
    maxLon = Math.max(maxLon, s.lon);
    minLat = Math.min(minLat, s.lat);
    maxLat = Math.max(maxLat, s.lat);
    sumLat += s.lat;
  }
  const cos = Math.cos(((sumLat / stops.length) * Math.PI) / 180);
  return Math.hypot((maxLat - minLat) * 111.2, (maxLon - minLon) * 111.2 * cos);
}

/**
 * Whether the intercity network carries the buses of a route and from which span on: its feed is a feeds.json feed
 * that loads buses, and the route's agency passes that feed's agency filters and is not one of the city operators
 * the intercity classifier rejects (feeds.json `urbanAgencies`). Null for the extra local feeds (urban-feeds.json).
 */
export interface MainBusRule {
  /** the feed's `minBusKm`: bus trips spanning at least this are part of the intercity network */
  minKm: number;
  /** agency names whose buses the intercity network leaves out */
  dropAgency: RegExp | null;
  /** when set, only these agencies' buses are in the intercity network */
  onlyAgency: RegExp | null;
}

/**
 * Which bus routes the local layer draws: every local bus route (city, town and village buses, island buses) except
 * the ones the intercity network already draws. A route of a feed whose buses the intercity network loads
 * (`main`) is local when its longest pattern spans less than the feed's `minBusKm` (the intercity loader drops exactly
 * those trips), so no line is drawn by both. Routes of the extra local feeds, of feeds without buses in the intercity
 * network and of agencies it rejects are local up to LOCAL_BUS_MAX_KM; longer ones are regional lines. Returns the
 * reason a route is left out, or null when it is kept.
 */
export function busExclusion(spanKm: number, agency: string, main: MainBusRule | null): "main-network" | "long" | null {
  const inMain = !!main && !(main.dropAgency && main.dropAgency.test(agency)) && !(main.onlyAgency && !main.onlyAgency.test(agency));
  if (inMain) return spanKm >= main!.minKm ? "main-network" : null;
  return spanKm > LOCAL_BUS_MAX_KM ? "long" : null;
}

const fold = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * "Freiburg, Hauptstraße" / "Hauptstraße (Freiburg)" / "Hauptstraße, Freiburg" → "Hauptstraße": the map already says
 * which city a stop is in. Only comma and parenthesis forms are touched (a plain "Berlin Hbf" is a name).
 */
export function stripCityName(name: string, city: string): string {
  if (!city) return name;
  const c = fold(city).trim();
  const n = name.trim();
  const f = fold(n);
  let out = n;
  if (f.startsWith(c + ", ")) out = n.slice(city.length + 2);
  else if (f.endsWith(", " + c)) out = n.slice(0, n.length - city.length - 2);
  else if (f.endsWith(" (" + c + ")")) out = n.slice(0, n.length - city.length - 3);
  out = out.trim();
  return out.length >= 2 ? out : name;
}

/**
 * Line colours from feeds range from white to black: keep them readable on the light and the dark map
 * (relative luminance clamped to 0.07 … 0.55 by mixing with black or white).
 */
export function readableColor(hex: string): string {
  const h = hex.replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(h)) return "";
  let rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lum = (v: number[]) => {
    const [r, g, b] = v.map((x) => {
      const s = x / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  for (let i = 0; i < 12 && lum(rgb) > 0.55; i++) rgb = rgb.map((x) => Math.round(x * 0.88));
  for (let i = 0; i < 12 && lum(rgb) < 0.07; i++) rgb = rgb.map((x) => Math.round(x + (255 - x) * 0.16));
  return rgb.map((x) => x.toString(16).padStart(2, "0")).join("");
}
