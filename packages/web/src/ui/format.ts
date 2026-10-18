import { Cat, endpointsName, routeBrand, type Route } from "@etbm/shared";
import { cityTz, stationName, type Net } from "../data/net.ts";
import { dayShift, fmtTime, tzAbbr } from "../logic/tz.ts";
import { currentTheme } from "../map/theme.ts";
import { h, icon } from "./dom.ts";
import { modeIcon } from "./icons.ts";
import { CAT_LABEL } from "../logic/filters.ts";
import { bookingCaveat } from "../logic/caveat.ts";

/** Time at a station, in that station's city tz; marks day shifts and foreign zones. */
export function timeEl(net: Net, utc: number, station: number, opts: { refDate?: string; refTz?: string; strong?: boolean } = {}): HTMLElement {
  const city = net.file.stations[station]!.city;
  return timeAt(utc, cityTz(net, city), net.cities[city]!.name, opts);
}

/** A time in zone `tz` (`place` names where that is local time). */
export function timeAt(utc: number, tz: string, place: string, opts: { refDate?: string; refTz?: string; strong?: boolean } = {}): HTMLElement {
  const shift = opts.refDate ? dayShift(utc, tz, opts.refDate) : 0;
  const foreign = opts.refTz && tzOffsetLabel(utc, tz) !== tzOffsetLabel(utc, opts.refTz);
  return h(
    "span",
    { class: `time${opts.strong ? " time--strong" : ""}`, title: `${fmtTime(utc, tz)} ${tzAbbr(utc, tz)} (local time ${place})` },
    h("time", { datetime: new Date(utc).toISOString() }, fmtTime(utc, tz)),
    shift ? h("sup", { class: "dayshift", "aria-label": `${shift > 0 ? "+" : ""}${shift} day` }, `${shift > 0 ? "+" : ""}${shift}`) : null,
    foreign ? h("span", { class: "tzabbr" }, tzAbbr(utc, tz)) : null,
  );
}

function tzOffsetLabel(utc: number, tz: string): string {
  return tzAbbr(utc, tz);
}

function luminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

export function routeColor(r: Route): string {
  return r.color && /^[0-9a-f]{6}$/i.test(r.color) ? `#${r.color}` : currentTheme().cat[r.cat] ?? "#777";
}

/**
 * The name a route is shown with: its own, except a train named only by where it runs
 * ("Paris-Gare-de-Lyon/Marseille-St-Charles"), which shows its operator's brand ("Frecciarossa").
 */
export function routeDisplayName(r: Route): string {
  return r.cat !== Cat.Bus && r.cat !== Cat.Coach && r.agency && endpointsName(r.name) ? routeBrand(r.name, r.agency, r.cat) : r.name;
}

/** Coloured pill: "ICE 597" */
export function routeBadge(r: Route, number?: string): HTMLElement {
  const bg = routeColor(r);
  const fg = luminance(bg) > 0.45 ? "#111" : "#fff";
  const label = routeDisplayName(r);
  const name = number && !label.includes(number) ? `${label} ${number}` : label;
  return h("span", { class: "badge", style: `--badge-bg:${bg};--badge-fg:${fg}`, title: label !== r.name ? `${r.agency} · ${r.name}` : r.agency }, name);
}

/** Mode pictogram + coloured pill: "[train] ICE 597" (the pill keeps the operator's colour), plus a booking caveat badge. */
export function routeTag(r: Route, number?: string): HTMLElement {
  return h("span", { class: "route-tag" }, modeIcon(r.cat, 16, CAT_LABEL[r.cat]), routeBadge(r, number), caveatBadge(r));
}

/** Small info badge for a service with a booking caveat (logic/caveat.ts); null for ordinary ones. */
export function caveatBadge(r: Route): HTMLElement | null {
  const c = bookingCaveat(r);
  if (!c) return null;
  return h("span", { class: "caveat", role: "img", title: c.text, "aria-label": `${c.label}: ${c.text}` }, icon("info", 13), h("span", { class: "caveat-label", "aria-hidden": "true" }, c.label));
}

/** The booking caveat as a sentence (trip schedule, journey legs); null for ordinary services. */
export function caveatNote(r: Route): HTMLElement | null {
  const c = bookingCaveat(r);
  if (!c) return null;
  return h("p", { class: "caveat-note" }, icon("info", 14), h("span", null, c.text));
}

export function station(net: Net, id: number): string {
  return stationName(net, id);
}

/** Walking distance: "650 m", "4.6 km", "12 km". */
export function fmtKm(km: number): string {
  if (km < 1) return `${Math.max(100, Math.round(km * 10) * 100)} m`;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}
