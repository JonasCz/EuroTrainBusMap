/**
 * Network layers: corridors (side-by-side category bundles), cities with level
 * of detail, and stations at high zoom. Features are generated in JS from the
 * NetworkFile so filters can re-pack bundles (offsets) without gaps.
 */
import { Cat } from "@etbm/shared";
import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";
import type * as GeoJSON from "geojson";
import type { Net } from "../data/net.ts";
import { CAT_ORDER, effectiveCats, type Filters } from "../logic/filters.ts";
import { FONT_MEDIUM, FONT_REGULAR } from "./style.ts";
import type { Theme } from "./theme.ts";

/** Zoom at which cities break out into stations. */
export const STATION_ZOOM = 10.5;

/** Zoom → px per width unit. */
const ZF: [number, number][] = [
  [2, 0.7],
  [4, 1.05],
  [6, 1.55],
  [8, 2.0],
  [10, 2.4],
  [12, 2.9],
  [15, 3.8],
];

/** Level-of-detail tiers: [min importance, minzoom] */
const TIERS: [number, number][] = [
  [0.6, 0],
  [0.45, 4.2],
  [0.33, 5.1],
  [0.22, 6],
  [0.12, 7],
  [0.05, 8],
  [0, 9],
];

const GAP = 0.35; // gap between categories in a bundle, in width units

export function tierOf(importance: number): number {
  const i = TIERS.findIndex(([min]) => importance >= min);
  return i < 0 ? TIERS.length - 1 : i;
}

/** Width unit of one category line from trips/day. */
export function catWidth(tpd: number): number {
  return Math.min(5, 1 + 0.72 * Math.log1p(Math.max(0, tpd)));
}

function zoomScaled(expr: ExpressionSpecification | number, add = 0): ExpressionSpecification {
  const stops: (number | ExpressionSpecification)[] = [];
  for (const [z, f] of ZF) {
    const v: ExpressionSpecification = ["*", f, expr] as ExpressionSpecification;
    stops.push(z, add ? (["+", v, add] as ExpressionSpecification) : v);
  }
  return ["interpolate", ["linear"], ["zoom"], ...stops] as unknown as ExpressionSpecification;
}

type FC = GeoJSON.FeatureCollection;

export interface CorridorData {
  lines: FC;
  casing: FC;
  /** per city: max bundle width (units) of incident corridors */
  cityWidth: Float32Array;
  /** per city: whether any visible corridor touches it */
  cityVisible: Uint8Array;
}

/** Cat bits of a corridor visible under the filter. */
export function visibleCats(net: Net, cid: number, f: Filters): number {
  const c = net.corridors[cid]!;
  let cats = c.cats & effectiveCats(f);
  if (f.dticket) {
    if (net.hasDtCats) cats &= c.dtCats ?? 0;
    else {
      // heuristic without dtCats: German regional services
      const a = net.cities[c.a]!;
      const b = net.cities[c.b]!;
      if (a.country !== "DE" || b.country !== "DE") cats = 0;
    }
  }
  return cats;
}

export function corridorData(net: Net, f: Filters): CorridorData {
  const lines: GeoJSON.Feature[] = [];
  const casing: GeoJSON.Feature[] = [];
  const cityWidth = new Float32Array(net.cities.length);
  const cityVisible = new Uint8Array(net.cities.length);
  for (const c of net.corridors) {
    if (c.coords.length < 2) continue;
    const cats = visibleCats(net, c.id, f);
    if (!cats) continue;
    const present = CAT_ORDER.filter((k) => cats & k);
    const widths = present.map((k) => catWidth(c.tpd[k] ?? 0));
    const total = widths.reduce((s, w) => s + w, 0) + GAP * (present.length - 1);
    // draw west→east (or south→north) so bundles keep a consistent side order
    const p0 = c.coords[0]!;
    const p1 = c.coords[c.coords.length - 1]!;
    const dx = (p1[0] - p0[0]) * Math.cos((((p0[1] + p1[1]) / 2) * Math.PI) / 180);
    const dy = p1[1] - p0[1];
    const flip = Math.abs(dx) >= Math.abs(dy) ? dx < 0 : dy < 0;
    const coords = flip ? [...c.coords].reverse() : c.coords;
    let acc = -total / 2;
    present.forEach((k, i) => {
      const w = widths[i]!;
      lines.push({
        type: "Feature",
        id: c.id * 4 + CAT_ORDER.indexOf(k as (typeof CAT_ORDER)[number]),
        properties: { cid: c.id, cat: k, w, o: acc + w / 2 },
        geometry: { type: "LineString", coordinates: coords },
      });
      acc += w + GAP;
    });
    casing.push({ type: "Feature", id: c.id, properties: { cid: c.id, tw: total }, geometry: { type: "LineString", coordinates: coords } });
    for (const city of [c.a, c.b]) {
      cityWidth[city] = Math.max(cityWidth[city]!, total);
      cityVisible[city] = 1;
    }
  }
  return { lines: { type: "FeatureCollection", features: lines }, casing: { type: "FeatureCollection", features: casing }, cityWidth, cityVisible };
}

