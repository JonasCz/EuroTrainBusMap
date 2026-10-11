/**
 * City anchor points. A city's drawn point (dot, label, and the point every corridor
 * geometry is attached to) is its main station, not the GeoNames centroid: lines then run
 * straight through the station instead of kinking towards a point beside the track
 * (e.g. "Tipperary" vs. Limerick Junction, 4 km apart; Hamm Hbf vs. the town centre).
 *
 * Main station: the busiest rail station when the city has rail service, else the busiest
 * stop; busy = calls/day weighted by category (long-distance counts most).
 */
import { Cat } from "@etbm/shared";

export interface AnchorCity {
  lon: number;
  lat: number;
}
export interface AnchorStation {
  city: number;
  lon: number;
  lat: number;
}
export interface AnchorPattern {
  stations: number[];
}

const RAIL = Cat.LongDistance | Cat.Regional;
export const catWeight = (cat: number) => (cat === Cat.LongDistance ? 3 : cat === Cat.Coach ? 1.5 : cat === Cat.Regional ? 1 : 0.3);

/** Per city: index of its main station, or -1 if none of its stations is served. */
export function mainStations(
  nCities: number,
  stations: AnchorStation[],
  patterns: AnchorPattern[],
  days: ArrayLike<number>,
  catOf: (p: number) => number,
): Int32Array {
  const score = new Float64Array(stations.length);
  const rail = new Uint8Array(stations.length);
  for (let p = 0; p < patterns.length; p++) {
    const w = days[p] ?? 0;
    if (!w) continue;
    const cat = catOf(p);
    const sts = patterns[p]!.stations;
    for (const s of sts) {
      score[s]! += w * catWeight(cat);
      if (cat & RAIL) rail[s] = 1;
    }
  }
  const best = new Int32Array(nCities).fill(-1);
  const bestRail = new Uint8Array(nCities);
  for (let s = 0; s < stations.length; s++) {
    if (!score[s] && !rail[s]) continue;
    const c = stations[s]!.city;
    const b = best[c]!;
    if (b < 0 || rail[s]! > bestRail[c]! || (rail[s] === bestRail[c] && score[s]! > score[b]!)) {
      best[c] = s;
      bestRail[c] = rail[s]!;
    }
  }
  return best;
}

/** Move every served city's point onto its main station (in place). Returns the number moved. */
export function anchorCitiesAtMainStation(
  cities: AnchorCity[],
  stations: AnchorStation[],
  patterns: AnchorPattern[],
  days: ArrayLike<number>,
  catOf: (p: number) => number,
  log?: (s: string) => void,
): number {
  const best = mainStations(cities.length, stations, patterns, days, catOf);
  let moved = 0, far = 0;
  for (let c = 0; c < cities.length; c++) {
    const s = best[c]!;
    if (s < 0) continue;
    const city = cities[c]!, st = stations[s]!;
    if (city.lon === st.lon && city.lat === st.lat) continue;
    const dx = (st.lon - city.lon) * 111_320 * Math.cos((city.lat * Math.PI) / 180), dy = (st.lat - city.lat) * 110_540;
    if (Math.hypot(dx, dy) > 2000) far++;
    city.lon = st.lon;
    city.lat = st.lat;
    moved++;
  }
  log?.(`city anchors: ${moved} cities moved onto their main station (${far} by more than 2 km)`);
  return moved;
}
