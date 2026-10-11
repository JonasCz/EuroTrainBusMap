/** Static data loading. All URLs are relative to Vite's BASE_URL. */
import type { AttributionFile, CalendarsFile, CityFile, CityShardFile, Manifest, NetworkFile, NetworkPart } from "@etbm/shared";
import { expandNetwork } from "@etbm/shared";

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
    fetchNetwork(url),
    getJson<CalendarsFile>(url("calendars.json")),
    getJson<AttributionFile>(url("attribution.json")).catch(() => ({ sources: [] }) as AttributionFile),
  ]);
  return { manifest, network, calendars, attribution, url };
}

/** network.json (+ continuation parts), expanded from its packed form. Also used by the map worker. */
export async function fetchNetwork(url: (p: string) => string): Promise<NetworkFile> {
  const network = await getJson<NetworkFile>(url("network.json"));
  // Large networks are split into parts (Cloudflare caps asset size); append in order.
  if (network.parts?.length) {
    const parts = await Promise.all(network.parts.map((p) => getJson<NetworkPart>(url(p))));
    for (const part of parts) {
      for (const s of part.stations ?? []) network.stations.push(s);
      for (const c of part.corridors ?? []) network.corridors.push(c);
    }
  }
  return expandNetwork(network);
}

const cityCache = new Map<number, Promise<CityFile>>();

const shardCache = new Map<number, Promise<CityShardFile>>();

/** CityFile of a city: from its shard (City.shard) or, without one, from city/<id>.json. */
export function loadCity(ds: DataSet, id: number): Promise<CityFile> {
  let p = cityCache.get(id);
  if (!p) {
    const shard = ds.network.cities[id]?.shard;
    if (shard === undefined) p = getJson<CityFile>(ds.url(`city/${id}.json`));
    else {
      let sp = shardCache.get(shard);
      if (!sp) {
        sp = getJson<CityShardFile>(ds.url(`shard/${shard}.json`));
        sp.catch(() => shardCache.delete(shard));
        shardCache.set(shard, sp);
      }
      p = sp.then((f) => {
        const cf = f.cities[String(id)];
        if (!cf) throw new Error(`city ${id} missing in shard ${shard}`);
        return cf;
      });
    }
    p.catch(() => cityCache.delete(id));
    cityCache.set(id, p);
  }
  return p;
}
