/**
 * Mode icons: one pictogram per transport mode (inline SVG, 24×24 grid, drawn in `currentColor`
 * and coloured with the mode's CSS variable, so they follow the light / dark theme).
 */
import { Cat } from "@etbm/shared";

const SVG_NS = "http://www.w3.org/2000/svg";

/** [tag, attributes]; strokes use currentColor unless the shape says otherwise. */
type Shape = [string, Record<string, string | number>];

const STROKE = { fill: "none", stroke: "currentColor", "stroke-width": 1.9, "stroke-linecap": "round", "stroke-linejoin": "round" };
const FILL = { fill: "currentColor" };

/** Pictograms, keyed by Cat bit; "local" = metro / tram / city bus. */
const SHAPES: Record<string, Shape[]> = {
  // high-speed train, side view: streamlined nose, window band, track
  [Cat.LongDistance]: [
    ["path", { d: "M2.5 6.5h10.2c4.3 0 7.9 3.3 8.8 7.6.2.9-.5 1.9-1.5 1.9H2.5", ...STROKE }],
    ["path", { d: "M2.5 10h8.5M14.5 8.2l2.2 3.3h3.6", ...STROKE }],
    ["path", { d: "M2 20h20", ...STROKE }],
  ],
  // regional train, front view: flat cab, wide windscreen, headlights, wheels on the track
  [Cat.Regional]: [
    ["rect", { x: 5, y: 2.8, width: 14, height: 14.4, rx: 3, ...STROKE }],
    ["path", { d: "M8.3 5.8h7.4a.8.8 0 0 1 .8.8v3.6H7.5V6.6a.8.8 0 0 1 .8-.8z", ...FILL }],
    ["circle", { cx: 8.6, cy: 13.6, r: 1.15, ...FILL }],
    ["circle", { cx: 15.4, cy: 13.6, r: 1.15, ...FILL }],
    ["path", { d: "M8.5 17.2 6.3 21M15.5 17.2l2.2 3.8", ...STROKE }],
  ],
  // long-distance coach, side view: long body, big windows, two wheels
  [Cat.Coach]: [
    ["path", { d: "M3 16.3h-.4a.9.9 0 0 1-.9-.9V7.6c0-.6.5-1.1 1.1-1.1h16c1.4 0 2.5.8 2.9 2.1l.6 2.2v4.6a.9.9 0 0 1-.9.9h-.5M15.3 16.3H8.7", ...STROKE }],
    ["path", { d: "M4 8.9h3.9v3.3H4zM9.1 8.9H13v3.3H9.1zM14.2 8.9h3.9v3.3h-3.9zM19.2 8.9h.9l.9 3.3h-1.8z", ...FILL }],
    ["circle", { cx: 5.9, cy: 16.6, r: 1.85, ...STROKE }],
    ["circle", { cx: 18.1, cy: 16.6, r: 1.85, ...STROKE }],
  ],
  // regional bus, front view: smaller, mirrors, windscreen, short wheels
  [Cat.Bus]: [
    ["rect", { x: 6, y: 3.5, width: 12, height: 14, rx: 2.4, ...STROKE }],
    ["path", { d: "M6 7.5H4.2v3M18 7.5h1.8v3", ...STROKE }],
    ["path", { d: "M8.6 6.5h6.8a.6.6 0 0 1 .6.6v4.4H8V7.1a.6.6 0 0 1 .6-.6z", ...FILL }],
    ["path", { d: "M8.8 14.5h.4M14.8 14.5h.4", ...STROKE, "stroke-width": 2.4 }],
    ["path", { d: "M8.6 17.5v2.6M15.4 17.5v2.6", ...STROKE, "stroke-width": 2.4 }],
  ],
  // tram, front view: pantograph on the overhead wire, rounded body, track
  local: [
    ["path", { d: "M5 2.5h14M9.5 6.2 12 2.6l2.5 3.6", ...STROKE }],
    ["rect", { x: 6.5, y: 6.2, width: 11, height: 11.8, rx: 2.6, ...STROKE }],
    ["path", { d: "M9.1 8.6h5.8a.6.6 0 0 1 .6.6v3.4h-7V9.2a.6.6 0 0 1 .6-.6z", ...FILL }],
    ["path", { d: "M9.6 15.3h.3M14.1 15.3h.3", ...STROKE, "stroke-width": 2.3 }],
    ["path", { d: "M9.5 18 8 21M14.5 18l1.5 3", ...STROKE }],
  ],
};

function build(shapes: Shape[], size: number, cls: string, color: string, label?: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("class", cls);
  svg.style.setProperty("--c", color);
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
    const t = document.createElementNS(SVG_NS, "title");
    t.textContent = label;
    svg.appendChild(t);
  } else svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of shapes) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}

/**
 * The pictogram of a mode (Cat bit) in the mode's colour (`--cat-N`). With `label` it is announced
 * (and shows it as a tooltip); without, it is decorative.
 */
export function modeIcon(cat: number, size = 16, label?: string): SVGSVGElement {
  return build(SHAPES[cat] ?? SHAPES[Cat.Bus]!, size, "mode-icon", `var(--cat-${cat})`, label);
}

/** The pictogram of local transport (metro / tram / city bus), in the local-transport colour. */
export function localIcon(size = 16, label?: string): SVGSVGElement {
  return build(SHAPES.local!, size, "mode-icon", "var(--urban)", label);
}

