import maplibregl, { type FilterSpecification, type GeoJSONSource, type LayerSpecification, type MapGeoJSONFeature } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type * as GeoJSON from "geojson";
import type { Net } from "../data/net.ts";
import { sameFilters, type Filters } from "../logic/filters.ts";
import {
  baseCityData,
  baseCorridorData,
  buildNetIndex,
  focusCityData,
  highlightData,
  stationCorridorData,
  stationData,
  type Emphasis,
  type NetIndex,
} from "./features.ts";
import { CITY_CIRCLE_LAYERS, CITY_LABEL_LAYERS, FOCUS_LAYERS, STATION_LAYERS, STATION_ZOOM, networkLayers, networkSources } from "./layers.ts";
import { LEVELS, STATION_LEVELS } from "./lod.ts";
import type { BaseRequest, BaseResponse } from "./network.worker.ts";
import { baseLayers, baseStyle } from "./style.ts";
import { currentTheme, type Theme } from "./theme.ts";

export type { Emphasis };

export interface Padding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

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
  [-9.5, 36.5],
  [35, 59],
];
const EUROPE_MOBILE: [[number, number], [number, number]] = [
  [-5, 41],
  [24, 56.5],
];

const perf = (label: string, t0: number) => {
  if (import.meta.env.DEV || (window as { __etbmPerf?: boolean }).__etbmPerf) console.debug(`[perf] ${label} ${Math.round(performance.now() - t0)} ms`);
};

export class MapView {
  readonly map: maplibregl.Map;
  private theme: Theme;
  private idx: NetIndex;
  private filters: Filters | null = null;
  private hl: Highlight = { emphasis: { focus: new Set(), active: false }, corridors: new Map() };
  private dimmed = false;
  private ready: Promise<void>;
  private hovered: { source: string; id: number } | null = null;
  private tooltip: HTMLDivElement;
  private stKey = "";

