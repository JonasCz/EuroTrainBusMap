/**
 * Compact columnar encoding of the network (NetworkFile.packed). The ETL
 * writes `packed` and leaves `cities`/`stations`/`corridors` empty; clients
 * call `unpackNetwork(file)` once after loading to get the usual objects.
 */
import type { CatBit, City, Corridor, NetworkFile, Station } from "./schema.ts";

export interface PackedNetwork {
  v: 1;
  /** Country codes referenced by cities.country. */
  countries: string[];
  cities: {
    name: string[];
    country: number[];
    /** Delta-encoded integers in 1e-5 degrees (first value absolute). */
    lon: number[];
    lat: number[];
    population: number[];
    /** importance × 1000 */
    importance: number[];
    cats: number[];
    tz: number[];
    /** Stations are ordered by city: city i owns the next nStations[i] station ids. */
    nStations: number[];
  };
  stations: {
    /** A leading "~" stands for the city name ("~ Hbf" in Berlin → "Berlin Hbf"). */
    name: string[];
    /** Offset from the city point, integers in 1e-5 degrees. */
    dlon: number[];
    dlat: number[];
    cats: number[];
    /** Departures per day × 10 (Station.tpd), 0 when absent. */
    tpd?: number[];
  };
  corridors: {
    /** Delta-encoded city a (corridors are sorted by a). */
    a: number[];
    /** b − a */
    db: number[];
    cats: number[];
    /** 0 when absent */
    dtCats: number[];
    /** Trips per day × 10 (integers) for Cat bits 1, 2, 4, 8. */
    tpd: [number[], number[], number[], number[]];
    snapped: number[];
    /** Index of the station within city a's / b's station list, or −1. */
    sa: number[];
    sb: number[];
    /** Google encoded polyline (precision 5) from a to b. */
    poly: string[];
  };
}

const CATS: CatBit[] = [1, 2, 4, 8];

// ---------------------------------------------------------------- polyline
export function encodePolyline(coords: [number, number][]): string {
  let out = "";
  let plat = 0, plon = 0;
  const enc = (v: number) => {
    let x = v < 0 ? ~(v << 1) : v << 1;
    while (x >= 0x20) {
      out += String.fromCharCode((0x20 | (x & 0x1f)) + 63);
      x >>= 5;
    }
    out += String.fromCharCode(x + 63);
  };
  for (const [lon, lat] of coords) {
    const ilat = Math.round(lat * 1e5), ilon = Math.round(lon * 1e5);
    enc(ilat - plat);
    enc(ilon - plon);
    plat = ilat;
    plon = ilon;
  }
  return out;
}

