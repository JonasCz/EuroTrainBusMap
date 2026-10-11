/** Static data loading. All URLs are relative to Vite's BASE_URL. */
import type { AttributionFile, CalendarsFile, CityFile, Manifest, NetworkFile } from "@etbm/shared";

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
  network: NetworkFile;
  calendars: CalendarsFile;
  attribution: AttributionFile;
  url(path: string): string;
}

export async function loadDataSet(): Promise<DataSet> {
  const manifest = await getJson<Manifest>(`${BASE}data/manifest.json`, { cache: "no-cache" });
  const url = (p: string) => absUrl(`data/${manifest.build}/${p}`);
  const [network, calendars, attribution] = await Promise.all([
    getJson<NetworkFile>(url("network.json")),
    getJson<CalendarsFile>(url("calendars.json")),
    getJson<AttributionFile>(url("attribution.json")).catch(() => ({ sources: [] }) as AttributionFile),
  ]);
  return { manifest, network, calendars, attribution, url };
}

const cityCache = new Map<number, Promise<CityFile>>();

export function loadCity(ds: DataSet, id: number): Promise<CityFile> {
  let p = cityCache.get(id);
  if (!p) {
    p = getJson<CityFile>(ds.url(`city/${id}.json`));
    p.catch(() => cityCache.delete(id));
    cityCache.set(id, p);
  }
  return p;
}
