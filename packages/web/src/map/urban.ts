/**
 * Local transport layers (metro / tram / city bus lines and their stops). The data is a display layer
 * of its own (vector tiles `urb-rail` stored at z10, `urb-bus` at z11, see @etbm/shared urban.ts), drawn
 * below the intercity network. Lines fade in at their own zoom (`z`: metro first, then trams, then buses by
 * frequency); stops thin out over several zoom levels (ETL `thinZooms`), so a city centre fills in
 * step by step instead of showing every stop at once.
 */
import { URBAN_LAYERS, UMODE, type UrbanInfo } from "@etbm/shared";
import type { ExpressionSpecification, FilterSpecification, LayerSpecification } from "maplibre-gl";
import { FONT_MEDIUM, FONT_REGULAR, SOURCE_BOUNDS } from "./style.ts";
import type { Theme } from "./theme.ts";

type Expr = ExpressionSpecification;
const E = (x: unknown) => x as Expr;

export const URBAN_SOURCES = ["urb-rail", "urb-bus"] as const;
/** Zoom ranges over which things fade in after their own zoom. */
const FADE = 0.6;

export function urbanSources(info: UrbanInfo, url: (p: string) => string): Record<string, { type: "vector"; tiles: string[]; minzoom: number; maxzoom: number; bounds: [number, number, number, number] }> {
  const mk = (s: UrbanInfo["rail"]) => ({ type: "vector" as const, tiles: [`etbmgz://${url("")}${s.url}`], minzoom: s.zoom, maxzoom: s.zoom, bounds: SOURCE_BOUNDS });
  return { "urb-rail": mk(info.rail), "urb-bus": mk(info.bus) };
}

/** Tile keys (z/x/y) of both sources. */
export function urbanTileKeys(info: UrbanInfo): string[] {
  const out: string[] = [];
  for (const s of [info.rail, info.bus]) for (let i = 0; i + 1 < s.tiles.length; i += 2) out.push(`${s.zoom}/${s.tiles[i]}/${s.tiles[i + 1]}`);
  return out;
}

/** Opacity ramp after the feature's own zoom `z` (0 at z, base from z + FADE): zoom stops every 0.2. */
function ramp(base: number, from = (): unknown => ["get", "z"]): Expr {
  const stops: unknown[] = [];
  for (let z = 9; z <= 16.01; z += 0.2) stops.push(Math.round(z * 10) / 10, ["*", base, ["max", 0, ["min", 1, ["/", ["-", Math.round(z * 10) / 10, from()], FADE]]]]);
  return E(["interpolate", ["linear"], ["zoom"], ...stops]);
}

const shown: FilterSpecification = E(["<=", ["get", "z"], ["zoom"]]) as unknown as FilterSpecification;

const zoomWidth = (stops: [number, number][], mul = 1): Expr => E(["interpolate", ["linear"], ["zoom"], ...stops.flatMap(([z, w]) => [z, w * mul])]);

export const URBAN_LAYER_IDS = ["urb-rail-cas", "urb-rail", "urb-bus", "urb-bus-stop", "urb-rail-stop", "urb-rail-name", "urb-line-name", "urb-bus-name"] as const;

/** Colour of a line: the feed's colour, else a default per mode. */
function lineColor(t: Theme): Expr {
  return E(["case", ["has", "c"], ["concat", "#", ["get", "c"]], ["match", ["get", "m"], UMODE.Metro, t.urban.metro, UMODE.Tram, t.urban.tram, UMODE.Cable, t.urban.cable, t.urban.bus]]);
}

