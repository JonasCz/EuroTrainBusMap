import type { AttributionFile } from "@etbm/shared";
import { h } from "./dom.ts";
import { sourceMeta } from "../logic/source.ts";

/** Footer line + dialog listing all data sources. */
export function mountAttribution(footer: HTMLElement, dialog: HTMLDialogElement, load: () => Promise<AttributionFile>, generatedAt: string): void {
  let filled = false;
  const open = h(
    "button",
    {
      type: "button",
      class: "link",
      onclick: async () => {
        if (!filled) {
          fill(dialog, await load(), generatedAt);
          filled = true;
        }
        dialog.showModal();
      },
    },
    "Data sources",
  );
  footer.replaceChildren(
    h("a", { href: "https://www.openstreetmap.org/copyright", target: "_blank", rel: "noopener" }, "© OpenStreetMap contributors"),
    h("span", { class: "sep" }, "·"),
    h("a", { href: "https://www.naturalearthdata.com/", target: "_blank", rel: "noopener" }, "Natural Earth"),
    h("span", { class: "sep" }, "·"),
    open,
  );
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}

function fill(dialog: HTMLDialogElement, file: AttributionFile, generatedAt: string): void {
  const sources = [
    ...file.sources,
    ...(file.sources.some((s) => /openstreetmap/i.test(s.name)) ? [] : [{ name: "OpenStreetMap", license: "ODbL 1.0", url: "https://www.openstreetmap.org/copyright", attribution: "© OpenStreetMap contributors" }]),
    ...(file.sources.some((s) => /natural earth/i.test(s.name)) ? [] : [{ name: "Natural Earth", license: "Public domain", url: "https://www.naturalearthdata.com/" }]),
    { name: "Noto Sans", license: "SIL Open Font License 1.1", url: "https://notofonts.github.io/" },
    { name: "MapLibre GL JS", license: "BSD-3-Clause", url: "https://maplibre.org/" },
  ];
  dialog.replaceChildren(
    h(
      "form",
      { method: "dialog", class: "dialog-inner" },
      h("div", { class: "view-head" }, h("div", { class: "view-title" }, h("h2", null, "Data sources")), h("button", { class: "icon-btn", value: "close", "aria-label": "Close" }, "×")),
      h(
        "ul",
        { class: "sources" },
        sources.map((s) =>
          h(
            "li",
            null,
            s.url ? h("a", { href: s.url, target: "_blank", rel: "noopener" }, s.name) : h("strong", null, s.name),
            h("span", { class: "muted" }, sourceMeta(s)),
            s.attribution ? h("div", { class: "small muted" }, s.attribution) : null,
          ),
        ),
      ),
      h("p", { class: "small muted" }, `Data generated ${new Date(generatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}. Timetables may be incomplete; always check with the operator before travelling.`),
    ),
  );
}
