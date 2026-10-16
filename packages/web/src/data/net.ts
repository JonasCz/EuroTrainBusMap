/** In-memory indexes over the network (cities from core.json; stations/calendars on demand). */
import type { City, Corridor, Station } from "@etbm/shared";
import { buildCalIndex, type CalIndex } from "../logic/calendar.ts";
import { buildNetCtx, type NetCtx } from "../logic/context.ts";
import { geoStore, loadDetail, type DataSet, type GeoStore } from "./load.ts";

export type CorridorExt = Corridor;

export interface Net {
  ds: DataSet;
  cities: City[];
  /** Stations: sparse, filled from the geo files of the loaded timetable shards. */
  file: { stations: Station[]; timezones: string[] };
  /** Calendars: an empty placeholder until `ensureDetail` has run. */
  cal: CalIndex;
  ctx: NetCtx;
  /** Corridors and segment geometry of the loaded timetable shards. */
  geo: GeoStore;
  slug: string[];
  bySlug: Map<string, number>;
  /** slugified city names (no disambiguation suffix), for search */
  nameKey: string[];
  counts: { stations: number; corridors: number; segments: number };
  detailLoaded: boolean;
}

const ASCII_SLUG = /^[a-z0-9]+(?:[ -][a-z0-9]+)*$/;

export function slugify(s: string): string {
  const lower = s.toLowerCase();
  if (ASCII_SLUG.test(lower)) return lower.replace(/ /g, "-"); // fast path (most names)
  return s
    .toLocaleLowerCase("en")
    .replace(/ı/g, "i")
    .replace(/ß/g, "ss")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function buildNet(ds: DataSet): Net {
  const cities = ds.cities;
  const slug: string[] = [];
  const bySlug = new Map<string, number>();
  const counts = new Map<string, number>();
  const nameKey = cities.map((c) => slugify(c.name));
  for (const c of cities) {
    const s = nameKey[c.id] || `city-${c.id}`;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  for (const c of cities) {
    let s = nameKey[c.id] || `city-${c.id}`;
    if (counts.get(s)! > 1) s = `${s}-${c.country.toLowerCase()}`;
    if (bySlug.has(s)) s = `${s}-${c.id}`;
    slug[c.id] = s;
    bySlug.set(s, c.id);
  }
  const m = ds.manifest;
  const cal = buildCalIndex({ startDate: m.startDate, days: m.days, masks: [] });
  const file = { stations: geoStore.stations, timezones: ds.core.timezones };
  return {
    ds,
    cities,
    file,
    cal,
    ctx: buildNetCtx({ cities, timezones: ds.core.timezones }, cal),
    geo: geoStore,
    slug,
    bySlug,
    nameKey,
    counts: ds.core.counts,
    detailLoaded: false,
  };
}

/** Load the calendars (once) and wire them into the net. */
export async function ensureDetail(net: Net): Promise<void> {
  if (net.detailLoaded) return;
  const d = await loadDetail(net.ds);
  net.cal = buildCalIndex(d.calendars);
  net.ctx.cal = net.cal;
  net.detailLoaded = true;
}

export function cityByRef(net: Net, ref: string | null | undefined): number | undefined {
  if (!ref) return undefined;
  const id = net.bySlug.get(ref);
  if (id !== undefined) return id;
  if (/^\d+$/.test(ref) && net.cities[+ref]) return +ref;
  return undefined;
}

export function cityTz(net: Net, city: number): string {
  return net.ctx.cityTz[city] ?? "UTC";
}

export function stationName(net: Net, station: number): string {
  return net.file.stations[station]?.name ?? "?";
}
