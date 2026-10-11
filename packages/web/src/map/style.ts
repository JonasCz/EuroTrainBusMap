/** Base map style: our own GeoJSON basemap + vendored glyphs. No tile server. */
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";
import { absUrl } from "../data/load.ts";
import type { Theme } from "./theme.ts";

export const FONT_REGULAR = ["Noto Sans Regular"];
export const FONT_MEDIUM = ["Noto Sans Medium"];
export const FONT_ITALIC = ["Noto Sans Italic"];

export function glyphsUrl(): string {
  return absUrl("glyphs/") + "{fontstack}/{range}.pbf";
}

export function baseStyle(theme: Theme, basemapUrl: (name: string) => string): StyleSpecification {
  return {
    version: 8,
    glyphs: glyphsUrl(),
    projection: { type: "globe" },
    sources: {
      land: { type: "geojson", data: basemapUrl("land"), buffer: 4, tolerance: 0.3 },
      lakes: { type: "geojson", data: basemapUrl("lakes"), tolerance: 0.3 },
      borders: { type: "geojson", data: basemapUrl("borders"), tolerance: 0.3 },
      countries: { type: "geojson", data: basemapUrl("labels") },
    },
    layers: baseLayers(theme),
  };
}

export function baseLayers(t: Theme): LayerSpecification[] {
  return [
    { id: "ocean", type: "background", paint: { "background-color": t.ocean } },
    { id: "land", type: "fill", source: "land", paint: { "fill-color": t.land, "fill-antialias": true } },
    { id: "lakes", type: "fill", source: "lakes", paint: { "fill-color": t.lake } },
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
