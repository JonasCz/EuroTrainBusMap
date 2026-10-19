/** Base map style: our own GeoJSON basemap + vendored glyphs. No tile server. */
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";
import { absUrl } from "../data/load.ts";
import type { Theme } from "./theme.ts";
import { MAP_BBOX } from "@etbm/shared";

/** Tile sources never ask for tiles outside the map's box (packages/shared/src/coverage.ts) plus a margin. */
export const SOURCE_BOUNDS: [number, number, number, number] = [MAP_BBOX[0] - 7, MAP_BBOX[1] - 2, MAP_BBOX[2] + 17, MAP_BBOX[3] + 3];

export const FONT_REGULAR = ["Noto Sans Regular"];
export const FONT_MEDIUM = ["Noto Sans Medium"];

/** Glyph ranges every view needs (Latin, Latin Extended A/B), fetched before MapLibre asks for them. */
export function glyphPrefetchUrls(): string[] {
  const base = absUrl("glyphs/");
  return [...FONT_REGULAR, ...FONT_MEDIUM].flatMap((f) => ["0-255", "256-511", "512-767"].map((r) => `${base}${encodeURIComponent(f)}/${r}.pbf.gz`));
}

/** Glyph PBFs are stored gzipped (static hosts don't compress protobuf); see protocol.ts. */
export function glyphsUrl(): string {
  return "etbmgz://" + absUrl("glyphs/") + "{fontstack}/{range}.pbf.gz";
}

/**
 * `tiles`: root URL of the land / lake vector tiles (BasemapInfo), or null to draw the 1:50m GeoJSON
 * land / lakes in `basemap/` (dev fixtures).
 */
export function baseStyle(theme: Theme, basemapUrl: (name: string) => string, tiles: { root: string; minzoom: number; maxzoom: number; bounds: [number, number, number, number] } | null = null): StyleSpecification {
  return {
    version: 8,
    glyphs: glyphsUrl(),
    projection: { type: "globe" },
    sources: {
      ...(tiles
        ? { base: { type: "vector", tiles: [`etbmbase://${tiles.root}tiles/{z}/{x}/{y}.pbf.gz`], minzoom: tiles.minzoom, maxzoom: tiles.maxzoom, bounds: tiles.bounds } }
        : {
            land: { type: "geojson", data: basemapUrl("land"), buffer: 4, tolerance: 0.3 },
            lakes: { type: "geojson", data: basemapUrl("lakes"), tolerance: 0.3 },
          }),
      borders: { type: "geojson", data: basemapUrl("borders"), tolerance: 0.3 },
      countries: { type: "geojson", data: basemapUrl("labels") },
    },
    layers: baseLayers(theme, !!tiles),
  };
}

export function baseLayers(t: Theme, tiles = false): LayerSpecification[] {
  return [
    { id: "ocean", type: "background", paint: { "background-color": t.ocean } },
    tiles
      ? { id: "land", type: "fill", source: "base", "source-layer": "land", paint: { "fill-color": t.land, "fill-antialias": true } }
      : { id: "land", type: "fill", source: "land", paint: { "fill-color": t.land, "fill-antialias": true } },
    tiles
      ? { id: "lakes", type: "fill", source: "base", "source-layer": "lake", paint: { "fill-color": t.lake, "fill-antialias": true } }
      : { id: "lakes", type: "fill", source: "lakes", paint: { "fill-color": t.lake } },
    {
      id: "borders",
      type: "line",
      source: "borders",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": t.border,
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 7, 1.1, 12, 1.6],
        "line-dasharray": [3, 2],
      },
    },
    {
      id: "country-labels",
      type: "symbol",
      source: "countries",
      maxzoom: 7.5,
      filter: ["<=", ["get", "rank"], 4],
      layout: {
        "text-field": ["upcase", ["get", "name"]],
        "text-font": FONT_MEDIUM,
        "text-size": ["interpolate", ["linear"], ["zoom"], 3, 9.5, 6, 12],
        "text-letter-spacing": 0.22,
        "text-max-width": 7,
        "symbol-sort-key": ["get", "rank"],
        "text-padding": 6,
      },
      paint: {
        "text-color": t.countryText,
        "text-halo-color": t.land,
        "text-halo-width": 1,
        "text-opacity": ["interpolate", ["linear"], ["zoom"], 6.5, 1, 7.5, 0],
      },
    },
  ];
}
