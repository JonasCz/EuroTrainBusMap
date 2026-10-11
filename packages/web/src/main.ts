import "./styles.css";
import { App } from "./app.ts";
import { loadDataSet } from "./data/load.ts";
import { buildNet } from "./data/net.ts";
import { MapView } from "./map/mapview.ts";
import { mountAttribution } from "./ui/attribution.ts";
import { Panel } from "./ui/panel.ts";

const mobile = matchMedia("(max-width: 719px)");

async function main(): Promise<void> {
  const side = document.getElementById("side")!;
  const ds = await loadDataSet();
  const net = buildNet(ds);
  const panel = new Panel(net, side);

  const padding = () => {
    if (mobile.matches) {
      const top = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
      return { top: top + 4, bottom: panel.sheetHeight(), left: 0, right: 0 };
    }
    return { top: 0, bottom: 0, left: side.getBoundingClientRect().right, right: 0 };
  };

  let app: App | null = null;
  const map = new MapView(
    document.getElementById("map")!,
    net,
    {
      onCity: (id) => app?.clickCity(id),
      onBackground: () => app?.background(),
    },
    padding,
  );
  app = new App(net, map, panel, padding);
  panel.actions = app as unknown as import("./ui/panel.ts").PanelActions;
  mountAttribution(document.getElementById("attribution")!, document.getElementById("sources") as HTMLDialogElement, ds.attribution, ds.manifest.generatedAt);

  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    if (t.closest("dialog") || t.id === "search") return;
    app?.back();
  });

  await app.render();
  document.body.classList.add("ready");
  (window as unknown as { __etbm: unknown }).__etbm = { app, map: map.map, net };
}

main().catch((e: unknown) => {
  console.error(e);
  const el = document.getElementById("fatal");
  if (el) {
    el.hidden = false;
    el.textContent = `Could not load the map data. ${(e as Error).message ?? ""}`;
  }
});