  constructor(
    container: HTMLElement,
    private net: Net,
    private cb: MapCallbacks,
    padding: () => Padding,
  ) {
    this.theme = currentTheme();
    let t0 = performance.now();
    this.idx = buildNetIndex(net);
    perf("net index", t0);
    this.map = new maplibregl.Map({
      container,
      style: baseStyle(this.theme, (n) => net.ds.url(`basemap/${n}.json`)),
      bounds: matchMedia("(max-width: 719px)").matches ? EUROPE_MOBILE : EUROPE,
      fitBoundsOptions: { padding: (({ top, bottom, left, right }) => ({ top: top + 20, bottom: bottom + 20, left: left + 20, right: right + 20 }))(padding()) },
      attributionControl: false,
      maxZoom: 15,
      minZoom: 2.6,
      maxBounds: [
        [-45, 25],
        [65, 78],
      ],
      dragRotate: false,
      pitchWithRotate: false,
      renderWorldCopies: false,
      validateStyle: false,
      fadeDuration: 150,
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
        t0 = performance.now();
        for (const [id, src] of Object.entries(networkSources())) this.map.addSource(id, src);
        for (const l of networkLayers(this.theme, { dimmed: false })) this.map.addLayer(l);
        perf("layers", t0);
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
    this.map.on("moveend", () => {
      this.updateStationCorridors();
      cb.onMove?.();
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      this.theme = currentTheme();
      this.applyPaint(true);
    });
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  private blobUrls = new Map<string, string>();

  /**
   * Large collections go to the worker as a JSON blob URL: MapLibre's
   * structured serialisation of tens of thousands of objects costs seconds on
   * the main thread, JSON.stringify + a worker-side parse is far cheaper.
   */
  private setData(source: string, data: GeoJSON.FeatureCollection): void {
    const src = this.map.getSource(source) as GeoJSONSource | undefined;
    if (!src) return;
    const old = this.blobUrls.get(source);
    if (data.features.length > 3000 && typeof URL.createObjectURL === "function") {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
      this.blobUrls.set(source, url);
      src.setData(url);
    } else {
      this.blobUrls.delete(source);
      src.setData(data);
    }
    if (old) setTimeout(() => URL.revokeObjectURL(old), 60_000);
  }

  // ---- interaction ------------------------------------------------------------

  private interactiveLayers(): string[] {
    return [...CITY_CIRCLE_LAYERS, ...CITY_LABEL_LAYERS, ...FOCUS_LAYERS, ...STATION_LAYERS].filter((l) => this.map.getLayer(l));
  }

  /** City under a screen point (with tolerance for touch). */
  cityAt(p: maplibregl.Point): number | null {
    const f = this.featureAt(p);
    if (!f) return null;
    const props = f.properties as Record<string, number>;
    return f.source === "stations" || f.source === "focus-stations" ? props.city! : props.id!;
  }

  private featureAt(p: maplibregl.Point): MapGeoJSONFeature | null {
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
      let d = r * 0.8; // label hit
      if (g.type === "Point" && f.layer.type === "circle") {
        const sp = this.map.project(g.coordinates as [number, number]);
        d = Math.hypot(sp.x - p.x, sp.y - p.y) - (f.source === "focus" ? 2 : 0);
      }
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best;
  }

  private hover(p: maplibregl.Point): void {
    const f = this.featureAt(p);
    const id = f ? (f.properties as Record<string, number>)[f.source.endsWith("stations") ? "city" : "id"]! : null;
    this.setHover(f && (f.source === "cities" || f.source === "focus") && f.id !== undefined ? { source: f.source, id: f.id as number } : null);
    this.map.getCanvas().style.cursor = f ? "pointer" : "";
    if (f && id !== null) {
      const c = this.net.cities[id]!;
      const name = f.source.endsWith("stations") ? (f.properties as { name: string }).name : c.name;
      this.tooltip.textContent = name;
      this.tooltip.style.transform = `translate(${p.x + 14}px, ${p.y - 10}px)`;
      this.tooltip.hidden = false;
    } else this.tooltip.hidden = true;
  }

  private setHover(h: { source: string; id: number } | null): void {
    if (h?.source === this.hovered?.source && h?.id === this.hovered?.id) return;
    if (this.hovered) this.map.setFeatureState(this.hovered, { hover: false });
    this.hovered = h;
    if (h) this.map.setFeatureState(h, { hover: true });
  }

  // ---- data -------------------------------------------------------------------

  private worker: Worker | null = null;
  private workerSeq = 0;
  private workerWaiters = new Map<number, (r: BaseResponse) => void>();

  /** Base network under the filters, built in a worker when available. */
  async setFilters(f: Filters): Promise<void> {
    if (this.filters && sameFilters(this.filters, f)) return;
    this.filters = f;
    const t0 = performance.now();
    const res = await this.buildBaseInWorker(f).catch((e: unknown) => {
      console.warn("network worker failed, building on main thread", e);
      return null;
    });
    await this.ready;
    if (this.filters !== f) return; // superseded
    if (res) {
      this.setBytes("casing", res.casing!);
      this.setBytes("corridors", res.lines!);
      this.setBytes("hops", res.hops!);
      this.setBytes("cities", res.cities!);
      perf(`base network via worker (${res.counts!.lines} lines, ${res.counts!.ms} ms in worker)`, t0);
    } else {
      const base = baseCorridorData(this.net, this.idx, f);
      this.setData("casing", base.casing);
      this.setData("corridors", base.lines);
      this.setData("hops", base.hops);
      this.setData("cities", baseCityData(this.net, base));
      perf(`base network (${base.lines.features.length} lines)`, t0);
    }
    this.stKey = "";
    this.updateStationCorridors();
    this.map.getContainer().dataset.network = String(Date.now());
  }

  private buildBaseInWorker(f: Filters): Promise<BaseResponse> {
    if (typeof Worker === "undefined") return Promise.reject(new Error("no Worker"));
    if (!this.worker) {
      this.worker = new Worker(new URL("./network.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<BaseResponse>) => {
        const w = this.workerWaiters.get(e.data.id);
        this.workerWaiters.delete(e.data.id);
        w?.(e.data);
      };
    }
    const id = ++this.workerSeq;
    const req: BaseRequest = { id, type: "base", dataUrl: this.net.ds.url(""), filters: { ...f } };
    return new Promise((resolve, reject) => {
      this.workerWaiters.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r)));
      this.worker!.postMessage(req);
    });
  }

  private setBytes(source: string, buf: ArrayBuffer): void {
    const src = this.map.getSource(source) as GeoJSONSource | undefined;
    if (!src) return;
    const old = this.blobUrls.get(source);
    const url = URL.createObjectURL(new Blob([buf], { type: "application/json" }));
    this.blobUrls.set(source, url);
    src.setData(url);
    if (old) setTimeout(() => URL.revokeObjectURL(old), 60_000);
  }

  /** Station-level corridor geometry for the current viewport (z ≥ STATION_ZOOM). */
  private stationsLoaded = false;

  private updateStationCorridors(): void {
    if (!this.filters) return;
    if (this.map.getZoom() < STATION_ZOOM - 0.6) return;
    if (!this.stationsLoaded) {
      // 70k+ stations are only needed when zoomed in: index them lazily
      this.stationsLoaded = true;
      const t1 = performance.now();
      this.setData("stations", stationData(this.net, this.idx));
      perf("stations", t1);
    }
    const b = this.map.getBounds();
    const pad = 0.5;
    const box: [number, number, number, number] = [b.getWest() - pad, b.getSouth() - pad, b.getEast() + pad, b.getNorth() + pad];
    const key = box.map((x) => Math.round(x * 4)).join(",");
    if (key === this.stKey) return;
    this.stKey = key;
    const t0 = performance.now();
    const d = stationCorridorData(this.net, this.idx, this.filters, box);
    this.setData("st-casing", d.casing);
    this.setData("st-corridors", d.lines);
    perf(`station corridors (${d.lines.features.length})`, t0);
  }

  async setHighlight(h: Highlight): Promise<void> {
    await this.ready;
    const t0 = performance.now();
    this.hl = h;
    const em = h.emphasis;
    const d = highlightData(this.net, this.idx, h.corridors);
    this.setData("hl-casing", d.casing);
    this.setData("hl", d.lines);
    this.setData("focus", focusCityData(this.net, em));
    const sel = new Set([em.origin, em.dest].filter((x): x is number => x !== undefined));
    this.setData("focus-stations", stationData(this.net, this.idx, sel));
    // base cities/stations: hide the ones drawn by the focus layers
    const focusIds = ["literal", [...em.focus]];
    LEVELS.forEach((_, i) => {
      const f = (em.focus.size ? ["all", ["==", ["get", "lz"], i], ["!", ["in", ["get", "id"], focusIds]]] : ["==", ["get", "lz"], i]) as FilterSpecification;
      this.map.setFilter(`city-c-${i}`, f);
      this.map.setFilter(`city-l-${i}`, f);
    });
    STATION_LEVELS.forEach((_, i) => {
      const f = (sel.size ? ["all", ["==", ["get", "lz"], i], ["!", ["in", ["get", "city"], ["literal", [...sel]]]]] : ["==", ["get", "lz"], i]) as FilterSpecification;
      this.map.setFilter(`station-c-${i}`, f);
      this.map.setFilter(`station-l-${i}`, f);
    });
    if (em.active !== this.dimmed) {
      this.dimmed = em.active;
      this.applyPaint(false);
    }
    perf(`highlight (${d.lines.features.length} lines, ${em.focus.size} cities)`, t0);
  }

  /** Re-apply paint (and optionally layout) after a theme or dim change. */
  private applyPaint(withBase: boolean): void {
    const all: LayerSpecification[] = [...(withBase ? baseLayers(this.theme) : []), ...networkLayers(this.theme, { dimmed: this.dimmed })];
    for (const l of all) {
      if (!this.map.getLayer(l.id)) continue;
      for (const [k, v] of Object.entries((l as { paint?: Record<string, unknown> }).paint ?? {})) this.map.setPaintProperty(l.id, k, v);
      if (withBase) for (const [k, v] of Object.entries((l as { layout?: Record<string, unknown> }).layout ?? {})) this.map.setLayoutProperty(l.id, k, v);
    }
  }

  // ---- camera -----------------------------------------------------------------

  /** Frame a set of cities, leaving room for the panel. */
  fitCities(ids: number[], padding: Padding, maxZoom = 8): void {
    if (!ids.length) return;
    const b = new maplibregl.LngLatBounds();
    for (const id of ids) {
      const c = this.net.cities[id];
      if (c) b.extend([c.lon, c.lat]);
    }
    const pad = { top: padding.top + 50, bottom: padding.bottom + 50, left: padding.left + 60, right: padding.right + 60 };
    if (ids.length === 1) {
      const c = this.net.cities[ids[0]!]!;
      if (!this.isVisible(c.lon, c.lat, padding)) this.map.easeTo({ center: [c.lon, c.lat], padding, duration: 700 });
      return;
    }
    const cam = this.map.cameraForBounds(b, { padding: pad, maxZoom });
    if (!cam) return;
    const allVisible = ids.every((id) => {
      const c = this.net.cities[id]!;
      return this.isVisible(c.lon, c.lat, padding);
    });
    const z = this.map.getZoom();
    if (allVisible && (cam.zoom ?? z) - z < 0.75) return;
    this.map.easeTo({ ...cam, duration: 800 });
  }

  private isVisible(lon: number, lat: number, padding: Padding): boolean {
    const p = this.map.project([lon, lat]);
    const c = this.map.getCanvas();
    return p.x > padding.left + 20 && p.x < c.clientWidth - padding.right - 20 && p.y > padding.top + 20 && p.y < c.clientHeight - padding.bottom - 20;
  }

  flyToCity(id: number, zoom?: number): void {
    const c = this.net.cities[id];
    if (c) this.map.flyTo({ center: [c.lon, c.lat], zoom: zoom ?? Math.max(this.map.getZoom(), 6) });
  }
}
