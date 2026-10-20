/**
 * Transfers between two stations of a city. Every change between stations is a walk or, if the traveller
 * chooses so ("Cycle" in the transfer settings), a bike ride, or ("Transit") a metro / tram / suburban rail or local
 * bus ride timed from the local timetables where that is faster (transit.ts); walks and bike rides are
 * estimated conservatively from the straight-line distance: a detour factor for the street network, a slow
 * pace and a fixed buffer, rounded up. The ETL stores the walking minutes per station pair (`CityFile.transfers`,
 * the transfer timetable chunks) for every pair within `TRANSFER_MAX_M`; the web app derives the cycling minutes
 * from them (`cycleMinutesFromWalk`) and applies the cap of the chosen mode (`changeOf`, `changeMinutes`), and uses the same
 * functions for the distance it shows. Pairs beyond the cap are not offered.
 */

/**
 * How changes between two stations of a city are made: walked, cycled where faster, or by local public transport
 * (metro, tram, suburban rail, local bus) where faster and running at that hour (see transit.ts); "transit" without transit data
 * for a pair is walked.
 */
export type ChangeBy = "walk" | "bike" | "transit";

/** Street-network detour over the straight line (walking and cycling alike, so both show the same distance). */
export const WALK_DETOUR = 1.3;
/** Walking pace, metres per minute (4.5 km/h). */
export const WALK_M_PER_MIN = 75;
/** Fixed buffer per walking transfer (finding the exit, the platform), minutes. */
export const WALK_BUFFER_MIN = 3;
/** Longest walking transfer offered, minutes (≈ 8.8 km walked); farther station pairs have no transfer. */
export const WALK_MAX_MIN = 120;
/** Straight-line distance of the longest walking transfer, metres (6750 m). */
export const WALK_MAX_M = ((WALK_MAX_MIN - WALK_BUFFER_MIN) * WALK_M_PER_MIN) / WALK_DETOUR;

/**
 * Cycling pace including stops at junctions and traffic lights, metres per minute (14 km/h). Measured average
 * urban cycling speeds: about 15–15.5 km/h in Copenhagen (City of Copenhagen, Bicycle Account), 14.4 km/h in
 * Amsterdam and 16.9 km/h in Arnhem (Fietsersbond national cycling survey, 2017); many studies assume 15 km/h.
 * We take the conservative end (the crowded Amsterdam figure, rounded down) as cities without Dutch / Danish
 * cycling infrastructure are slower, and the traveller may be on an unfamiliar hire bike with luggage.
 */
export const CYCLE_M_PER_MIN = 14000 / 60;
/** Fixed buffer per cycling transfer: leaving the station, taking / unlocking the bike, parking or docking it, finding the platform; minutes. */
export const CYCLE_BUFFER_MIN = 5;
/** Longest cycling transfer offered, minutes (≈ 12.8 km ridden); farther station pairs have no transfer. */
export const CYCLE_MAX_MIN = 60;
/** Straight-line distance of the longest cycling transfer, metres (≈ 9870 m). */
export const CYCLE_MAX_M = ((CYCLE_MAX_MIN - CYCLE_BUFFER_MIN) * CYCLE_M_PER_MIN) / WALK_DETOUR;
/** Station pairs within this straight-line distance get a stored transfer (the larger of the two caps), metres. */
export const TRANSFER_MAX_M = Math.max(WALK_MAX_M, CYCLE_MAX_M);

/** Walking minutes for a straight-line distance (metres): ceil(dist · 1.3 / 75 m/min) + 3. */
export function walkMinutes(distM: number): number {
  return Math.ceil((distM * WALK_DETOUR) / WALK_M_PER_MIN) + WALK_BUFFER_MIN;
}

/**
 * Cycling minutes for a stored walking time: the street distance it stands for (at most (walk − 3) · 75 m, the
 * walk being rounded up) at 14 km/h, rounded up, plus 5 min. Derived from the walk so the data needs no second
 * number per pair; the rounding of the walk adds at most 75 m (≈ 20 s), so this is conservative by under a minute.
 */
export function cycleMinutesFromWalk(walkMin: number): number {
  const streetM = Math.max(0, walkMin - WALK_BUFFER_MIN) * WALK_M_PER_MIN;
  return Math.ceil(streetM / CYCLE_M_PER_MIN - 1e-9) + CYCLE_BUFFER_MIN;
}

/** Cycling minutes for a straight-line distance (metres), consistent with the search (`cycleMinutesFromWalk`). */
export function cycleMinutes(distM: number): number {
  return cycleMinutesFromWalk(walkMinutes(distM));
}

/** How the change between two stations with a stored walking time is made: "bike" only when chosen and faster. */
function changeKind(walkMin: number, by: ChangeBy): ChangeBy | undefined {
  const walkOk = walkMin <= WALK_MAX_MIN;
  if (by === "bike") {
    const c = cycleMinutesFromWalk(walkMin);
    // a short change is walked when that is no slower (no bike for 200 m)
    if (c <= CYCLE_MAX_MIN && !(walkOk && walkMin <= c)) return "bike";
  }
  return walkOk ? "walk" : undefined;
}

/**
 * The change between two stations with a stored walking time: the minutes and how it is made (`by`: walked, or
 * cycled when "bike" is chosen and that is faster), or undefined beyond the range of the chosen mode.
 */
export function changeOf(walkMin: number, by: ChangeBy): { min: number; by: ChangeBy } | undefined {
  const k = changeKind(walkMin, by);
  return k === undefined ? undefined : { min: k === "bike" ? cycleMinutesFromWalk(walkMin) : walkMin, by: k };
}

/** Minutes of the change between two stations with a stored walking time (`changeOf`); Infinity beyond range. */
export function changeMinutes(walkMin: number, by: ChangeBy): number {
  const k = changeKind(walkMin, by);
  return k === undefined ? Infinity : k === "bike" ? cycleMinutesFromWalk(walkMin) : walkMin;
}

/** Estimated walking (or cycling) distance (metres, along streets) for a straight-line distance. */
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
