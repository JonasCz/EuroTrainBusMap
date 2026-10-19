/**
 * Area the map covers: Europe (incl. Iceland, Türkiye, Cyprus and the Mediterranean coast of Africa that lies inside
 * its box) plus Macaronesia and north-west Africa – the Canary Islands, Madeira and Morocco (with Western Sahara
 * down to the Mauritanian border, where the Supratours coaches go).
 *
 * Two ways of using it:
 * - `MAP_BBOX`, the box around all of it, for cheap point filters (GeoNames places, GTFS stops), the basemap tiles
 *   (land outside the coverage boxes is mostly desert: all-land tiles cost no file) and the Hilbert order of the shards;
 * - `COVERAGE_BOXES` where the area matters, i.e. the Overture extractions of the rail / road graphs (the box would
 *   pull in every road of Egypt and Arabia).
 *
 * Changing them changes `COVERAGE_ID`; assets built for another coverage (GeoNames files, borders / labels, graphs,
 * basemap tiles) are then detected as stale (see the README, "Build assets in R2").
 */

/** [xmin, ymin, xmax, ymax] in degrees. */
export type CoverageBox = readonly [number, number, number, number];

export const COVERAGE_BOXES: readonly CoverageBox[] = [
  [-25, 34, 45, 72], // Europe
  [-19, 20.5, -0.9, 34], // Canary Islands, Madeira, Morocco, Western Sahara
];

/** Box around every coverage box. */
export const MAP_BBOX: CoverageBox = [
  Math.min(...COVERAGE_BOXES.map((b) => b[0])),
  Math.min(...COVERAGE_BOXES.map((b) => b[1])),
  Math.max(...COVERAGE_BOXES.map((b) => b[2])),
  Math.max(...COVERAGE_BOXES.map((b) => b[3])),
];

/** Short id of the coverage, stored in assets so a build can tell an asset made for another area. */
export const COVERAGE_ID = "eu-ma";

export function inCoverage(lon: number, lat: number): boolean {
  return COVERAGE_BOXES.some((b) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]);
}
