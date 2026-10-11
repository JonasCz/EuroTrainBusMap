/**
 * Network layer specifications. Detail is bucketed by LOD level ("lz"
 * property) into one layer per level with the matching minzoom.
 */
import { Cat } from "@etbm/shared";
import type { ExpressionSpecification, FilterSpecification, LayerSpecification } from "maplibre-gl";
import type * as GeoJSON from "geojson";
import { LEVELS, STATION_LEVELS, STATION_ZOOM } from "./lod.ts";
import { FONT_MEDIUM, FONT_REGULAR } from "./style.ts";
import type { Theme } from "./theme.ts";

export { STATION_ZOOM };

/** Zoom → px per width unit (base network: thin at overview). */
const ZF: [number, number][] = [
  [2, 0.32],
  [4, 0.5],
  [5.5, 0.72],
  [7, 1.0],
  [9, 1.45],
  [11, 1.8],
  [13, 2.1],
  [15, 2.5],
];
/** Highlighted corridors are bolder at low zoom. */
const ZF_HL: [number, number][] = [
  [2, 0.75],
  [4, 0.95],
  [6, 1.15],
  [8, 1.45],
  [11, 2.0],
  [15, 2.8],
];

function factorAt(z: number, zf: [number, number][]): number {
  if (z <= zf[0]![0]) return zf[0]![1];
  for (let i = 1; i < zf.length; i++) {
    const [z1, f1] = zf[i]!;
    const [z0, f0] = zf[i - 1]!;
    if (z <= z1) return f0 + ((f1 - f0) * (z - z0)) / (z1 - z0);
  }
  return zf[zf.length - 1]![1];
}

type Expr = ExpressionSpecification;
const E = (x: unknown) => x as Expr;

function lvlAt(z: number): number {
  let i = 0;
  LEVELS.forEach((l, k) => {
    if (l <= z + 1e-9) i = k;
  });
  return i;
}

/**
 * Zoom-interpolated "factor × property" where the property may change per LOD
 * level: uses `${prop}${level}` when present, else `${prop}`.
 */
function scaledByLevel(prop: string, opts: { add?: number; mul?: Expr; zf?: [number, number][]; perLevel?: boolean } = {}): Expr {
  const zf = opts.zf ?? ZF;
  const zs = new Set<number>(zf.map((s) => s[0]));
  if (opts.perLevel) for (const l of LEVELS) if (l > 0) zs.add(l).add(Math.round((l - 0.01) * 100) / 100);
  const stops: unknown[] = [];
  for (const z of [...zs].sort((a, b) => a - b)) {
    const f = factorAt(z, zf);
    let v: unknown = opts.perLevel ? ["coalesce", ["get", `${prop}${lvlAt(z)}`], ["get", prop]] : ["get", prop];
    if (opts.mul) v = ["*", v, opts.mul];
    v = ["*", f, v];
    if (opts.add) v = ["+", v, opts.add];
    stops.push(z, v);
  }
  return E(["interpolate", ["linear"], ["zoom"], ...stops]);
}

function catColor(t: Theme): Expr {
  return E(["match", ["get", "cat"], Cat.LongDistance, t.cat[Cat.LongDistance], Cat.Regional, t.cat[Cat.Regional], Cat.Coach, t.cat[Cat.Coach], Cat.Bus, t.cat[Cat.Bus], "#888"]);
}

const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export const SOURCES = ["casing", "corridors", "hops", "st-casing", "st-corridors", "hl-casing", "hl", "cities", "focus", "stations", "focus-stations"] as const;

export function networkSources(): Record<string, { type: "geojson"; data: GeoJSON.FeatureCollection; tolerance?: number; buffer?: number; maxzoom?: number }> {
  const out: Record<string, { type: "geojson"; data: GeoJSON.FeatureCollection; tolerance?: number; buffer?: number; maxzoom?: number }> = {};
  for (const s of SOURCES) {
    const line = !["cities", "focus", "stations", "focus-stations"].includes(s);
    out[s] = { type: "geojson", data: empty, ...(line ? { tolerance: 0.45, buffer: 32 } : { buffer: 64 }), maxzoom: 12 };
  }
  return out;
}

