import maplibregl, { type GeoJSONSource, type LayerSpecification, type MapGeoJSONFeature, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { TILE_LAYERS, tileSet, type TileIndex, type UrbanInfo } from "@etbm/shared";
import type * as GeoJSON from "geojson";
import type { Net } from "../data/net.ts";
import { sameFilters, type Filters } from "../logic/filters.ts";
import { contextData, focusCityData, highlightData, stationData, xferData, type Emphasis } from "./features.ts";
import { CITY_AREA_LAYER, CITY_LAYERS, FOCUS_LAYERS, STATION_LAYERS, STATION_ZOOM, cityFilter, geojsonSources, networkLayers, type LayerState } from "./layers.ts";
import { URBAN_HIT_LAYERS, URBAN_LAYER_IDS, urbanLayers, urbanSources, urbanTileKeys, type UrbanHit } from "./urban.ts";
import { urbanPopup } from "../ui/urbanpopup.ts";
import { ALL_CATS, DEFAULT_FILTERS, localOn } from "../logic/filters.ts";
import { prefetchBasemapIndex, registerBasemapProtocol } from "./basemap.ts";
import { prefetchGz, registerGzProtocol } from "./protocol.ts";
import { baseLayers, baseStyle, glyphPrefetchUrls } from "./style.ts";
import { currentTheme, type Theme } from "./theme.ts";

export type { Emphasis };

export interface Padding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface MapCallbacks {
  /** A city (zoomed out: its dot or label, or its name over the stations) was clicked. */
  onCity(id: number): void;
  /** A station (station zoom: its dot or label) was clicked. `name` is its map label. */
  onStation(id: number, city: number, name: string): void;
  onBackground(): void;
  onMove?(): void;
}

export interface Highlight {
  emphasis: Emphasis;
  /** corridor id → Cat bits to highlight */
  corridors: Map<number, number>;
  /** corridor id → Cat bit → trips/day of the selected services (line widths); default: the corridors' total traffic */
  traffic?: Map<number, Partial<Record<number, number>>>;
  /** corridor id → Cat bits of the not-ridden part of a selected vehicle run, drawn faded under the highlight */
  context?: Map<number, number>;
  /** corridor id → level (2 = one change …) and Cat bits: lines reached with changes, drawn lighter */
  xfer?: Map<number, { level: number; cats: number }>;
  /** the same, prebuilt as GeoJSON text (by the transfer worker) */
  xferJson?: string;
  /** walks between stations at the changes of a journey ([lon, lat] pairs), drawn dotted */
  walks?: [number, number][][];
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
  private net: Net | null = null;
  private state: LayerState = { dimmed: false, filters: DEFAULT_FILTERS, focus: [], selected: [] };
  private ready: Promise<void>;
  private hovered: { source: string; sourceLayer?: string; id: number } | null = null;
  private tooltip: HTMLDivElement;
  private layerIds: string[] = [];
  private hasUrban = false;
  private popup: maplibregl.Popup | null = null;
  private resolveNetPaint: () => void = () => undefined;
  /** URL template of the network tiles for the filters (every mode on, or a mode filter). */
  private netUrl: (f: Filters) => string;
  /** Resolves once the network tiles have been drawn for the first time. */
  readonly firstNetPaint: Promise<void>;

  /**
   * The map starts as soon as the manifest is known: basemap, glyphs and the
   * network tiles load in parallel with core.json.
   */
  constructor(
    container: HTMLElement,
    dataUrl: (p: string) => string,
    tiles: TileIndex,
    private cb: MapCallbacks,
    padding: () => Padding,
    basemap: { root: string; minzoom: number; maxzoom: number; bounds: [number, number, number, number] } | null = null,
    urban: UrbanInfo | null = null,
  ) {
    this.theme = currentTheme();
    this.hasUrban = !!urban;
    const dirOf = (template: string) => `/${template.split("/{z}")[0]}/`;
    registerGzProtocol(
      new Set([...tileSet(tiles), ...(urban ? urbanTileKeys(urban) : [])]),
      tiles.modes ? { dir: dirOf(tiles.modes.url), plainDir: dirOf(tiles.url), maxzoom: tiles.modes.maxzoom, keys: tileSet({ ...tiles, tiles: tiles.modes.tiles }) } : null,
    );
    this.netUrl = (f) => `etbmgz://${dataUrl("")}${tiles.modes && f.cats !== ALL_CATS ? tiles.modes.url : tiles.url}`;
    if (basemap) {
      registerBasemapProtocol();
      prefetchBasemapIndex(basemap.root);
    }
    prefetchGz(glyphPrefetchUrls());
    const style: StyleSpecification = baseStyle(this.theme, (n) => dataUrl(`basemap/${n}.json`), basemap);
    style.sources.net = {
      type: "vector",
      tiles: [this.netUrl(this.state.filters)],
      minzoom: tiles.minzoom,
      maxzoom: tiles.maxzoom,
      bounds: [-32, 26, 62, 75],
    };
    Object.assign(style.sources, geojsonSources());
    if (urban) {
      Object.assign(style.sources, urbanSources(urban, dataUrl));
      style.layers.push(...urbanLayers(this.theme, false));
    }
    const net = networkLayers(this.theme, this.state);
    this.layerIds = net.map((l) => l.id);
    style.layers.push(...net);
    this.map = new maplibregl.Map({
      container,
      style,
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

    this.ready = new Promise((resolve) => this.map.once("load", () => resolve()));
    this.firstNetPaint = new Promise((resolve) => (this.resolveNetPaint = resolve));
    // first time the network tiles are drawn (used by tests / perf measurements)
    const onData = (e: maplibregl.MapSourceDataEvent) => {
      if (e.sourceId === "net" && e.isSourceLoaded && this.map.isSourceLoaded("net")) {
        this.map.off("sourcedata", onData);
        this.map.once("render", () => {
          this.map.getContainer().dataset.netLoaded = String(Math.round(performance.now()));
          this.resolveNetPaint();
        });
      }
    };
    this.map.on("sourcedata", onData);
    this.map.on("click", (e) => {
      const hit = this.hitAt(e.point);
      if (hit) this.closePopup();
      if (hit?.kind === "station") cb.onStation(hit.id, hit.city, hit.name);
      else if (hit) cb.onCity(hit.id);
      else {
        const u = this.urbanAt(e.point);
        if (u) this.showUrban(u, e.lngLat);
        else {
          this.closePopup();
          cb.onBackground();
        }
      }
    });
    this.map.on("mousemove", (e) => {
      // touch: a tap emulates a mousemove; ignore the ones that are part of a pan / pinch
      if (!this.map.isMoving()) this.hover(e.point);
    });
    this.map.on("mouseout", () => this.clearHover());
    // the hover tooltip is anchored to a screen point: close it whenever the map moves, and on
    // any press elsewhere (on touch screens it would otherwise stay put after a tap)
    for (const ev of ["movestart", "zoomstart", "dragstart", "touchstart"] as const) this.map.on(ev, () => this.clearHover());
    document.addEventListener("pointerdown", (e) => {
      if (!this.tooltip.hidden && e.target !== this.map.getCanvas()) this.clearHover();
    }, { capture: true, passive: true });
    this.map.on("moveend", () => cb.onMove?.());
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      this.theme = currentTheme();
      this.applyPaint(true);
    });
  }

  attachNet(net: Net): void {
    this.net = net;
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  private blobUrls = new Map<string, string>();

  /**
   * Large collections go to MapLibre's worker as a JSON blob URL: its
   * structured serialisation of thousands of objects is several times slower
   * on the main thread than JSON.stringify plus a worker-side parse.
   */
  private setData(source: string, data: GeoJSON.FeatureCollection): void {
    const src = this.map.getSource(source) as GeoJSONSource | undefined;
    if (!src) return;
    const old = this.blobUrls.get(source);
    if (data.features.length > 1000) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
      this.blobUrls.set(source, url);
      src.setData(url);
    } else {
      this.blobUrls.delete(source);
      src.setData(data);
    }
    if (old) setTimeout(() => URL.revokeObjectURL(old), 30_000);
  }

  /** Only the lines reached with changes (GeoJSON text from the transfer worker), after the rest of the highlight. */
  setXferLines(json: string): void {
    this.setJson("hl-xfer", json);
  }

  /** GeoJSON already serialised (e.g. by a worker): handed to MapLibre's worker as a blob URL. */
  private setJson(source: string, json: string): void {
    const src = this.map.getSource(source) as GeoJSONSource | undefined;
    if (!src) return;
    const old = this.blobUrls.get(source);
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    this.blobUrls.set(source, url);
    src.setData(url);
    if (old) setTimeout(() => URL.revokeObjectURL(old), 30_000);
  }

  // ---- interaction ------------------------------------------------------------

  private interactiveLayers(): string[] {
    return [...CITY_LAYERS, CITY_AREA_LAYER, ...FOCUS_LAYERS, ...STATION_LAYERS].filter((l) => this.map.getLayer(l));
  }

  /** City or station under a screen point (with tolerance for touch). */
  hitAt(p: maplibregl.Point): { kind: "city"; id: number } | { kind: "station"; id: number; city: number; name: string } | null {
    const f = this.featureAt(p);
    if (!f) return null;
    const props = f.properties as Record<string, number | string>;
    return isStation(f) ? { kind: "station", id: props.id as number, city: props.city as number, name: String(props.name ?? "") } : { kind: "city", id: props.id as number };
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

  // ---- local transport ------------------------------------------------------------

  /** Local-transport stop or line under a screen point (stops win over lines; hidden layers are not hit). */
  urbanAt(p: maplibregl.Point): UrbanHit | null {
    if (!this.hasUrban || !localOn(this.state.filters)) return null;
    const layers = URBAN_HIT_LAYERS.filter((l) => this.map.getLayer(l));
    const r = 8;
    const feats = this.map.queryRenderedFeatures([[p.x - r, p.y - r], [p.x + r, p.y + r]], { layers });
    let best: { f: MapGeoJSONFeature; d: number } | null = null;
    for (const f of feats) {
      const stop = f.geometry.type === "Point";
      let d = r * 1.5; // lines: any hit in the box
      if (stop) {
        const sp = this.map.project((f.geometry as GeoJSON.Point).coordinates as [number, number]);
        d = Math.hypot(sp.x - p.x, sp.y - p.y) - 6;
      }
      if (!best || d < best.d) best = { f, d };
    }
    if (!best) return null;
    const g = best.f.geometry;
    const lngLat = g.type === "Point" ? (g.coordinates as [number, number]) : ([this.map.unproject(p).lng, this.map.unproject(p).lat] as [number, number]);
    return { kind: g.type === "Point" ? "stop" : "line", props: best.f.properties as Record<string, string | number>, lngLat };
  }

  private showUrban(u: UrbanHit, at: maplibregl.LngLat): void {
    this.closePopup();
    this.popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "260px", className: "urb-popup", offset: u.kind === "stop" ? 10 : 6 })
      .setLngLat(u.kind === "stop" ? u.lngLat : at)
      .setDOMContent(urbanPopup(u))
      .addTo(this.map);
    this.popup.on("close", () => (this.popup = null));
  }

  closePopup(): void {
    this.popup?.remove();
    this.popup = null;
  }

  private hover(p: maplibregl.Point): void {
    const f = this.featureAt(p);
    if (!f) {
      const u = this.urbanAt(p);
      if (u) {
        this.setHover(null);
        this.map.getCanvas().style.cursor = "pointer";
        this.tooltip.textContent = u.kind === "stop" ? String(u.props.n ?? "") : `${u.props.n ?? ""}${u.props.a ? ` · ${u.props.a}` : ""}`;
        this.tooltip.style.transform = `translate(${p.x + 14}px, ${p.y - 10}px)`;
        this.tooltip.hidden = false;
        return;
      }
    }
    const props = (f?.properties ?? {}) as Record<string, number | string>;
    const isCity = f && !isStation(f) && f.id !== undefined;
    this.setHover(isCity ? { source: f.source, ...(f.sourceLayer ? { sourceLayer: f.sourceLayer } : {}), id: f.id as number } : null);
    this.map.getCanvas().style.cursor = f ? "pointer" : "";
    if (f) {
      this.tooltip.textContent = String(props.name ?? "");
      this.tooltip.style.transform = `translate(${p.x + 14}px, ${p.y - 10}px)`;
      this.tooltip.hidden = false;
    } else this.tooltip.hidden = true;
  }

  /** Hide the tooltip and the hover highlight. */
  private clearHover(): void {
    this.tooltip.hidden = true;
    this.setHover(null);
    this.map.getCanvas().style.cursor = "";
  }

  private setHover(h: { source: string; sourceLayer?: string; id: number } | null): void {
    if (h?.source === this.hovered?.source && h?.id === this.hovered?.id) return;
    if (this.hovered) this.map.setFeatureState(this.hovered, { hover: false });
    this.hovered = h;
    if (h) this.map.setFeatureState(h, { hover: true });
  }

  // ---- state -------------------------------------------------------------------

  async setFilters(f: Filters): Promise<void> {
    if (sameFilters(this.state.filters, f)) return;
    await this.ready;
    const catsChanged = f.cats !== this.state.filters.cats;
    const url = this.netUrl(f);
    const urlChanged = url !== this.netUrl(this.state.filters);
    this.state = { ...this.state, filters: f };
    this.applyUrbanVisibility();
    if (!catsChanged) return;
    // mode filters show more lines at low zoom: they have their own tiles
    if (urlChanged) (this.map.getSource("net") as maplibregl.VectorTileSource | undefined)?.setTiles([url]);
    // the set of category layers depends on the filters: rebuild the network layers
    const t0 = performance.now();
    for (const id of this.layerIds) if (this.map.getLayer(id)) this.map.removeLayer(id);
    const layers = networkLayers(this.theme, this.state);
    this.layerIds = layers.map((l) => l.id);
    for (const l of layers) this.map.addLayer(l);
    perf("filters: layers rebuilt", t0);
  }

  private applyUrbanVisibility(): void {
    if (!this.hasUrban) return;
    const on = localOn(this.state.filters);
    for (const id of URBAN_LAYER_IDS) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    if (!on) this.closePopup();
  }

  async setHighlight(h: Highlight): Promise<void> {
    await this.ready;
    const net = this.net;
    if (!net) return;
    const t0 = performance.now();
    const em = h.emphasis;
    const d = highlightData(net.geo, h.corridors, h.traffic);
    if (h.xferJson !== undefined) this.setJson("hl-xfer", h.xferJson);
    else this.setData("hl-xfer", xferData(net.geo, h.xfer ?? new Map()));
    this.setData("hl-ctx", contextData(net.geo, h.context ?? new Map()));
    this.setData("hl-casing", d.casing);
    this.setData("hl", d.lines);
    this.setData("hl-walk", { type: "FeatureCollection", features: (h.walks ?? []).map((coordinates) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } })) });
    this.setData("focus", focusCityData(net.cities, em));
    const sel = new Set([em.origin, em.dest].filter((x): x is number => x !== undefined));
    this.setData("focus-stations", stationData(net.cities, net.file.stations, sel, em.originStation));
    const next: LayerState = { ...this.state, dimmed: em.active, focus: [...em.focus], selected: [...sel] };
    const dimChanged = next.dimmed !== this.state.dimmed;
    this.state = next;
    // base cities / stations: hide the ones drawn by the focus layers
    const f = cityFilter(next);
    for (const id of CITY_LAYERS) this.map.setFilter(id, f);
    const layers = networkLayers(this.theme, next);
    for (const l of layers) if (l.id.startsWith("station-")) this.map.setFilter(l.id, (l as { filter?: maplibregl.FilterSpecification }).filter ?? null);
    if (dimChanged) this.applyPaint(false, layers);
    perf(`highlight (${d.lines.features.length} lines, ${em.focus.size} cities)`, t0);
  }

  /** Re-apply paint (and optionally layout) after a theme or dim change. */
  private applyPaint(withBase: boolean, net?: LayerSpecification[]): void {
    const all: LayerSpecification[] = [
      ...(withBase ? baseLayers(this.theme) : []),
      ...(this.hasUrban ? urbanLayers(this.theme, this.state.dimmed) : []),
      ...(net ?? networkLayers(this.theme, this.state)),
    ];
    for (const l of all) {
      if (!this.map.getLayer(l.id)) continue;
      for (const [k, v] of Object.entries((l as { paint?: Record<string, unknown> }).paint ?? {})) this.map.setPaintProperty(l.id, k, v);
      if (withBase) for (const [k, v] of Object.entries((l as { layout?: Record<string, unknown> }).layout ?? {})) this.map.setLayoutProperty(l.id, k, v);
    }
  }

  // ---- camera -----------------------------------------------------------------

  /** Frame a set of cities, leaving room for the panel. */
  fitCities(ids: number[], padding: Padding, maxZoom = 8): void {
    const net = this.net;
    if (!ids.length || !net) return;
    const b = new maplibregl.LngLatBounds();
    for (const id of ids) {
      const c = net.cities[id];
      if (c) b.extend([c.lon, c.lat]);
    }
    const pad = { top: padding.top + 50, bottom: padding.bottom + 50, left: padding.left + 60, right: padding.right + 60 };
    if (ids.length === 1) {
      const c = net.cities[ids[0]!]!;
      if (!this.isVisible(c.lon, c.lat, padding)) this.map.easeTo({ center: [c.lon, c.lat], padding, duration: 700 });
      return;
    }
    const cam = this.map.cameraForBounds(b, { padding: pad, maxZoom });
    if (!cam) return;
    const allVisible = ids.every((id) => {
      const c = net.cities[id]!;
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
    const c = this.net?.cities[id];
    if (c) this.map.flyTo({ center: [c.lon, c.lat], zoom: zoom ?? Math.max(this.map.getZoom(), 6) });
  }
}

function isStation(f: MapGeoJSONFeature): boolean {
  return f.sourceLayer === TILE_LAYERS.station || f.source === "focus-stations";
}

export { STATION_ZOOM };
