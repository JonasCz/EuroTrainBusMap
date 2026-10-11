/**
 * Network layer specifications. The base network comes from vector tiles
 * (source "net", layers seg/term/city/st – see @etbm/shared netmap.ts); the
 * selection layers come from small client-built GeoJSON sources.
 *
 * Tile features are filter-independent: each segment carries per-category
 * widths `w{k}`, LOD levels `l{k}` and Deutschlandticket flags `d{k}`, and the
 * style expressions below pack the categories that are visible (under the
 * current filters, at the current LOD level) side by side.
 */
import { CAT_BITS, Cat, TILE_LAYERS } from "@etbm/shared";
import type { ExpressionSpecification, FilterSpecification, LayerSpecification } from "maplibre-gl";
import type * as GeoJSON from "geojson";
import { effectiveCats, type Filters } from "../logic/filters.ts";
import { GAP } from "./features.ts";
import { LEVELS, LONG_HOP_ZOOM, STATION_LEVELS, STATION_ZOOM } from "./lod.ts";
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
 * Zoom stops: width factor stops plus each LOD level. (MapLibre evaluates
 * zoom-and-property expressions at integer zooms and interpolates, so extra
 * "just before the level" stops would not sharpen anything – they only make
 * the expressions bigger to compile.)
 */
function zoomStops(zf: [number, number][]): number[] {
  const zs = new Set<number>(zf.map((s) => s[0]));
  for (const l of LEVELS) if (l > 0) zs.add(l);
  return [...zs].sort((a, b) => a - b);
}

// ---------------------------------------------------------------- bundle expressions on tile features

/** Whether category k of a feature is drawn at LOD level L under the filters. */
function vis(k: number, L: number, f: Filters): unknown {
  if (!(effectiveCats(f) & k)) return false;
  const c: unknown[] = ["all", ["has", `w${k}`], ["<=", ["get", `l${k}`], L]];
  if (f.dticket) c.push(["has", `d${k}`]);
  return c;
}
const wOf = (k: number) => ["get", `w${k}`];
/** Total bundle width (units) at level L. */
function total(L: number, f: Filters): unknown {
  return ["max", 0, ["-", ["+", 0, ...CAT_BITS.map((k) => ["case", vis(k, L, f), ["+", wOf(k), GAP], 0])], GAP]];
}
/** Offset of category k's centre line at level L. */
function offset(k: number, L: number, f: Filters): unknown {
  const before = CAT_BITS.filter((j) => j < k).map((j) => ["case", vis(j, L, f), ["+", wOf(j), GAP], 0]);
  return ["+", ["*", -0.5, total(L, f)], 0, ...before, ["*", 0.5, wOf(k)]];
}

function byZoom(zf: [number, number][], at: (z: number, factor: number, L: number) => unknown, fixedLevel?: number): Expr {
  const stops: unknown[] = [];
  for (const z of fixedLevel === undefined ? zoomStops(zf) : zf.map((s) => s[0])) stops.push(z, at(z, factorAt(z, zf), fixedLevel ?? lvlAt(z)));
  return E(["interpolate", ["linear"], ["zoom"], ...stops]);
}

function catColorConst(t: Theme, k: number): string {
  return t.cat[k] ?? "#888";
}

function catColor(t: Theme): Expr {
  return E(["match", ["get", "cat"], Cat.LongDistance, t.cat[Cat.LongDistance], Cat.Regional, t.cat[Cat.Regional], Cat.Coach, t.cat[Cat.Coach], Cat.Bus, t.cat[Cat.Bus], "#888"]);
}

/** Highlight (GeoJSON) widths/offsets: plain properties scaled by zoom. */
function scaled(prop: string, zf: [number, number][], add = 0): Expr {
  const stops: unknown[] = [];
  for (const [z, f] of zf) stops.push(z, add ? ["+", ["*", f, ["get", prop]], add] : ["*", f, ["get", prop]]);
  return E(["interpolate", ["linear"], ["zoom"], ...stops]);
}

const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export const GEOJSON_SOURCES = ["hl-casing", "hl", "focus", "focus-stations"] as const;

