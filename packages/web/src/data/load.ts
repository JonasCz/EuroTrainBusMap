/**
 * Static data loading. All URLs are relative to Vite's BASE_URL.
 *
 * Startup needs only manifest.json + core.json (cities); the map draws from
 * vector tiles. Stations and calendars ("detail") are fetched once a city is
 * selected – or prefetched when the browser is idle – and every timetable
 * shard comes with a geo file holding the corridors it references.
 */
import {
  unpackCore,
  unpackGeo,
  type AttributionFile,
  type CalendarsFile,
  type City,
  type CityFile,
  type CityShardFile,
  type CoreFile,
  type Corridor,
  type GeoFile,
  type Manifest,
  type Pos,
  type Station,
} from "@etbm/shared";

const BASE = import.meta.env.BASE_URL;

/** Absolute URL (some MapLibre resources need absolute URLs). */
export function absUrl(path: string): string {
  return new URL(BASE + path, location.href).href;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} – ${url}`);
  return (await res.json()) as T;
}

export interface DataSet {
  manifest: Manifest;
  core: CoreFile;
  cities: City[];
  /** station id → city id (stations are numbered city by city) */
  stationCity: Int32Array;
  url(path: string): string;
}

export async function loadManifest(): Promise<Manifest> {
  return getJson<Manifest>(`${BASE}data/manifest.json`, { cache: "no-cache" });
}

export function dataUrl(manifest: Manifest): (p: string) => string {
  return (p: string) => absUrl(`data/${manifest.build}/${p}`);
}

/**
 * core.json: downloaded right away, but parsed only once `gate` resolves (the
 * first network paint), so on slow phones the map draws before the app parses
 * 36k cities on the same thread.
 */
export async function loadDataSet(manifest: Manifest, gate: Promise<unknown> = Promise.resolve()): Promise<DataSet> {
  const url = dataUrl(manifest);
  if (!manifest.mapdata) throw new Error("This data build has no map data (core.json); rebuild the data.");
  const res = await fetch(url(manifest.mapdata.core));
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} – core.json`);
  const text = await res.text();
  await gate;
  const core = JSON.parse(text) as CoreFile;
  const cities = unpackCore(core);
  const stationCity = new Int32Array(core.counts.stations).fill(-1);
  for (const c of cities) for (const s of c.stations) stationCity[s] = c.id;
  return { manifest, core, cities, stationCity, url };
}

// ---------------------------------------------------------------- detail (calendars)

export interface Detail {
  calendars: CalendarsFile;
}

let detail: Promise<Detail> | null = null;

export function loadDetail(ds: DataSet): Promise<Detail> {
  detail ??= getJson<CalendarsFile>(ds.url("calendars.json"))
    .then((calendars) => ({ calendars }))
    .catch((e: unknown) => {
      detail = null;
      throw e;
    });
  return detail;
}

let attribution: Promise<AttributionFile> | null = null;
export function loadAttribution(ds: DataSet): Promise<AttributionFile> {
  attribution ??= getJson<AttributionFile>(ds.url("attribution.json")).catch(() => ({ sources: [] }));
  return attribution;
}

// ---------------------------------------------------------------- city files + geo

/** Stations, corridors and segment geometry gathered from the loaded geo files. */
export interface GeoStore {
  /** sparse: only stations of loaded shards */
  stations: Station[];
  corridors: Map<number, Corridor>;
  cut: Map<number, [number, number]>;
  segments: Map<number, { coords: Pos[]; snapped: boolean; hop: boolean }>;
}

export const geoStore: GeoStore = { stations: [], corridors: new Map(), cut: new Map(), segments: new Map() };

const fileCache = new Map<string, Promise<unknown>>();

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  let p = fileCache.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load();
    p.catch(() => fileCache.delete(key));
    fileCache.set(key, p);
  }
  return p;
}

function loadGeo(ds: DataSet, rel: string): Promise<void> {
  return cached(`geo:${rel}`, async () => {
    const g = unpackGeo(await getJson<GeoFile>(ds.url(rel)), (sid) => ds.cities[ds.stationCity[sid] ?? -1]);
    for (const s of g.stations) geoStore.stations[s.id] = s;
    for (const c of g.corridors) geoStore.corridors.set(c.id, c);
    for (const [k, v] of g.cut) geoStore.cut.set(k, v);
    for (const [k, v] of g.segments) geoStore.segments.set(k, v);
  });
}

/**
 * CityFile of a city (from its shard, City.shard, or city/<id>.json), resolved
 * once the matching geo file (its corridors) has been merged into geoStore.
 */
export function loadCity(ds: DataSet, id: number): Promise<CityFile> {
  return cached(`city:${id}`, async () => {
    const shard = ds.cities[id]?.shard;
    if (shard === undefined) {
      const [cf] = await Promise.all([getJson<CityFile>(ds.url(`city/${id}.json`)), loadGeo(ds, `geo/c${id}.json`)]);
      return cf;
    }
    const [f] = await Promise.all([cached(`shard:${shard}`, () => getJson<CityShardFile>(ds.url(`shard/${shard}.json`))), loadGeo(ds, `geo/${shard}.json`)]);
    const cf = f.cities[String(id)];
    if (!cf) throw new Error(`city ${id} missing in shard ${shard}`);
    return cf;
  });
}
