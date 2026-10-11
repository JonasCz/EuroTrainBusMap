/** In-memory indexes over the network file. */
import type { City, Corridor, NetworkFile, Segment } from "@etbm/shared";
import { netSegments } from "../map/features.ts";
import { buildCalIndex, type CalIndex } from "../logic/calendar.ts";
import { buildNetCtx, type NetCtx } from "../logic/context.ts";
import type { DataSet } from "./load.ts";

/**
 * Optional corridor extension (proposed for the schema): Cat bits on this
 * corridor that carry Deutschlandticket-valid services.
 */
export type CorridorExt = Corridor & { dtCats?: number };

export interface Net {
  ds: DataSet;
  file: NetworkFile;
  cal: CalIndex;
  ctx: NetCtx;
  cities: City[];
  corridors: CorridorExt[];
  /** Line-graph segments (drawing). */
  segments: Segment[];
  slug: string[];
  bySlug: Map<string, number>;
  /** Whether the data has `dtCats` on corridors; otherwise a DE-only heuristic is used. */
  hasDtCats: boolean;
}

export function slugify(s: string): string {
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
  const file = ds.network;
  const cal = buildCalIndex(ds.calendars);
  const slug: string[] = [];
  const bySlug = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const c of file.cities) {
    const s = slugify(c.name) || `city-${c.id}`;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  for (const c of file.cities) {
    let s = slugify(c.name) || `city-${c.id}`;
    if (counts.get(s)! > 1) s = `${s}-${c.country.toLowerCase()}`;
    if (bySlug.has(s)) s = `${s}-${c.id}`;
    slug[c.id] = s;
    bySlug.set(s, c.id);
  }
  const corridors = file.corridors as CorridorExt[];
  return {
    ds,
    file,
    cal,
    ctx: buildNetCtx(file, cal),
    cities: file.cities,
    corridors,
    segments: netSegments(file as { corridors: CorridorExt[]; segments?: Segment[] }),
    slug,
    bySlug,
    hasDtCats: corridors.some((c) => c.dtCats !== undefined),
  };
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