export function geojsonSources(): Record<string, { type: "geojson"; data: GeoJSON.FeatureCollection; tolerance?: number; buffer?: number; maxzoom?: number }> {
  const out: Record<string, { type: "geojson"; data: GeoJSON.FeatureCollection; tolerance?: number; buffer?: number; maxzoom?: number }> = {};
  for (const s of GEOJSON_SOURCES) out[s] = { type: "geojson", data: empty, ...(s.startsWith("hl") ? { tolerance: 0.45, buffer: 32 } : { buffer: 64 }), maxzoom: 12 };
  return out;
}

export const CITY_LAYERS = ["city-c", "city-l"];
const range = (n: number) => [...Array(n).keys()];
export const FOCUS_LAYERS = [...range(LEVELS.length).flatMap((i) => [`focus-c-${i}`, `focus-l-${i}`])];
export const STATION_LAYERS = [...range(STATION_LEVELS.length).flatMap((i) => [`station-c-${i}`, `station-l-${i}`]), "fstation-c", "fstation-l"];

export interface LayerState {
  dimmed: boolean;
  filters: Filters;
  /** cities drawn by the focus layers (hidden from the base city layers) */
  focus: number[];
  /** selected cities whose stations come from the focus-stations source */
  selected: number[];
}

/** Base city filter: visible from max(tier zoom, earliest visible line) under the filters. */
export function cityFilter(st: LayerState): FilterSpecification {
  const f = st.filters;
  const cats = CAT_BITS.filter((k) => effectiveCats(f) & k);
  const zOf = (k: number) => ["coalesce", ["get", `${f.dticket ? "n" : "m"}${k}`], 99];
  const minLine = cats.length ? ["min", 99, ...cats.map(zOf)] : 99;
  const zoomOk = [">=", ["+", ["zoom"], 0.5], ["max", ["get", "tz"], minLine]];
  return (st.focus.length ? ["all", zoomOk, ["!", ["in", ["get", "id"], ["literal", st.focus]]]] : zoomOk) as FilterSpecification;
}

function stationFilter(i: number, st: LayerState): FilterSpecification {
  const lz = ["==", ["get", "lz"], i];
  return (st.selected.length ? ["all", lz, ["!", ["in", ["get", "city"], ["literal", st.selected]]]] : lz) as FilterSpecification;
}

