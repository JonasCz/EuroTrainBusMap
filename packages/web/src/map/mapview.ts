import maplibregl, { type GeoJSONSource, type LayerSpecification, type MapGeoJSONFeature } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Net } from "../data/net.ts";
import type { Filters } from "../logic/filters.ts";
import {
  CITY_CIRCLE_LAYERS,
  CITY_LABEL_LAYERS,
  STATION_LAYERS,
  cityData,
  corridorData,
  linkData,
  networkLayers,
  networkSources,
  stationData,
  type CorridorData,
  type Emphasis,
} from "./layers.ts";
import { baseLayers, baseStyle } from "./style.ts";
import { currentTheme, type Theme } from "./theme.ts";
import { CAT_ORDER } from "../logic/filters.ts";

export interface MapCallbacks {
  onCity(id: number): void;
  onBackground(): void;
  onMove?(): void;
}

export interface Highlight {
  emphasis: Emphasis;
  /** corridor id → Cat bits to highlight */
  corridors: Map<number, number>;
}

const EUROPE: [[number, number], [number, number]] = [
  [-9.5, 36],
  [33.5, 59.5],
];

export class MapView {
  readonly map: maplibregl.Map;
  private theme: Theme;
  private filters: Filters | null = null;
  private cd: CorridorData | null = null;
  private hl: Highlight = { emphasis: { focus: new Set(), active: false }, corridors: new Map() };
  private ready: Promise<void>;
  private hovered: number | null = null;
  private tooltip: HTMLDivElement;

