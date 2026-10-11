/** Tiny DOM builder. */
type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)> & { class?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (typeof v === "function") el.addEventListener(k.replace(/^on/, "").toLowerCase(), v as EventListener);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Inline icons (stroke-based, 24×24 viewBox). */
const ICONS: Record<string, string> = {
  close: "M6 6l12 12M18 6L6 18",
  back: "M15 5l-7 7 7 7",
  prev: "M15 5l-7 7 7 7",
  next: "M9 5l7 7-7 7",
  swap: "M7 7h11l-3-3M17 17H6l3 3",
  walk: "M13 4.5a1.5 1.5 0 1 0 0 .01M10 21l2-6 3 3v3M9 12l1.5-4 3 1 2 3 2.5 1M10.5 8L8 10v3",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  info: "M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  seat: "M7 4v9a2 2 0 0 0 2 2h7M9 19h8M16 15v4",
  arrow: "M5 12h14M13 6l6 6-6 6",
};

export function icon(name: keyof typeof ICONS | string, size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "icon");
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", ICONS[name] ?? "");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "2");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  svg.appendChild(p);
  return svg;
}
