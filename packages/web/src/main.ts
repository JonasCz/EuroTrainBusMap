import "./styles.css";
import { App } from "./app.ts";
import { dataUrl, loadAttribution, loadDataSet, loadDetail, loadManifest } from "./data/load.ts";
import { buildNet } from "./data/net.ts";
import { MapView } from "./map/mapview.ts";
import { mountAttribution } from "./ui/attribution.ts";
import { Panel, type PanelActions } from "./ui/panel.ts";

const mobile = matchMedia("(max-width: 719px)");

async function main(): Promise<void> {
  const side = document.getElementById("side")!;
  const manifest = await loadManifest();
  if (!manifest.mapdata || !manifest.packs) throw new Error("This data build has no map data (core.json, tile packs); rebuild the data.");

  let panel: Panel | null = null;
  const padding = () => {
    if (mobile.matches) {
      const top = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
      return { top: top + 4, bottom: panel?.sheetHeight() ?? 150, left: 0, right: 0 };
    }
    return { top: 0, bottom: 0, left: side.getBoundingClientRect().right, right: 0 };
  };
  let app: App | null = null;
  const map = new MapView(
    document.getElementById("map")!,
    dataUrl(manifest),
    manifest.mapdata.tiles,
    manifest.packs,
    {
      onCity: (id) => app?.clickCity(id),
      onStation: (id, city, name) => app?.clickStation(id, city, name),
      onBackground: () => app?.background(),
    },
    padding,
    manifest.basemap ? { minzoom: manifest.basemap.minzoom, maxzoom: manifest.basemap.maxzoom, bounds: manifest.basemap.bounds } : null,
    manifest.urban ?? null,
  );

  // core.json (cities) downloads while the map fetches basemap, glyphs and tiles; it is parsed
  // after the first network paint (or after 2 s at most)
  const ds = await loadDataSet(manifest, Promise.race([map.firstNetPaint, new Promise((r) => setTimeout(r, 2000))]));
  const net = buildNet(ds);
  panel = new Panel(net, side);
  panel.showLocalChip(!!manifest.urban);
  map.attachNet(net);
  app = new App(net, map, panel, padding);
  panel.actions = app as unknown as PanelActions;
  mountAttribution(document.getElementById("attribution")!, document.getElementById("sources") as HTMLDialogElement, () => loadAttribution(ds), manifest.generatedAt);

  // Esc: one view up; Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z (or Ctrl+Y): undo / redo an edit of the journey (not in text fields)
  addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    if (t.closest("dialog")) return;
    const typing = t.closest("input, textarea, select, [contenteditable]") !== null;
    if (e.key === "Escape") {
      if (t.id !== "search") app?.back();
      return;
    }
    if (typing || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "z" || k === "y") {
      e.preventDefault();
      if (k === "y" || e.shiftKey) app?.redo();
      else app?.undo();
    }
  });

  await app.render();
  document.body.classList.add("ready");
  (window as unknown as { __etbm: unknown }).__etbm = { app, map: map.map, net };

  // prefetch the calendars when the browser is idle, so the first tap is quick
  const prefetch = () => void loadDetail(ds).catch(() => undefined);
  if ("requestIdleCallback" in window) requestIdleCallback(prefetch, { timeout: 3000 });
  else setTimeout(prefetch, 1500);
}

main().catch((e: unknown) => {
  console.error(e);
  const el = document.getElementById("fatal");
  if (el) {
    el.hidden = false;
    el.textContent = `Could not load the map data. ${(e as Error).message ?? ""}`;
  }
});