  constructor(
    container: HTMLElement,
    private net: Net,
    private cb: MapCallbacks,
    padding: () => maplibregl.PaddingOptions,
  ) {
    this.theme = currentTheme();
    this.map = new maplibregl.Map({
      container,
      style: baseStyle(this.theme, (n) => net.ds.url(`basemap/${n}.json`)),
      bounds: EUROPE,
      fitBoundsOptions: { padding: { top: 20, bottom: 20, left: 20, right: 20, ...padding() } },
      attributionControl: false,
      maxZoom: 15,
      minZoom: 2,
      dragRotate: false,
      pitchWithRotate: false,
      renderWorldCopies: false,
      cooperativeGestures: false,
      validateStyle: false,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    this.tooltip = document.createElement("div");
    this.tooltip.className = "map-tooltip";
    this.tooltip.hidden = true;
    container.appendChild(this.tooltip);

    this.ready = new Promise((resolve) => {
      this.map.on("load", () => {
        for (const [id, src] of Object.entries(networkSources())) this.map.addSource(id, src);
        for (const l of networkLayers(this.theme, false)) this.map.addLayer(l);
        (this.map.getSource("links") as GeoJSONSource).setData(linkData(net));
        resolve();
      });
    });
    this.map.on("click", (e) => {
      const id = this.cityAt(e.point);
      if (id !== null) cb.onCity(id);
      else cb.onBackground();
    });
    this.map.on("mousemove", (e) => this.hover(e.point));
    this.map.on("mouseout", () => this.setHover(null));
    this.map.on("moveend", () => cb.onMove?.());

    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.applyTheme(currentTheme()));
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  private interactiveLayers(): string[] {
    return [...CITY_CIRCLE_LAYERS, ...CITY_LABEL_LAYERS, ...STATION_LAYERS].filter((l) => this.map.getLayer(l));
  }

  /** City under a screen point (with tolerance for touch). */
  cityAt(p: maplibregl.Point): number | null {
    const r = 10;
    const feats = this.map.queryRenderedFeatures(
      [
        [p.x - r, p.y - r],
        [p.x + r, p.y + r],
      ],
      { layers: this.interactiveLayers() },
    );
    let best: MapGeoJSONFeature | null = null;
    let bestD = Infinity;
    for (const f of feats) {
      const g = f.geometry;
      let d = 0;
      if (g.type === "Point" && f.layer.type === "circle") {
        const sp = this.map.project(g.coordinates as [number, number]);
        d = Math.hypot(sp.x - p.x, sp.y - p.y);
      } else d = r * 0.8; // label hit
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    if (!best) return null;
    const props = best.properties as Record<string, number>;
    return best.source === "stations" ? props.city! : props.id!;
  }

  private hover(p: maplibregl.Point): void {
    const id = this.cityAt(p);
    this.setHover(id);
    if (id !== null) {
      const c = this.net.cities[id]!;
      this.tooltip.textContent = c.name;
      this.tooltip.style.transform = `translate(${p.x + 14}px, ${p.y - 10}px)`;
      this.tooltip.hidden = this.map.getZoom() >= 10.5;
    } else this.tooltip.hidden = true;
  }

  private setHover(id: number | null): void {
    if (id === this.hovered) return;
    if (this.hovered !== null && this.map.getSource("cities")) this.map.setFeatureState({ source: "cities", id: this.hovered }, { hover: false });
    this.hovered = id;
    if (id !== null) this.map.setFeatureState({ source: "cities", id }, { hover: true });
    this.map.getCanvas().style.cursor = id !== null ? "pointer" : "";
    if (id === null) this.tooltip.hidden = true;
  }

  async setFilters(f: Filters): Promise<void> {
    await this.ready;
    this.filters = f;
    this.cd = corridorData(this.net, f);
    (this.map.getSource("casing") as GeoJSONSource).setData(this.cd.casing);
    (this.map.getSource("corridors") as GeoJSONSource).setData(this.cd.lines);
    this.applyHighlight();
  }

  async setHighlight(h: Highlight): Promise<void> {
    await this.ready;
    this.hl = h;
    this.applyHighlight();
  }

  private applyHighlight(): void {
    if (!this.cd) return;
    const em = this.hl.emphasis;
    (this.map.getSource("cities") as GeoJSONSource).setData(cityData(this.net, this.cd, em));
    (this.map.getSource("stations") as GeoJSONSource).setData(stationData(this.net, this.cd, em));
    this.map.removeFeatureState({ source: "corridors" });
    for (const [cid, cats] of this.hl.corridors) {
      CAT_ORDER.forEach((k, i) => {
        if (cats & k) this.map.setFeatureState({ source: "corridors", id: cid * 4 + i }, { hl: true });
      });
    }
    const layer = networkLayers(this.theme, em.active).find((l) => l.id === "corridors")!;
    this.map.setPaintProperty("corridors", "line-color", (layer.paint as Record<string, unknown>)["line-color"]);
    if (this.hovered !== null) this.map.setFeatureState({ source: "cities", id: this.hovered }, { hover: true });
  }

  private applyTheme(t: Theme): void {
    this.theme = t;
    const all: LayerSpecification[] = [...baseLayers(t), ...networkLayers(t, this.hl.emphasis.active)];
    for (const l of all) {
      if (!this.map.getLayer(l.id)) continue;
      for (const [k, v] of Object.entries((l as { paint?: Record<string, unknown> }).paint ?? {})) {
        this.map.setPaintProperty(l.id, k, v);
      }
      for (const [k, v] of Object.entries((l as { layout?: Record<string, unknown> }).layout ?? {})) {
        this.map.setLayoutProperty(l.id, k, v);
      }
    }
  }

  /** Frame a set of cities, leaving room for the panel. */
  fitCities(ids: number[], padding: maplibregl.PaddingOptions, maxZoom = 8): void {
    if (!ids.length) return;
    const b = new maplibregl.LngLatBounds();
    for (const id of ids) {
      const c = this.net.cities[id];
      if (c) b.extend([c.lon, c.lat]);
    }
    const pad = { top: padding.top + 50, bottom: padding.bottom + 50, left: padding.left + 50, right: padding.right + 50 };
    if (ids.length === 1) {
      const c = this.net.cities[ids[0]!]!;
      if (!this.isVisible(c.lon, c.lat, padding)) this.map.easeTo({ center: [c.lon, c.lat], padding, duration: 700 });
      return;
    }
    const cam = this.map.cameraForBounds(b, { padding: pad, maxZoom });
    if (!cam) return;
    // avoid jumpy zoom-ins: only move if something is off-screen or we're far too zoomed out
    const allVisible = ids.every((id) => {
      const c = this.net.cities[id]!;
      return this.isVisible(c.lon, c.lat, padding);
    });
    const z = this.map.getZoom();
    if (allVisible && (cam.zoom ?? z) - z < 1.5) return;
    this.map.easeTo({ ...cam, duration: 800 });
  }

  private isVisible(lon: number, lat: number, padding: maplibregl.PaddingOptions): boolean {
    const p = this.map.project([lon, lat]);
    const c = this.map.getCanvas();
    const w = c.clientWidth;
    const h = c.clientHeight;
    return p.x > padding.left + 20 && p.x < w - padding.right - 20 && p.y > padding.top + 20 && p.y < h - padding.bottom - 20;
  }

  flyToCity(id: number, zoom?: number): void {
    const c = this.net.cities[id];
    if (c) this.map.flyTo({ center: [c.lon, c.lat], zoom: zoom ?? Math.max(this.map.getZoom(), 6) });
  }
}
