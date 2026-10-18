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
  walk: "M13.5 2.8a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4zM9.5 21l2.2-6.2 2.8 2.7V21M12.5 14.5l-1-5.5M7.5 12.5l1.3-3.3 2.7-.2 2.3 3.2 2.7 1",
  // bicycle, side view: two wheels, diamond frame, saddle and handlebar
  bike: "M2.3 16.5a3.2 3.2 0 1 0 6.4 0 3.2 3.2 0 1 0-6.4 0zM15.3 16.5a3.2 3.2 0 1 0 6.4 0 3.2 3.2 0 1 0-6.4 0zM5.5 16.5 9 9.5h7l2.5 7M9 9.5l3 7H5.5M12 16.5l4-7M7.5 7h3M9 7v2.5M16 9.5l-1-3h2.3",
  // metro / tram, front view: car body, windows, lights, rails
  transit: "M7 3h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM5 10h14M8.5 13.5h.01M15.5 13.5h.01M8 17l-2 4M16 17l2 4M10 6h4",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  info: "M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  seat: "M5 4v7a3 3 0 0 0 3 3h11M15 10l4 4-4 4",
  arrow: "M5 12h14M13 6l6 6-6 6",
  check: "M5 12.5l4.5 4.5L19 7.5",
  edit: "M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4",
  undo: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  redo: "M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
  calendar: "M6 5h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM4 10h16M8.5 3v4M15.5 3v4",
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
