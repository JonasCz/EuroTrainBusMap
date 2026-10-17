/**
 * Walking transfers between two stations of a city. Every change between stations is a walk (never a
 * metro / bus ride we do not model), estimated conservatively from the straight-line distance:
 * a detour factor for the street network, a slow walking pace and a fixed buffer, rounded up. The
 * ETL stores these minutes per station pair (`CityFile.transfers`, the transfer timetable chunks) and the
 * web app uses the same functions for the distance it shows; pairs beyond `WALK_MAX_MIN` are not offered.
 */

/** Street-network detour over the straight line. */
export const WALK_DETOUR = 1.3;
/** Walking pace, metres per minute (4.5 km/h). */
export const WALK_M_PER_MIN = 75;
/** Fixed buffer per walking transfer (finding the exit, the platform), minutes. */
export const WALK_BUFFER_MIN = 3;
/** Longest walking transfer offered, minutes (≈ 8.8 km walked); farther station pairs have no transfer. */
export const WALK_MAX_MIN = 120;
/** Straight-line distance of the longest walking transfer, metres (6750 m). */
export const WALK_MAX_M = ((WALK_MAX_MIN - WALK_BUFFER_MIN) * WALK_M_PER_MIN) / WALK_DETOUR;

/** Walking minutes for a straight-line distance (metres): ceil(dist · 1.3 / 75 m/min) + 3. */
export function walkMinutes(distM: number): number {
  return Math.ceil((distM * WALK_DETOUR) / WALK_M_PER_MIN) + WALK_BUFFER_MIN;
}

/** Estimated walking distance (metres, along streets) for a straight-line distance. */
export function walkDistanceM(distM: number): number {
  return distM * WALK_DETOUR;
}

/** Great-circle distance in metres. */
export function distanceM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}