export function networkLayers(t: Theme, st: LayerState): LayerSpecification[] {
  const dim = st.dimmed;
  const f = st.filters;
  const layers: LayerSpecification[] = [];
  const lineLayout = { "line-join": "round", "line-cap": "round" } as const;
  const wMul = dim ? 0.6 : 1;
  const cats = CAT_BITS.filter((k) => effectiveCats(f) & k);
  const catFilter = (k: number): unknown[] => ["all", ["has", `w${k}`], ...(f.dticket ? [["has", `d${k}`]] : [])];

  // ---- base network
  // seg (city-level geometry, below STATION_ZOOM); at station zoom lead-in pieces ("term") are
  // replaced by end pieces drawn to the actual stations (layer "term")
  const variants: { id: string; layer: string; zr: { minzoom?: number; maxzoom?: number }; filter: unknown[]; fixed?: number }[] = [
    { id: "net", layer: TILE_LAYERS.seg, zr: { maxzoom: STATION_ZOOM }, filter: [] },
    { id: "net-st", layer: TILE_LAYERS.seg, zr: { minzoom: STATION_ZOOM }, filter: [["!", ["has", "term"]]], fixed: LEVELS.length - 1 },
    { id: "net-term", layer: TILE_LAYERS.term, zr: { minzoom: STATION_ZOOM }, filter: [], fixed: LEVELS.length - 1 },
  ];
  const anyCat: unknown[] = ["any", ...cats.map((k) => catFilter(k))];
  for (const v of variants) {
    layers.push({
      id: `${v.id}-cas`,
      type: "line",
      source: "net",
      "source-layer": v.layer,
      ...v.zr,
      filter: ["all", ["!", ["has", "hop"]], anyCat, ...v.filter] as unknown as FilterSpecification,
      layout: lineLayout,
      paint: {
        "line-color": t.land,
        "line-width": byZoom(ZF, (_z, fz, L) => ["case", [">", total(L, f), 0], ["+", ["*", fz * wMul, total(L, f)], 1.6], 0], v.fixed),
        "line-opacity": dim ? 0.6 : 1,
      },
    });
  }
  // long straight hops: thin dashed, from LONG_HOP_ZOOM
  for (const k of [...cats].reverse()) {
    layers.push({
      id: `net-hop-${k}`,
      type: "line",
      source: "net",
      "source-layer": TILE_LAYERS.seg,
      minzoom: LONG_HOP_ZOOM,
      filter: ["all", ["has", "hop"], ...catFilter(k).slice(1)] as unknown as FilterSpecification,
      layout: { "line-cap": "round" },
      paint: {
        "line-color": dim ? t.dimLine : catColorConst(t, k),
        "line-width": ["interpolate", ["linear"], ["zoom"], 6.5, 0.8, 10, 1.5],
        "line-dasharray": [2, 3],
        "line-opacity": dim ? 0.5 : ["interpolate", ["linear"], ["zoom"], 6.5, 0.25, 9, 0.5, STATION_ZOOM, 0.35],
      },
    });
  }
  for (const v of variants) {
    // buses below rail: draw categories in reverse order
    for (const k of [...cats].reverse()) {
      layers.push({
        id: `${v.id}-${k}`,
        type: "line",
        source: "net",
        "source-layer": v.layer,
        ...v.zr,
        filter: ["all", ["!", ["has", "hop"]], ...catFilter(k).slice(1), ...v.filter] as unknown as FilterSpecification,
        layout: { ...lineLayout, "line-sort-key": ["coalesce", ["get", "k"], 0] },
        paint: {
          "line-color": dim ? t.dimLine : catColorConst(t, k),
          "line-width": byZoom(ZF, (_z, fz, L) => ["case", vis(k, L, f), ["*", fz * wMul, wOf(k)], 0], v.fixed),
          "line-offset": byZoom(ZF, (_z, fz, L) => ["*", fz * wMul, offset(k, L, f)], v.fixed),
          "line-opacity": dim ? 1 : k === Cat.Bus ? 0.65 : ["case", ["==", ["get", "u"], 1], 0.8, 1],
        },
      });
    }
  }

  // ---- highlighted corridors (selection), always above the dimmed network
  for (const g of [0, 1]) {
    const zr = g ? { minzoom: STATION_ZOOM } : { maxzoom: STATION_ZOOM };
    layers.push({
      id: `hl-cas-${g}`,
      type: "line",
      source: "hl-casing",
      ...zr,
      filter: ["in", ["get", "g"], ["literal", [g, 2]]],
      layout: lineLayout,
      paint: { "line-color": t.land, "line-width": scaled("t", ZF_HL, 2.4) },
    });
    layers.push({
      id: `hl-${g}`,
      type: "line",
      source: "hl",
      ...zr,
      filter: ["all", ["in", ["get", "g"], ["literal", [g, 2]]], ["==", ["get", "hop"], 0]],
      layout: { ...lineLayout, "line-sort-key": ["get", "k"] },
      paint: { "line-color": catColor(t), "line-width": scaled("w", ZF_HL), "line-offset": scaled("o", ZF_HL) },
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

  // ---- city markers (base, from tiles)
  const hover: Expr = E(["boolean", ["feature-state", "hover"], false]);
  const radius = (z: number, scale: number): Expr => {
    const base = z <= 3 ? ["+", 0.8, ["*", 2.4, ["get", "imp"]]] : z <= 6 ? ["+", 1.2, ["*", 3, ["get", "imp"]]] : z <= 8 ? ["+", 1.8, ["*", 3.6, ["get", "imp"]]] : ["+", 2.6, ["*", 4.4, ["get", "imp"]]];
    const cover = z >= 7 ? ["+", ["*", (wMul * factorAt(z, ZF)) / 2, ["get", "mw"]], 1.2] : 0;
    return E(["+", ["*", scale, ["max", base, cover]], ["case", hover, 1.5, 0]]);
  };
  const cityRadius = (scale: number): Expr => E(["interpolate", ["linear"], ["zoom"], 3, radius(3, scale), 6, radius(6, scale), 8, radius(8, scale), 10.5, radius(10.5, scale)]);
  const cityFilt = cityFilter(st);
  layers.push({
    id: "city-c",
    type: "circle",
    source: "net",
    "source-layer": TILE_LAYERS.city,
    maxzoom: STATION_ZOOM,
    filter: cityFilt,
    layout: { "circle-sort-key": ["get", "imp"] },
    paint: {
      "circle-radius": cityRadius(dim ? 0.75 : 1),
      "circle-color": dim ? t.land : t.markerFill,
      "circle-stroke-color": dim ? t.dimMarker : t.markerStroke,
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 3, ["case", [">=", ["get", "imp"], 0.8], 1.3, 1], 8, 1.6, 10, 2],
      "circle-pitch-alignment": "map",
    },
  });
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
  for (let i = LEVELS.length - 1; i >= 0; i--)
    layers.push({
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

  // ---- stations (z ≥ STATION_ZOOM): tiles, plus the selected cities' stations
  const stationCircle = (id: string, src: { source: string; "source-layer"?: string }, minzoom: number, filter?: FilterSpecification, base = true): LayerSpecification =>
    ({
      id,
      type: "circle",
      ...src,
      minzoom,
      ...(filter ? { filter } : {}),
      layout: { "circle-sort-key": ["-", 0, ["get", "rank"]] },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], STATION_ZOOM, ["case", ["==", ["get", "major"], 1], 4.5, 3], 15, ["case", ["==", ["get", "major"], 1], 8, 5.5]],
        "circle-color": t.markerFill,
        "circle-stroke-color": t.markerStroke,
        "circle-stroke-width": ["case", ["==", ["get", "rail"], 1], 2.2, 1.6],
        "circle-opacity": dim && base ? 0.6 : 1,
        "circle-stroke-opacity": dim && base ? 0.45 : 1,
      },
    }) as LayerSpecification;
  const stationLabel = (id: string, src: { source: string; "source-layer"?: string }, minzoom: number, filter?: FilterSpecification, base = true): LayerSpecification =>
    ({
      id,
      type: "symbol",
      ...src,
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
        "text-color": dim && base ? t.dimText : ["case", ["==", ["get", "major"], 1], t.text, t.textMuted],
        "text-halo-color": t.halo,
        "text-halo-width": 2,
      },
    }) as LayerSpecification;
  const stSrc = { source: "net", "source-layer": TILE_LAYERS.station };
  for (let i = STATION_LEVELS.length - 1; i >= 0; i--) layers.push(stationCircle(`station-c-${i}`, stSrc, STATION_LEVELS[i]!, stationFilter(i, st)));
  layers.push(stationCircle("fstation-c", { source: "focus-stations" }, STATION_ZOOM, undefined, false));

  // ---- labels (placement priority: top layer first)
  const cityLabel = (id: string, src: { source: string; "source-layer"?: string }, minzoom: number, filter: FilterSpecification, focus: boolean): LayerSpecification =>
    ({
      id,
      type: "symbol",
      ...src,
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
        "symbol-sort-key": focus ? ["get", "rank"] : ["-", 1, ["get", "imp"]],
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
    source: "net",
    "source-layer": TILE_LAYERS.city,
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
      "symbol-sort-key": ["-", 1, ["get", "imp"]],
    },
    paint: { "text-color": t.countryText, "text-opacity": 0.75, "text-halo-color": t.land, "text-halo-width": 1 },
  });
  layers.push(cityLabel("city-l", { source: "net", "source-layer": TILE_LAYERS.city }, 0, cityFilt, false));
  for (let i = STATION_LEVELS.length - 1; i >= 0; i--) layers.push(stationLabel(`station-l-${i}`, stSrc, STATION_LEVELS[i]!, stationFilter(i, st)));
  for (let i = LEVELS.length - 1; i >= 0; i--) layers.push(cityLabel(`focus-l-${i}`, { source: "focus" }, LEVELS[i]!, ["==", ["get", "lz"], i], true));
  layers.push(stationLabel("fstation-l", { source: "focus-stations" }, STATION_ZOOM, undefined, false));
  return layers;
}
