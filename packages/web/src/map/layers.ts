/**
 * Network layer specifications. The base network comes from vector tiles
 * (source "net", layers seg/city/st – see @etbm/shared netmap.ts); the
 * selection layers come from small client-built GeoJSON sources.
 *
 * Tile features are filter-independent: each segment carries per-category
 * widths `w{k}`, and LOD levels `l{k}` (every mode on) / `s{k}` (packed levels
 * with other modes hidden), and the style expressions below pick the level of
 * the current filters and pack the categories that are visible (under the
 * current filters, at the current LOD level) side by side.
 */
import { CAT_BITS, Cat, SCEN_BASE, SCEN_DIGITS, TILE_LAYERS, scenarioDigit } from "@etbm/shared";
import type { ExpressionSpecification, FilterSpecification, LayerSpecification } from "maplibre-gl";
import type * as GeoJSON from "geojson";
import type { Filters } from "../logic/filters.ts";
import { GAP } from "./features.ts";
import { FADE_ZOOM, LEVELS, LONG_HOP_ZOOM, STATION_LEVELS, STATION_ZOOM } from "./lod.ts";
import { FONT_MEDIUM, FONT_REGULAR } from "./style.ts";
import type { Theme } from "./theme.ts";

export { STATION_ZOOM };

/**
 * Zoom → px per width unit of the base network. Deliberately grows much slower than the map
 * scale (which doubles per zoom level): lines get relatively thinner the further one zooms in,
 * so the ink per screen area stays similar and dense areas (London, Ruhr) never clog at z6–9,
 * while a few-px line (unit ≈ 1–5) stays legible overview and detail alike.
 */
const ZF: [number, number][] = [
  [2, 0.36],
  [4, 0.48],
  [6, 0.62],
  [8, 0.7],
  [10, 0.7],
  [12, 0.7],
  [15, 0.9],
];
/** Highlighted corridors are bolder than the base network, but also flatten out when zoomed in. */
const ZF_HL: [number, number][] = [
  [2, 0.75],
  [4, 0.9],
  [6, 1.0],
  [8, 1.05],
  [11, 1.2],
  [15, 1.5],
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
  // a level's lines are laid out (width, side-by-side offsets) FADE_ZOOM before it, while fading in
  for (const l of LEVELS) if (l > 0) zs.add(r3(l - FADE_ZOOM));
  return [...zs].filter((z) => z >= zf[0]![0]).sort((a, b) => a - b);
}

// ---------------------------------------------------------------- fade-in

const r3 = (x: number) => Math.round(x * 1000) / 1000;
/** Level index → zoom the level starts at (level 0 = always on). */
const LEVEL_ZOOM: number[] = LEVELS.map((l, i) => (i === 0 ? -1 : l));
/** Fade 0 → 1 over the FADE_ZOOM zoom levels that end at `end` (an expression or number), evaluated at zoom z. */
const fadeAt = (z: number, end: unknown): unknown => ["max", 0, ["min", 1, ["+", 1, ["/", ["-", z, end], FADE_ZOOM]]]];
/**
 * Zoom stops of an interpolation that must follow a fade-in that ends at any LOD level (shifted by
 * `shift`): the fade is piecewise linear with kinks where a fade starts and ends.
 */
function fadeStops(shift: number): number[] {
  const zs = new Set<number>([2]);
  for (const l of LEVELS) {
    if (l <= 0) continue;
    for (const z of [l + shift - FADE_ZOOM, l + shift]) if (z > 2) zs.add(r3(z));
  }
  return [...zs].sort((a, b) => a - b);
}
/**
 * A packed mode-scenario level (`s{k}` on segments, `n{k}` on cities, see netmap.ts): the level of
 * category k when only the categories of the filter are shown. Falls back to `plain` (all categories)
 * where the feature has no packed value or every other category is on.
 */
function scenarioLevel(k: number, f: Filters, plain: unknown, packed: string, map = (lv: unknown) => lv): unknown {
  const d = scenarioDigit(CAT_BITS.indexOf(k as (typeof CAT_BITS)[number]), f.cats);
  if (d >= SCEN_DIGITS) return plain;
  return ["case", ["has", packed], map(["%", ["floor", ["/", ["get", packed], SCEN_BASE ** d]], SCEN_BASE]), plain];
}
/** LOD level index of category k of a segment under the filters. */
export const levelOf = (k: number, f: Filters): unknown => scenarioLevel(k, f, ["get", `l${k}`], `s${k}`);
/** line-opacity of one category: a feature is fully shown at its own level and fades in over the FADE_ZOOM before. */
function lineFade(k: number, f: Filters, base: unknown): Expr {
  const start = ["at", levelOf(k, f), ["literal", LEVEL_ZOOM]];
  return E(["interpolate", ["linear"], ["zoom"], ...fadeStops(0).flatMap((z) => [z, ["*", base, fadeAt(z, start)]])]);
}
/** Casing opacity: follows the earliest-fading category present on the feature. */
function casingFade(cats: number[], f: Filters, base: unknown): Expr {
  const one = (z: number) => cats.map((k) => ["case", ["has", `l${k}`], fadeAt(z, ["at", levelOf(k, f), ["literal", LEVEL_ZOOM]]), 0]);
  return E(["interpolate", ["linear"], ["zoom"], ...fadeStops(0).flatMap((z) => [z, ["*", base, ["max", 0, ...one(z)]]])]);
}
/** Fade of a plain layer that starts at zoom z0 (station levels). */
const rampFrom = (z0: number, to: number): Expr => E(["interpolate", ["linear"], ["zoom"], z0, 0, z0 + FADE_ZOOM, to]);

