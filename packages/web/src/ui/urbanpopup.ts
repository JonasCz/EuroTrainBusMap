import { frequencyBand, stopModes, URBAN_MODE_LABEL } from "../logic/urban.ts";
import { h, icon } from "./dom.ts";
import { staleWarning } from "../logic/stale.ts";
import type { UrbanHit } from "../map/urban.ts";

const GEOM_NOTE = ["", "", "approximate course along the road", "approximate course (stop to stop)"];

/** Small popup for a local-transport stop or line (DOM only, text set safely). */
export function urbanPopup(u: UrbanHit): HTMLElement {
  const p = u.props;
  if (u.kind === "stop") {
    const modes = stopModes(Number(p.m ?? 0));
    const lines = String(p.l ?? "").split(" ").filter(Boolean);
    return h(
      "div",
      { class: "urb-card" },
      h("div", { class: "urb-title" }, String(p.n ?? "Stop")),
      h("div", { class: "urb-sub" }, modes.join(" · ") || "Stop"),
      lines.length ? h("div", { class: "urb-lines" }, lines.map((l) => h("span", { class: "urb-line" }, l))) : null,
    );
  }
  const mode = Number(p.m ?? 0);
  const color = typeof p.c === "string" && /^[0-9a-f]{6}$/i.test(p.c) ? `#${p.c}` : null;
  const band = frequencyBand(Number(p.t ?? 0));
  const note = GEOM_NOTE[Number(p.g ?? 0)];
  // the line's feed has run out (tile property e, packages/shared/src/urban.ts): its lines come from its last weeks
  const stale = staleWarning({ expired: typeof p.e === "string" ? p.e : undefined });
  return h(
    "div",
    { class: "urb-card" },
    h("div", { class: "urb-title" }, h("span", { class: "urb-line big", style: color ? `background:${color}` : null }, String(p.n ?? "")), URBAN_MODE_LABEL[mode] ?? "Line"),
    p.d ? h("div", { class: "urb-sub" }, String(p.d)) : null,
    h("div", { class: "urb-sub" }, [p.a ? String(p.a) : "", band].filter(Boolean).join(" · ")),
    note ? h("div", { class: "urb-note" }, note) : null,
    stale ? h("div", { class: "urb-stale", title: stale.title }, icon("alert", 12), h("span", null, stale.text)) : null,
  );
}