export function urbanLayers(t: Theme, dim: boolean): LayerSpecification[] {
  const d = dim ? 0.45 : 1;
  const line = URBAN_LAYERS.line, stop = URBAN_LAYERS.stop;
  const lineLayout = { "line-join": "round", "line-cap": "round" } as const;
  const isRail = E(["!=", ["get", "m"], UMODE.Bus]);
  const metro = E(["==", ["get", "m"], UMODE.Metro]);
  const layers: LayerSpecification[] = [];
  // ---- buses: thin, neutral, below everything
  layers.push({
    id: "urb-bus",
    type: "line",
    source: "urb-bus",
    "source-layer": line,
    minzoom: 12,
    filter: shown,
    layout: lineLayout,
    paint: {
      "line-color": dim ? t.dimLine : t.urban.bus,
      "line-width": zoomWidth([[12, 0.7], [14, 1.3], [15, 2.1], [16, 3]]),
      "line-opacity": ramp(dim ? 0.5 : 0.55),
    },
  });
  // ---- metro / tram: a land-coloured halo, then the coloured line
  layers.push({
    id: "urb-rail-cas",
    type: "line",
    source: "urb-rail",
    "source-layer": line,
    minzoom: 10,
    filter: ["all", shown, isRail] as unknown as FilterSpecification,
    layout: lineLayout,
    paint: {
      "line-color": t.land,
      "line-width": E(["interpolate", ["linear"], ["zoom"], 10, ["case", metro, 2.8, 2.2], 13, ["case", metro, 4.4, 3.4], 16, ["case", metro, 6.6, 5.2]]),
      "line-opacity": ramp(dim ? 0.5 : 0.85),
    },
  });
  layers.push({
    id: "urb-rail",
    type: "line",
    source: "urb-rail",
    "source-layer": line,
    minzoom: 10,
    filter: ["all", shown, isRail] as unknown as FilterSpecification,
    layout: { ...lineLayout, "line-sort-key": ["case", metro, 2, 1] },
    paint: {
      "line-color": dim ? t.dimLine : lineColor(t),
      "line-width": E(["interpolate", ["linear"], ["zoom"], 10, ["case", metro, 1.5, 1.1], 13, ["case", metro, 2.6, 2], 16, ["case", metro, 4.2, 3.2]]),
      "line-opacity": ramp(dim ? 0.6 : 1),
      // trams drawn by stop-to-stop chords rather than aligned: dashed so they read as approximate
      "line-dasharray": E(["case", ["all", [">=", ["coalesce", ["get", "g"], 0], 3], ["!=", ["get", "m"], UMODE.Cable]], ["literal", [2, 1.4]], ["literal", [1, 0]]]),
    },
  });
  // ---- stops
  layers.push({
    id: "urb-bus-stop",
    type: "circle",
    source: "urb-bus",
    "source-layer": stop,
    minzoom: 13.8,
    filter: ["all", shown] as unknown as FilterSpecification,
    paint: {
      "circle-radius": zoomWidth([[13.8, 1.6], [15, 2.4], [16, 3.2]]),
      "circle-color": t.markerFill,
      "circle-stroke-color": dim ? t.dimMarker : t.urban.bus,
      "circle-stroke-width": 1,
      "circle-opacity": ramp(0.95),
      "circle-stroke-opacity": ramp(0.9),
      "circle-pitch-alignment": "map",
    },
  });
  const imp = E(["coalesce", ["get", "i"], 0]);
  layers.push({
    id: "urb-rail-stop",
    type: "circle",
    source: "urb-rail",
    "source-layer": stop,
    minzoom: 10.5,
    filter: ["all", shown, ["!", ["has", "x"]]] as unknown as FilterSpecification,
    layout: { "circle-sort-key": imp },
    paint: {
      "circle-radius": E(["interpolate", ["linear"], ["zoom"], 10.5, ["+", 1.3, ["*", 0.18, imp]], 13, ["+", 2.2, ["*", 0.3, imp]], 16, ["+", 3.6, ["*", 0.5, imp]]]),
      "circle-color": t.markerFill,
      "circle-stroke-color": dim ? t.dimMarker : E(["match", ["get", "t"], UMODE.Metro, t.urban.metro, UMODE.Cable, t.urban.cable, t.urban.tram]),
      "circle-stroke-width": E(["interpolate", ["linear"], ["zoom"], 10.5, 1, 14, 1.5, 16, 2]),
      "circle-opacity": ramp(0.97),
      "circle-stroke-opacity": ramp(0.95),
      "circle-pitch-alignment": "map",
    },
  });
  // ---- labels (placed after the intercity labels: they win collisions)
  const stopLabel = (id: string, source: string, minzoom: number, rail: boolean): LayerSpecification => ({
    id,
    type: "symbol",
    source,
    "source-layer": stop,
    minzoom,
    filter: ["all", shown, ["!", ["has", "x"]], ["<=", ["+", ["get", "z"], rail ? 1.2 : 0.4], ["zoom"]]] as unknown as FilterSpecification,
    layout: {
      "text-field": ["get", "n"],
      "text-font": rail ? FONT_MEDIUM : FONT_REGULAR,
      "text-size": E(["interpolate", ["linear"], ["zoom"], minzoom, rail ? 9.5 : 9, 16, rail ? 12 : 11]),
      "text-variable-anchor": ["left", "right", "top", "bottom"],
      "text-radial-offset": 0.7,
      "text-justify": "auto",
      "text-max-width": 8,
      "text-padding": 3,
      "text-optional": true,
      "symbol-sort-key": E(["-", 0, imp]),
    },
    paint: { "text-color": dim ? t.dimText : t.textMuted, "text-halo-color": t.halo, "text-halo-width": 1.6, "text-opacity": ramp(1) },
  });
  layers.push(stopLabel("urb-rail-name", "urb-rail", 12.4, true));
  layers.push(stopLabel("urb-bus-name", "urb-bus", 15, false));
  layers.push({
    id: "urb-line-name",
    type: "symbol",
    source: "urb-rail",
    "source-layer": line,
    minzoom: 12.2,
    filter: ["all", shown, isRail] as unknown as FilterSpecification,
    layout: {
      "symbol-placement": "line",
      "symbol-spacing": 320,
      "text-field": ["get", "n"],
      "text-font": FONT_MEDIUM,
      "text-size": E(["interpolate", ["linear"], ["zoom"], 12.2, 9, 16, 12]),
      "text-keep-upright": true,
      "text-padding": 4,
      "text-max-angle": 40,
    },
    paint: {
      "text-color": dim ? t.dimText : lineColor(t),
      "text-halo-color": t.halo,
      "text-halo-width": 2,
      "text-opacity": ramp(1),
    },
  });
  void FONT_REGULAR;
  return layers;
}

/** Layers a click / hover can hit (stops first). */
export const URBAN_HIT_LAYERS = ["urb-rail-stop", "urb-bus-stop", "urb-rail", "urb-bus"];

export interface UrbanHit {
  kind: "stop" | "line";
  props: Record<string, string | number>;
  lngLat: [number, number];
}