export function decodePolyline(s: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0, lat = 0, lon = 0;
  const dec = () => {
    let shift = 0, res = 0, b: number;
    do {
      b = s.charCodeAt(i++) - 63;
      res |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return res & 1 ? ~(res >> 1) : res >> 1;
  };
  while (i < s.length) {
    lat += dec();
    lon += dec();
    out.push([lon / 1e5, lat / 1e5]);
  }
  return out;
}

// ---------------------------------------------------------------- pack / unpack
const i5 = (x: number) => Math.round(x * 1e5);

export function packNetwork(n: Pick<NetworkFile, "cities" | "stations" | "corridors">): PackedNetwork {
  const countries: string[] = [];
  const cIdx = new Map<string, number>();
  const p: PackedNetwork = {
    v: 1,
    countries,
    cities: { name: [], country: [], lon: [], lat: [], population: [], importance: [], cats: [], tz: [], nStations: [] },
    stations: { name: [], dlon: [], dlat: [], cats: [] },
    corridors: { a: [], db: [], cats: [], dtCats: [], tpd: [[], [], [], []], snapped: [], sa: [], sb: [], poly: [] },
  };
  let plon = 0, plat = 0, nextStation = 0;
  for (const c of n.cities) {
    let ci = cIdx.get(c.country);
    if (ci === undefined) {
      ci = countries.length;
      countries.push(c.country);
      cIdx.set(c.country, ci);
    }
    const lon = i5(c.lon), lat = i5(c.lat);
    p.cities.name.push(c.name);
    p.cities.country.push(ci);
    p.cities.lon.push(lon - plon);
    p.cities.lat.push(lat - plat);
    plon = lon;
    plat = lat;
    p.cities.population.push(c.population);
    p.cities.importance.push(Math.round(c.importance * 1000));
    p.cities.cats.push(c.cats);
    p.cities.tz.push(c.tz);
    p.cities.nStations.push(c.stations.length);
    c.stations.forEach((s, k) => {
      if (s !== nextStation + k) throw new Error(`packNetwork: stations must be ordered by city (city ${c.id})`);
    });
    nextStation += c.stations.length;
  }
  if (nextStation !== n.stations.length) throw new Error("packNetwork: every station must belong to a city");
  for (const s of n.stations) {
    const c = n.cities[s.city]!;
    let name = s.name.replace(/^~+/, "");
    if (name.length > c.name.length && name.startsWith(c.name)) name = "~" + name.slice(c.name.length);
    p.stations.name.push(name);
    p.stations.dlon.push(i5(s.lon) - i5(c.lon));
    p.stations.dlat.push(i5(s.lat) - i5(c.lat));
    p.stations.cats.push(s.cats);
    (p.stations.tpd ??= []).push(Math.round((s.tpd ?? 0) * 10));
  }
  let pa = 0;
  const first = (city: number) => n.cities[city]!.stations[0] ?? 0;
  for (const co of n.corridors) {
    p.corridors.a.push(co.a - pa);
    pa = co.a;
    p.corridors.db.push(co.b - co.a);
    p.corridors.cats.push(co.cats);
    p.corridors.dtCats.push(co.dtCats ?? 0);
    CATS.forEach((cat, k) => p.corridors.tpd[k]!.push(Math.round((co.tpd[cat] ?? 0) * 10)));
    p.corridors.snapped.push(co.snapped ? 1 : 0);
    p.corridors.sa.push(co.sa != null ? co.sa - first(co.a) : -1);
    p.corridors.sb.push(co.sb != null ? co.sb - first(co.b) : -1);
    p.corridors.poly.push(encodePolyline(co.coords));
  }
  return p;
}

export function unpackNetwork(p: PackedNetwork): { cities: City[]; stations: Station[]; corridors: Corridor[] } {
  const cities: City[] = [];
  const stations: Station[] = [];
  let lon = 0, lat = 0, sid = 0;
  const pc = p.cities;
  for (let i = 0; i < pc.name.length; i++) {
    lon += pc.lon[i]!;
    lat += pc.lat[i]!;
    const ids: number[] = [];
    for (let k = 0; k < pc.nStations[i]!; k++) ids.push(sid++);
    cities.push({
      id: i,
      name: pc.name[i]!,
      country: p.countries[pc.country[i]!]!,
      lon: lon / 1e5,
      lat: lat / 1e5,
      population: pc.population[i]!,
      importance: pc.importance[i]! / 1000,
      cats: pc.cats[i]!,
      stations: ids,
      tz: pc.tz[i]!,
    });
  }
  const ps = p.stations;
  let ci = 0, left = cities.length ? cities[0]!.stations.length : 0;
  for (let s = 0; s < ps.name.length; s++) {
    while (left === 0 && ci + 1 < cities.length) left = cities[++ci]!.stations.length;
    left--;
    const c = cities[ci]!;
    const nm = ps.name[s]!;
    stations.push({
      id: s,
      city: ci,
      name: nm.startsWith("~") ? c.name + nm.slice(1) : nm,
      lon: (Math.round(c.lon * 1e5) + ps.dlon[s]!) / 1e5,
      lat: (Math.round(c.lat * 1e5) + ps.dlat[s]!) / 1e5,
      cats: ps.cats[s]!,
      ...(ps.tpd && ps.tpd[s] ? { tpd: ps.tpd[s]! / 10 } : {}),
    });
  }
  const pk = p.corridors;
  const corridors: Corridor[] = [];
  let a = 0;
  for (let i = 0; i < pk.a.length; i++) {
    a += pk.a[i]!;
    const b = a + pk.db[i]!;
    const tpd: Corridor["tpd"] = {};
    CATS.forEach((cat, k) => {
      const v = pk.tpd[k]![i]!;
      if (v) tpd[cat] = v / 10;
    });
    const co: Corridor = {
      id: i,
      a,
      b,
      coords: decodePolyline(pk.poly[i]!),
      cats: pk.cats[i]!,
      tpd,
      snapped: pk.snapped[i] === 1,
    };
    if (pk.dtCats[i]) co.dtCats = pk.dtCats[i];
    if (pk.sa[i]! >= 0) co.sa = cities[a]!.stations[0]! + pk.sa[i]!;
    if (pk.sb[i]! >= 0) co.sb = cities[b]!.stations[0]! + pk.sb[i]!;
    corridors.push(co);
  }
  return { cities, stations, corridors };
}

/** Fill cities/stations/corridors of a loaded NetworkFile from `packed` (no-op if not packed). */
export function expandNetwork(n: NetworkFile): NetworkFile {
  if (!n.packed) return n;
  const u = unpackNetwork(n.packed);
  n.cities = u.cities;
  n.stations = u.stations;
  n.corridors = u.corridors;
  delete n.packed;
  return n;
}