// ---------------------------------------------------------------- bundle expressions on tile features

/** Whether category k of a feature is drawn at LOD level L under the filters. */
function vis(k: number, L: number, f: Filters): unknown {
  if (!(f.cats & k)) return false;
  return ["all", ["has", `w${k}`], ["<=", levelOf(k, f), L]];
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
  for (const z of fixedLevel === undefined ? zoomStops(zf) : zf.map((s) => s[0])) stops.push(z, at(z, factorAt(z, zf), fixedLevel ?? lvlAt(z + FADE_ZOOM)));
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
/** The faint city name over a city's stations (station zoom): a click on it selects the city, not a station. */
export const CITY_AREA_LAYER = "city-area-l";
/** Soft rings around the stations of a selected city. */
export const RING_LAYERS = ["member-ring-major", "member-ring-minor"];

/** Linear blend of two #rrggbb colours (t = share of b). */
export function mix(a: string, b: string, t: number): string {
  const p = (c: string, i: number) => parseInt(c.slice(1 + 2 * i, 3 + 2 * i), 16);
  return "#" + [0, 1, 2].map((i) => Math.round(p(a, i) * (1 - t) + p(b, i) * t).toString(16).padStart(2, "0")).join("");
}
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
/** Zoom at which a city marker is fully shown (CITY_LEAD later); it is in the tiles and fades in FADE_ZOOM before that. */
const CITY_LEAD = 0.5;
function cityZoomExpr(st: LayerState): unknown {
  const cats = CAT_BITS.filter((k) => st.filters.cats & k);
  // `m{k}` is a zoom, the packed `n{k}` holds level indices
  const zOf = (k: number) => ["case", ["has", `m${k}`], scenarioLevel(k, st.filters, ["get", `m${k}`], `n${k}`, (lv) => ["at", lv, ["literal", LEVELS]]), 99];
  const minLine = cats.length ? ["min", 99, ...cats.map(zOf)] : 99;
  return ["max", ["get", "tz"], minLine];
}
/** Opacity of city dots / labels: fully shown CITY_LEAD before their zoom, fading in over FADE_ZOOM before that. */
function cityFade(st: LayerState, base: number): Expr {
  const end = ["-", cityZoomExpr(st), CITY_LEAD];
  return E(["interpolate", ["linear"], ["zoom"], ...fadeStops(-CITY_LEAD).flatMap((z) => [z, ["*", base, fadeAt(z, end)]])]);
}

export function cityFilter(st: LayerState): FilterSpecification {
  const zoomOk = [">=", ["+", ["zoom"], CITY_LEAD + FADE_ZOOM], cityZoomExpr(st)];
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
  const cats = CAT_BITS.filter((k) => f.cats & k);
  const catFilter = (k: number): unknown[] => ["all", ["has", `w${k}`]];

  // ---- base network: every corridor joins two stations, so one set of layers serves all zooms
  const anyCat: unknown[] = ["any", ...cats.map((k) => catFilter(k))];
  // casing (land colour halo): approximate alignments (u = 1) are drawn dashed, without a halo
  layers.push({
    id: "net-cas",
    type: "line",
    source: "net",
    "source-layer": TILE_LAYERS.seg,
    filter: ["all", ["!", ["has", "hop"]], ["!=", ["get", "u"], 1], anyCat] as unknown as FilterSpecification,
    layout: lineLayout,
    paint: {
      "line-color": t.land,
      "line-width": byZoom(ZF, (_z, fz, L) => ["case", [">", total(L, f), 0], ["+", ["*", fz * wMul, total(L, f)], 1.2], 0]),
      "line-opacity": casingFade(cats as number[], f, dim ? 0.6 : 1),
    },
  });
  // long straight hops: thin dashed, from LONG_HOP_ZOOM
  for (const k of [...cats].reverse()) {
    layers.push({
      id: `net-hop-${k}`,
      type: "line",
      source: "net",
      "source-layer": TILE_LAYERS.seg,
      minzoom: LONG_HOP_ZOOM - FADE_ZOOM,
      filter: ["all", ["has", "hop"], ...catFilter(k).slice(1)] as unknown as FilterSpecification,
      layout: { "line-cap": "round" },
      paint: {
        "line-color": dim ? t.dimLine : catColorConst(t, k),
        "line-width": ["interpolate", ["linear"], ["zoom"], 6.5, 0.8, 10, 1.5],
        "line-dasharray": [2, 3],
        "line-opacity": dim ? E(["interpolate", ["linear"], ["zoom"], LONG_HOP_ZOOM - FADE_ZOOM, 0, LONG_HOP_ZOOM, 0.5]) : ["interpolate", ["linear"], ["zoom"], LONG_HOP_ZOOM - FADE_ZOOM, 0, LONG_HOP_ZOOM, 0.25, 9, 0.5, STATION_ZOOM, 0.35],
      },
    });
  }
  // buses below rail: draw categories in reverse order. Snapped lines are solid, approximate alignments
  // (no track / road found between the two stations) thin and dashed.
  for (const k of [...cats].reverse()) {
    for (const approx of [false, true]) {
      const u = ["==", ["get", "u"], approx ? 1 : 0];
      const width = byZoom(ZF, (_z, fz, L) => ["case", vis(k, L, f), approx ? ["min", 2.2, ["*", fz * wMul, wOf(k)]] : ["*", fz * wMul, wOf(k)], 0]);
      layers.push({
        id: `net-${approx ? "u-" : ""}${k}`,
        type: "line",
        source: "net",
        "source-layer": TILE_LAYERS.seg,
        filter: ["all", ["!", ["has", "hop"]], ...catFilter(k).slice(1), u] as unknown as FilterSpecification,
        layout: approx ? { "line-join": "round", "line-cap": "butt", "line-sort-key": ["coalesce", ["get", "k"], 0] } : { ...lineLayout, "line-sort-key": ["coalesce", ["get", "k"], 0] },
        paint: {
          "line-color": dim ? t.dimLine : catColorConst(t, k),
          "line-width": width,
          "line-offset": byZoom(ZF, (_z, fz, L) => ["*", fz * wMul, offset(k, L, f)]),
          "line-opacity": lineFade(k, f, dim ? 1 : k === Cat.Bus ? 0.65 : approx ? 0.85 : 1),
          ...(approx ? { "line-dasharray": [2, 1.6] } : {}),
        },
      });
    }
  }

  // ---- highlighted corridors (selection), always above the dimmed network
  layers.push({
    id: "hl-cas",
    type: "line",
    source: "hl-casing",
    layout: lineLayout,
    paint: { "line-color": t.land, "line-width": scaled("t", ZF_HL, 2.4) },
  });
  layers.push({
    id: "hl",
    type: "line",
    source: "hl",
    filter: ["==", ["get", "hop"], 0],
    layout: { ...lineLayout, "line-sort-key": ["get", "k"] },
    paint: { "line-color": catColor(t), "line-width": scaled("w", ZF_HL), "line-offset": scaled("o", ZF_HL) },
  });
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
      "circle-opacity": cityFade(st, 1),
      "circle-stroke-opacity": cityFade(st, 1),
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

  // ---- the member stations of a selected city: a soft ring around each (nothing is drawn while no city is selected);
  // the station chosen as origin gets a stronger one. Minor stops get theirs from the zoom they are drawn at.
  const cur: Expr = E(["==", ["get", "cur"], 1]);
  const ringR: Expr = E(["interpolate", ["linear"], ["zoom"], 8.5, 5, 10.5, 10, 12.5, 15, 15, 21]);
  for (const major of [true, false]) {
    const z0 = major ? 8.5 : STATION_LEVELS[2]!;
    layers.push({
      id: major ? RING_LAYERS[0]! : RING_LAYERS[1]!,
      type: "circle",
      source: "focus-stations",
      minzoom: z0,
      filter: (major ? ["<=", ["get", "lz"], 1] : [">", ["get", "lz"], 1]) as unknown as FilterSpecification,
      paint: {
        "circle-radius": ringR,
        "circle-color": t.accent,
        "circle-opacity": E(["interpolate", ["linear"], ["zoom"], z0, 0, z0 + 0.7, ["case", cur, 0.26, 0.1]]),
        "circle-stroke-color": t.accent,
        "circle-stroke-width": ["case", cur, 1.8, 1],
        "circle-stroke-opacity": E(["interpolate", ["linear"], ["zoom"], z0, 0, z0 + 0.7, ["case", cur, 0.85, 0.32]]),
        "circle-pitch-alignment": "map",
      },
    });
  }

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
        "circle-color": base ? t.markerFill : ["case", ["==", ["get", "cur"], 1], t.accent, t.markerFill],
        "circle-stroke-color": t.markerStroke,
        "circle-stroke-width": ["case", ["==", ["get", "rail"], 1], 2.2, 1.6],
        "circle-opacity": base ? rampFrom(minzoom, dim ? 0.6 : 1) : dim && base ? 0.6 : 1,
        "circle-stroke-opacity": base ? rampFrom(minzoom, dim ? 0.45 : 1) : 1,
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
        "text-opacity": base ? rampFrom(minzoom, 1) : 1,
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
        "text-opacity": focus ? 1 : cityFade(st, dim ? 0.8 : 1),
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
      // the city point is its main station (ETL): keep the area label off its station marker and name
      "text-variable-anchor": ["bottom", "top", "right", "left"],
      "text-radial-offset": 1.6,
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
