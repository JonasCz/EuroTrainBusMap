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
  if (!manifest.mapdata) throw new Error("This data build has no map data (core.json); rebuild the data.");

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
    {
      onCity: (id) => app?.clickCity(id),
      onBackground: () => app?.background(),
    },
    padding,
  );

  // core.json (cities) downloads while the map fetches basemap, glyphs and tiles; it is parsed
  // after the first network paint (or after 2 s at most)
  const ds = await loadDataSet(manifest, Promise.race([map.firstNetPaint, new Promise((r) => setTimeout(r, 2000))]));
  const net = buildNet(ds);
  panel = new Panel(net, side);
  map.attachNet(net);
  app = new App(net, map, panel, padding);
  panel.actions = app as unknown as PanelActions;
  mountAttribution(document.getElementById("attribution")!, document.getElementById("sources") as HTMLDialogElement, () => loadAttribution(ds), manifest.generatedAt);

  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    if (t.closest("dialog") || t.id === "search") return;
    app?.back();
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