export interface Emphasis {
  /** Cities forced visible regardless of LOD (selection + reachable). */
  focus: Set<number>;
  /** When true, everything not in focus is greyed out. */
  active: boolean;
  origin?: number;
  dest?: number;
}

export function cityData(net: Net, cd: CorridorData, em: Emphasis): FC {
  const features: GeoJSON.Feature[] = [];
  for (const c of net.cities) {
    const focus = em.focus.has(c.id);
    if (!cd.cityVisible[c.id] && !focus) continue;
    const sel = c.id === em.origin ? 1 : c.id === em.dest ? 2 : 0;
    features.push({
      type: "Feature",
      id: c.id,
      properties: {
        id: c.id,
        name: c.name,
        imp: Math.max(c.importance, sel ? 0.7 : focus ? 0.3 : 0),
        tier: focus ? 0 : tierOf(c.importance),
        mw: cd.cityWidth[c.id] ?? 0,
        dim: em.active && !focus ? 1 : 0,
        sel,
        focus: focus ? 1 : 0,
        // sort key: lower = placed first
        rank: sel ? -2 : focus ? -1 - c.importance : 1 - c.importance,
      },
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
    });
  }
  return { type: "FeatureCollection", features };
}

export function stationData(net: Net, cd: CorridorData, em: Emphasis): FC {
  const features: GeoJSON.Feature[] = [];
  for (const s of net.file.stations) {
    const city = net.cities[s.city]!;
    const focus = em.focus.has(s.city);
    if (!cd.cityVisible[s.city] && !focus) continue;
    const main = city.stations[0] === s.id;
    features.push({
      type: "Feature",
      id: s.id,
      properties: {
        name: s.name,
        city: s.city,
        main: main ? 1 : 0,
        mw: main ? cd.cityWidth[s.city] ?? 0 : 0,
        dim: em.active && !focus ? 1 : 0,
        sel: s.city === em.origin || s.city === em.dest ? 1 : 0,
        rank: (main ? 0 : 1) - city.importance,
      },
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Thin connectors from a city's main point to its other stations. */
export function linkData(net: Net): FC {
  const features: GeoJSON.Feature[] = [];
  for (const c of net.cities) {
    for (const sid of c.stations.slice(1)) {
      const s = net.file.stations[sid]!;
      features.push({
        type: "Feature",
        properties: { city: c.id },
        geometry: { type: "LineString", coordinates: [[c.lon, c.lat], [s.lon, s.lat]] },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

export const CITY_CIRCLE_LAYERS = TIERS.map((_, i) => `city-c-${i}`);
export const CITY_LABEL_LAYERS = TIERS.map((_, i) => `city-l-${i}`);
export const STATION_LAYERS = ["station-c", "station-l"];

function catColor(t: Theme): ExpressionSpecification {
  return ["match", ["get", "cat"], Cat.LongDistance, t.cat[Cat.LongDistance]!, Cat.Regional, t.cat[Cat.Regional]!, Cat.Coach, t.cat[Cat.Coach]!, Cat.Bus, t.cat[Cat.Bus]!, "#888"];
}

const empty: FC = { type: "FeatureCollection", features: [] };

export function networkSources(): Record<string, { type: "geojson"; data: FC; tolerance?: number; buffer?: number }> {
  return {
    casing: { type: "geojson", data: empty, tolerance: 0.25, buffer: 64 },
    corridors: { type: "geojson", data: empty, tolerance: 0.25, buffer: 64 },
    links: { type: "geojson", data: empty },
    cities: { type: "geojson", data: empty },
    stations: { type: "geojson", data: empty },
  };
}

export function networkLayers(t: Theme, dimmed: boolean): LayerSpecification[] {
  const hl: ExpressionSpecification = ["boolean", ["feature-state", "hl"], false];
  const dim: ExpressionSpecification = ["==", ["get", "dim"], 1];
  const hover: ExpressionSpecification = ["boolean", ["feature-state", "hover"], false];
  const markerBase = (z: number): ExpressionSpecification => {
    const base = z <= 3 ? ["+", 2.2, ["*", 3, ["get", "imp"]]] : z <= 6 ? ["+", 3, ["*", 4, ["get", "imp"]]] : ["+", 4.2, ["*", 5.5, ["get", "imp"]]];
    const f = ZF.reduce((acc, [zz, ff]) => (zz <= z ? ff : acc), ZF[0]![1]);
    const cover = ["+", ["*", f / 2, ["get", "mw"]], 1.5];
    return ["+", ["max", base, cover], ["case", hover, 1.5, 0], ["case", [">", ["get", "sel"], 0], 1.5, 0]] as unknown as ExpressionSpecification;
  };
  const cityRadius: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 3, markerBase(3), 6, markerBase(6), 10, markerBase(10)];
  const strokeW: ExpressionSpecification = [
    "interpolate",
    ["linear"],
    ["zoom"],
    3,
    ["case", [">", ["get", "sel"], 0], 2.2, [">=", ["get", "imp"], 0.6], 1.6, 1.2],
    8,
    ["case", [">", ["get", "sel"], 0], 3, [">=", ["get", "imp"], 0.6], 2.2, 1.7],
  ];
  const markerFill: ExpressionSpecification = ["case", [">", ["get", "sel"], 0], t.accent, dim, t.land, t.markerFill];
  const markerStroke: ExpressionSpecification = ["case", [">", ["get", "sel"], 0], t.markerFill, dim, t.dimMarker, t.markerStroke];
  const labelColor: ExpressionSpecification = ["case", dim, t.dimText, t.text];
  const labelFont: ExpressionSpecification = ["case", ["any", [">", ["get", "sel"], 0], [">=", ["get", "imp"], 0.55]], ["literal", FONT_MEDIUM], ["literal", FONT_REGULAR]];

  const layers: LayerSpecification[] = [
    {
      id: "corridor-casing",
      type: "line",
      source: "casing",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": t.land, "line-width": zoomScaled(["get", "tw"], 2.2) },
    },
    {
      id: "corridors",
      type: "line",
      source: "corridors",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": dimmed ? ["case", hl, catColor(t), t.dimLine] : catColor(t),
        "line-width": dimmed ? zoomScaled(["*", ["get", "w"], ["case", hl, 1, 0.6]]) : zoomScaled(["get", "w"]),
        "line-offset": zoomScaled(["get", "o"]),
      },
    },
    {
      id: "station-links",
      type: "line",
      source: "links",
      minzoom: STATION_ZOOM - 0.5,
      layout: { "line-cap": "round" },
      paint: {
        "line-color": t.link,
        "line-width": 1.4,
        "line-dasharray": [0.1, 2.2],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], STATION_ZOOM - 0.5, 0, STATION_ZOOM, 0.9],
      },
    },
  ];
  layers.push({
    id: "city-sel-ring",
    type: "circle",
    source: "cities",
    maxzoom: STATION_ZOOM,
    filter: [">", ["get", "sel"], 0],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, ["+", markerBase(3), 6], 6, ["+", markerBase(6), 7], 10, ["+", markerBase(10), 9]],
      "circle-color": t.accent,
      "circle-opacity": 0.16,
      "circle-pitch-alignment": "map",
    },
  });
  // city markers, coarse tiers last so hubs draw on top
  for (let i = TIERS.length - 1; i >= 0; i--) {
    layers.push({
      id: `city-c-${i}`,
      type: "circle",
      source: "cities",
      minzoom: Math.max(0, TIERS[i]![1] - 0.9),
      maxzoom: STATION_ZOOM,
      filter: ["==", ["get", "tier"], i],
      layout: { "circle-sort-key": ["-", 0, ["get", "rank"]] },
      paint: {
        "circle-radius": cityRadius,
        "circle-color": markerFill,
        "circle-stroke-color": markerStroke,
        "circle-stroke-width": strokeW,
        "circle-pitch-alignment": "map",
      },
    });
  }
  layers.push({
    id: "station-c",
    type: "circle",
    source: "stations",
    minzoom: STATION_ZOOM,
    paint: {
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        STATION_ZOOM,
        ["max", ["case", ["==", ["get", "main"], 1], 6, 4.5], ["+", ["*", 1.0, ["get", "mw"]], 1.2]],
        15,
        ["max", ["case", ["==", ["get", "main"], 1], 9, 7], ["+", ["*", 1.7, ["get", "mw"]], 1.2]],
      ],
      "circle-color": ["case", dim, t.land, t.markerFill],
      "circle-stroke-color": ["case", dim, t.dimMarker, t.markerStroke],
      "circle-stroke-width": ["case", ["==", ["get", "sel"], 1], 3, 2.2],
      "circle-opacity": ["interpolate", ["linear"], ["zoom"], STATION_ZOOM, 0, STATION_ZOOM + 0.3, 1],
      "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], STATION_ZOOM, 0, STATION_ZOOM + 0.3, 1],
    },
  });
  layers.push({
    id: "station-l",
    type: "symbol",
    source: "stations",
    minzoom: STATION_ZOOM,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["case", ["==", ["get", "main"], 1], ["literal", FONT_MEDIUM], ["literal", FONT_REGULAR]],
      "text-size": ["interpolate", ["linear"], ["zoom"], STATION_ZOOM, ["case", ["==", ["get", "main"], 1], 13, 11.5], 15, ["case", ["==", ["get", "main"], 1], 16, 14]],
      "text-variable-anchor": ["left", "right", "top", "bottom"],
      "text-radial-offset": 0.9,
      "text-justify": "auto",
      "text-max-width": 9,
      "symbol-sort-key": ["get", "rank"],
      "text-padding": 3,
    },
    paint: {
      "text-color": labelColor,
      "text-halo-color": t.halo,
      "text-halo-width": 2,
      "text-halo-blur": 0.4,
    },
  });
  for (let i = TIERS.length - 1; i >= 0; i--) {
    layers.push({
      id: `city-l-${i}`,
      type: "symbol",
      source: "cities",
      minzoom: TIERS[i]![1],
      maxzoom: STATION_ZOOM,
      filter: ["==", ["get", "tier"], i],
      layout: {
        "text-field": ["get", "name"],
        "text-font": labelFont,
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          3,
          ["+", 10, ["*", 4.5, ["get", "imp"]], ["case", [">", ["get", "sel"], 0], 1.5, 0]],
          8,
          ["+", 11.5, ["*", 5, ["get", "imp"]], ["case", [">", ["get", "sel"], 0], 2, 0]],
        ],
        "text-variable-anchor": ["left", "right", "top", "bottom", "top-left", "bottom-left", "top-right", "bottom-right"],
        "text-radial-offset": ["interpolate", ["linear"], ["zoom"], 3, ["+", 0.55, ["*", 0.5, ["get", "imp"]]], 8, ["+", 0.75, ["*", 0.6, ["get", "imp"]]]],
        "text-justify": "auto",
        "text-max-width": 8,
        "text-padding": 2,
        "symbol-sort-key": ["get", "rank"],
      },
      paint: {
        "text-color": labelColor,
        "text-halo-color": t.halo,
        "text-halo-width": 2,
        "text-halo-blur": 0.4,
      },
    });
  }
  return layers;
}