const range = (n: number) => [...Array(n).keys()];
export const CITY_CIRCLE_LAYERS = range(LEVELS.length).map((i) => `city-c-${i}`);
export const CITY_LABEL_LAYERS = range(LEVELS.length).map((i) => `city-l-${i}`);
export const FOCUS_LAYERS = [...range(LEVELS.length).flatMap((i) => [`focus-c-${i}`, `focus-l-${i}`])];
export const STATION_LAYERS = [...range(STATION_LEVELS.length).flatMap((i) => [`station-c-${i}`, `station-l-${i}`]), "fstation-c", "fstation-l"];

/** Layers whose paint depends on the selection state (re-applied on change). */
export interface LayerState {
  dimmed: boolean;
}

export function networkLayers(t: Theme, st: LayerState): LayerSpecification[] {
  const dim = st.dimmed;
  const layers: LayerSpecification[] = [];
  const lineLayout = { "line-join": "round", "line-cap": "round" } as const;

  // ---- base network (city geometry), bucketed by level
  for (let i = 0; i < LEVELS.length; i++) {
    layers.push({
      id: `corr-cas-${i}`,
      type: "line",
      source: "casing",
      minzoom: LEVELS[i]!,
      maxzoom: STATION_ZOOM,
      filter: ["==", ["get", "lz"], i],
      layout: lineLayout,
      paint: { "line-color": t.land, "line-width": scaledByLevel("t", { add: 1.6, perLevel: true }), "line-opacity": dim ? 0.6 : 1 },
    });
  }
  layers.push({
    id: "corr-hops",
    type: "line",
    source: "hops",
    minzoom: 6.5,
    layout: { "line-cap": "round" },
    paint: {
      "line-color": dim ? t.dimLine : catColor(t),
      "line-width": ["interpolate", ["linear"], ["zoom"], 6.5, 0.8, 10, 1.5],
      "line-dasharray": [2, 3],
      "line-opacity": dim ? 0.5 : ["interpolate", ["linear"], ["zoom"], 6.5, 0.25, 9, 0.5],
    },
  });
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    layers.push({
      id: `corr-${i}`,
      type: "line",
      source: "corridors",
      minzoom: LEVELS[i]!,
      maxzoom: STATION_ZOOM,
      filter: ["==", ["get", "lz"], i],
      layout: { ...lineLayout, "line-sort-key": ["get", "k"] },
      paint: {
        "line-color": dim ? t.dimLine : catColor(t),
        "line-width": scaledByLevel("w", dim ? { mul: E(0.6) } : {}),
        "line-offset": scaledByLevel("o", { perLevel: true, ...(dim ? { mul: E(0.6) } : {}) }),
        "line-opacity": dim ? 1 : ["case", ["==", ["get", "cat"], Cat.Bus], 0.65, ["==", ["get", "u"], 1], 0.8, 1],
      },
    });
  }
  // ---- station zoom: interior segments from the base network; segments touching a city point
  // ("term") are replaced by end pieces drawn to the actual stations (st-* sources)
  const notTerm: FilterSpecification = ["!=", ["get", "term"], 1];
  layers.push({
    id: "corr-st-cas",
    type: "line",
    source: "casing",
    minzoom: STATION_ZOOM,
    filter: notTerm,
    layout: lineLayout,
    paint: { "line-color": t.land, "line-width": scaledByLevel("t", { add: 2 }) },
  });
  layers.push({
    id: "corr-st",
    type: "line",
    source: "corridors",
    minzoom: STATION_ZOOM,
    filter: notTerm,
    layout: { ...lineLayout, "line-sort-key": ["get", "k"] },
    paint: {
      "line-color": dim ? t.dimLine : catColor(t),
      "line-width": scaledByLevel("w", dim ? { mul: E(0.6) } : {}),
      "line-offset": scaledByLevel("o", dim ? { mul: E(0.6) } : {}),
      "line-opacity": dim ? 1 : ["case", ["==", ["get", "cat"], Cat.Bus], 0.65, ["==", ["get", "u"], 1], 0.8, 1],
    },
  });
  layers.push({
    id: "st-casing",
    type: "line",
    source: "st-casing",
    minzoom: STATION_ZOOM,
    layout: lineLayout,
    paint: { "line-color": t.land, "line-width": scaledByLevel("t", { add: 2 }) },
  });
  layers.push({
    id: "st-hops",
    type: "line",
    source: "st-corridors",
    minzoom: STATION_ZOOM,
    filter: ["==", ["get", "hop"], 1],
    layout: { "line-cap": "round" },
    paint: { "line-color": dim ? t.dimLine : catColor(t), "line-width": 1.4, "line-dasharray": [2, 3], "line-opacity": 0.35 },
  });
  layers.push({
    id: "st-corridors",
    type: "line",
    source: "st-corridors",
    minzoom: STATION_ZOOM,
    filter: ["==", ["get", "hop"], 0],
    layout: { ...lineLayout, "line-sort-key": ["get", "k"] },
    paint: {
      "line-color": dim ? t.dimLine : catColor(t),
      "line-width": scaledByLevel("w", dim ? { mul: E(0.6) } : {}),
      "line-offset": scaledByLevel("o", dim ? { mul: E(0.6) } : {}),
      "line-opacity": dim ? 1 : ["case", ["==", ["get", "cat"], Cat.Bus], 0.65, ["==", ["get", "u"], 1], 0.8, 1],
    },
  });
  // ---- highlighted corridors (selection), always above the dimmed network
  for (const g of [0, 1]) {
    const zr = g ? { minzoom: STATION_ZOOM } : { maxzoom: STATION_ZOOM };
    layers.push({
      id: `hl-cas-${g}`,
      type: "line",
      source: "hl-casing",
      ...zr,
      filter: ["==", ["get", "g"], g],
      layout: lineLayout,
      paint: { "line-color": t.land, "line-width": scaledByLevel("t", { add: 2.4, zf: ZF_HL }) },
    });
    layers.push({
      id: `hl-${g}`,
      type: "line",
      source: "hl",
      ...zr,
      filter: ["all", ["==", ["get", "g"], g], ["==", ["get", "hop"], 0]],
      layout: { ...lineLayout, "line-sort-key": ["get", "k"] },
      paint: { "line-color": catColor(t), "line-width": scaledByLevel("w", { zf: ZF_HL }), "line-offset": scaledByLevel("o", { zf: ZF_HL }) },
    });
  }
  layers.push({
    id: "hl-hops",
    type: "line",
    source: "hl",
    filter: ["==", ["get", "hop"], 1],
    layout: { "line-cap": "round" },
    paint: { "line-color": catColor(t), "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1.2, 10, 2.2], "line-dasharray": [2, 2], "line-opacity": 0.75 },
  });

  // ---- city markers (base), bucketed by level
  const hover: Expr = E(["boolean", ["feature-state", "hover"], false]);
  const radius = (z: number, f: number, scale = 1): Expr => {
    const base = z <= 3 ? ["+", 0.8, ["*", 2.4, ["get", "imp"]]] : z <= 6 ? ["+", 1.2, ["*", 3, ["get", "imp"]]] : z <= 8 ? ["+", 1.8, ["*", 3.6, ["get", "imp"]]] : ["+", 2.6, ["*", 4.4, ["get", "imp"]]];
    const cover = z >= 7 ? ["+", ["*", (f * factorAt(z, ZF)) / 2, ["get", "mw"]], 1.2] : 0;
    return E(["+", ["*", scale, ["max", base, cover]], ["case", hover, 1.5, 0]]);
  };
  const cityRadius = (f: number, scale = 1): Expr =>
    E(["interpolate", ["linear"], ["zoom"], 3, radius(3, f, scale), 6, radius(6, f, scale), 8, radius(8, f, scale), 10.5, radius(10.5, f, scale)]);
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    layers.push({
      id: `city-c-${i}`,
      type: "circle",
      source: "cities",
      minzoom: LEVELS[i]!,
      maxzoom: STATION_ZOOM,
      filter: ["==", ["get", "lz"], i],
      layout: { "circle-sort-key": ["get", "imp"] },
      paint: {
        "circle-radius": dim ? cityRadius(0.6, 0.75) : cityRadius(1),
        "circle-color": dim ? t.land : t.markerFill,
        "circle-stroke-color": dim ? t.dimMarker : t.markerStroke,
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 3, ["case", [">=", ["get", "imp"], 0.8], 1.3, 1], 8, 1.6, 10, 2],
        "circle-pitch-alignment": "map",
      },
    });
  }
  // ---- selection: reachable cities (small dots) + origin/destination
  const sel: Expr = E([">", ["get", "sel"], 0]);
  const focusStop = (z: number, add: number): unknown => {
    const v = z <= 3 ? ["case", sel, 5, ["+", 1.4, ["*", 2.2, ["get", "imp"]]]] : z <= 7 ? ["case", sel, 7, ["+", 2, ["*", 3, ["get", "imp"]]]] : ["case", sel, 9, ["+", 3, ["*", 4, ["get", "imp"]]]];
    return ["+", v, add, ["case", hover, 1.5, 0]];
  };
  const focusR = (add: number): Expr => E(["interpolate", ["linear"], ["zoom"], 3, focusStop(3, add), 7, focusStop(7, add), 10.5, focusStop(10.5, add)]);
  const fade: Expr = E(["interpolate", ["linear"], ["zoom"], STATION_ZOOM, 1, STATION_ZOOM + 0.5, ["case", sel, 1, 0]]);
  layers.push({
    id: "focus-ring",
    type: "circle",
    source: "focus",
    filter: [">", ["get", "sel"], 0],
    paint: { "circle-radius": focusR(6), "circle-color": t.accent, "circle-opacity": 0.16, "circle-pitch-alignment": "map" },
  });
  for (let i = LEVELS.length - 1; i >= 0; i--) layers.push({
    id: `focus-c-${i}`,
    type: "circle",
    source: "focus",
    minzoom: LEVELS[i]!,
    filter: ["==", ["get", "dz"], i],
    layout: { "circle-sort-key": ["case", sel, 2, ["get", "imp"]] },
    paint: {
      "circle-radius": focusR(0),
      "circle-color": ["case", sel, t.accent, t.markerFill],
      "circle-stroke-color": ["case", sel, t.markerFill, t.markerStroke],
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 3, ["case", sel, 2.5, 1], 8, ["case", sel, 2.5, 1.6]],
      "circle-opacity": fade,
      "circle-stroke-opacity": fade,
      "circle-pitch-alignment": "map",
    },
  });

  // ---- stations (z ≥ STATION_ZOOM)
  const stationCircle = (id: string, source: string, minzoom: number, filter?: unknown): LayerSpecification =>
    ({
      id,
      type: "circle",
      source,
      minzoom,
      ...(filter ? { filter } : {}),
      layout: { "circle-sort-key": ["-", 0, ["get", "rank"]] },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], STATION_ZOOM, ["case", ["==", ["get", "major"], 1], 4.5, 3], 15, ["case", ["==", ["get", "major"], 1], 8, 5.5]],
        "circle-color": t.markerFill,
        "circle-stroke-color": t.markerStroke,
        "circle-stroke-width": ["case", ["==", ["get", "rail"], 1], 2.2, 1.6],
        "circle-opacity": dim && source === "stations" ? 0.6 : 1,
        "circle-stroke-opacity": dim && source === "stations" ? 0.45 : 1,
      },
    }) as LayerSpecification;
  const stationLabel = (id: string, source: string, minzoom: number, filter?: unknown): LayerSpecification =>
    ({
      id,
      type: "symbol",
      source,
      minzoom,
      ...(filter ? { filter } : {}),
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["case", ["==", ["get", "rail"], 1], ["literal", FONT_MEDIUM], ["literal", FONT_REGULAR]],
        "text-size": ["interpolate", ["linear"], ["zoom"], STATION_ZOOM, ["case", ["==", ["get", "major"], 1], 12, 10.5], 15, ["case", ["==", ["get", "major"], 1], 15, 13]],
        "text-variable-anchor": ["left", "right", "top", "bottom"],
        "text-radial-offset": 0.8,
        "text-justify": "auto",
        "text-max-width": 9,
        "symbol-sort-key": ["get", "rank"],
        "text-padding": 2,
      },
      paint: {
        "text-color": dim && source === "stations" ? t.dimText : ["case", ["==", ["get", "major"], 1], t.text, t.textMuted],
        "text-halo-color": t.halo,
        "text-halo-width": 2,
      },
    }) as LayerSpecification;
  for (let i = STATION_LEVELS.length - 1; i >= 0; i--) layers.push(stationCircle(`station-c-${i}`, "stations", STATION_LEVELS[i]!, ["==", ["get", "lz"], i]));
  layers.push(stationCircle("fstation-c", "focus-stations", STATION_ZOOM));

  // ---- labels (placement priority: top layer first)
  const cityLabel = (id: string, source: string, minzoom: number, filter: unknown, focus: boolean): LayerSpecification =>
    ({
      id,
      type: "symbol",
      source,
      minzoom,
      maxzoom: STATION_ZOOM,
      filter,
      layout: {
        "text-field": ["get", "name"],
        "text-font": focus
          ? ["case", ["any", sel, [">=", ["get", "imp"], 0.72]], ["literal", FONT_MEDIUM], ["literal", FONT_REGULAR]]
          : ["case", [">=", ["get", "imp"], 0.72], ["literal", FONT_MEDIUM], ["literal", FONT_REGULAR]],
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          3,
          ["+", 8.5, ["*", 5, ["get", "imp"]], focus ? ["case", sel, 2.5, 0] : 0],
          8,
          ["+", 10, ["*", 5, ["get", "imp"]], focus ? ["case", sel, 2.5, 0] : 0],
        ],
        "text-variable-anchor": ["left", "right", "top", "bottom", "top-left", "bottom-left", "top-right", "bottom-right"],
        "text-radial-offset": ["interpolate", ["linear"], ["zoom"], 3, 0.45, 8, ["+", 0.55, ["*", 0.5, ["get", "imp"]]]],
        "text-justify": "auto",
        "text-max-width": 8,
        "text-padding": focus ? 3 : 7,
        "symbol-sort-key": ["get", "rank"],
      },
      paint: {
        "text-color": dim && !focus ? t.dimText : t.text,
        "text-halo-color": t.halo,
        "text-halo-width": 2,
        "text-opacity": dim && !focus ? 0.8 : 1,
      },
    }) as LayerSpecification;
  // city name as a faint area label once the city has broken out into stations
  layers.push({
    id: "city-area-l",
    type: "symbol",
    source: "cities",
    minzoom: STATION_ZOOM,
    maxzoom: 14,
    filter: [">=", ["get", "ns"], 2],
    layout: {
      "text-field": ["upcase", ["get", "name"]],
      "text-font": FONT_MEDIUM,
      "text-size": ["interpolate", ["linear"], ["zoom"], STATION_ZOOM, ["+", 13, ["*", 8, ["get", "imp"]]], 14, ["+", 16, ["*", 10, ["get", "imp"]]]],
      "text-letter-spacing": 0.25,
      "text-max-width": 12,
      "text-padding": 20,
      "symbol-sort-key": ["get", "rank"],
    },
    paint: { "text-color": t.countryText, "text-opacity": 0.75, "text-halo-color": t.land, "text-halo-width": 1 },
  });
  for (let i = LEVELS.length - 1; i >= 0; i--) layers.push(cityLabel(`city-l-${i}`, "cities", LEVELS[i]!, ["==", ["get", "lz"], i], false));
  for (let i = STATION_LEVELS.length - 1; i >= 0; i--) layers.push(stationLabel(`station-l-${i}`, "stations", STATION_LEVELS[i]!, ["==", ["get", "lz"], i]));
  for (let i = LEVELS.length - 1; i >= 0; i--) layers.push(cityLabel(`focus-l-${i}`, "focus", LEVELS[i]!, ["==", ["get", "lz"], i], true));
  layers.push(stationLabel("fstation-l", "focus-stations", STATION_ZOOM));
  return layers;
}
