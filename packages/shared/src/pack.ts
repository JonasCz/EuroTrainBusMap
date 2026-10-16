/**
 * Compact columnar encoding of the network (NetworkFile.packed). The ETL
 * writes `packed` and leaves `cities`/`stations`/`corridors` empty; clients
 * call `unpackNetwork(file)` once after loading to get the usual objects.
 */
import type { CatBit, City, Corridor, NetworkFile, Segment, Station } from "./schema.ts";

export interface PackedNetwork {
  /** 1: corridors carry their own polylines; 2: geometry lives in `segments`. */
  v: 1 | 2;
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
    /** City.shard, −1 when undefined. */
    shard?: number[];
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
    /** Trips per day × 10 (integers) for Cat bits 1, 2, 4, 8. */
    tpd: [number[], number[], number[], number[]];
    snapped: number[];
    /** Index of the station within city a's / b's station list, or −1. */
    sa: number[];
    sb: number[];
    /** Google encoded polyline (precision 5) from a to b; v2: only for corridors without segments (segN 0), in order. */
    poly: string[];
    /**
     * v2: number of segments per corridor, and their codes concatenated: code = 2·id (+1 when
     * reversed), stored zigzag delta-encoded against the previous code (across corridors).
     */
    segN?: number[];
    segs?: number[];
  };
  /**
   * v2: line-graph segment geometry. Chained polylines: each starts relative to the previous
   * segment's last point. Segment cats/tpd/snapped are not stored: they are the
   * aggregate of the corridors listing the segment (computed by unpackNetwork).
   */
  segments?: { poly: string[] };
}

const CATS: CatBit[] = [1, 2, 4, 8];

// ---------------------------------------------------------------- polyline
/**
 * Google polyline (precision 5). `ref` (optional, mutated) carries the previous
 * point across calls, so consecutive polylines can be chained (first point
 * stored relative to the previous polyline's last point).
 */
export function encodePolyline(coords: [number, number][], ref?: { lat: number; lon: number }): string {
  let out = "";
  let plat = ref?.lat ?? 0, plon = ref?.lon ?? 0;
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
  if (ref) {
    ref.lat = plat;
    ref.lon = plon;
  }
  return out;
}

export function decodePolyline(s: string, ref?: { lat: number; lon: number }): [number, number][] {
  const out: [number, number][] = [];
  let i = 0, lat = ref ? Math.round(ref.lat) : 0, lon = ref ? Math.round(ref.lon) : 0;
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
  if (ref) {
    ref.lat = lat;
    ref.lon = lon;
  }
  return out;
}

// ---------------------------------------------------------------- pack / unpack
const i5 = (x: number) => Math.round(x * 1e5);

/** Columnar cities (see PackedNetwork.cities). `nStationsTotal` checks that stations are ordered by city. */
export function packCities(list: City[], nStationsTotal?: number, opts: { prec?: number; population?: boolean } = {}): { countries: string[]; cities: PackedNetwork["cities"] } {
  const f = 10 ** (opts.prec ?? 5);
  const countries: string[] = [];
  const cIdx = new Map<string, number>();
  const cities: PackedNetwork["cities"] = { name: [], country: [], lon: [], lat: [], population: [], importance: [], cats: [], tz: [], nStations: [], shard: [] };
  let plon = 0, plat = 0, nextStation = 0;
  for (const c of list) {
    let ci = cIdx.get(c.country);
    if (ci === undefined) {
      ci = countries.length;
      countries.push(c.country);
      cIdx.set(c.country, ci);
    }
    const lon = Math.round(c.lon * f), lat = Math.round(c.lat * f);
    cities.name.push(c.name);
    cities.country.push(ci);
    cities.lon.push(lon - plon);
    cities.lat.push(lat - plat);
    plon = lon;
    plat = lat;
    if (opts.population !== false) cities.population.push(c.population);
    cities.importance.push(Math.round(c.importance * 1000));
    cities.cats.push(c.cats);
    cities.tz.push(c.tz);
    cities.nStations.push(c.stations.length);
    cities.shard!.push(c.shard ?? -1);
    c.stations.forEach((s, k) => {
      if (s !== nextStation + k) throw new Error(`packNetwork: stations must be ordered by city (city ${c.id})`);
    });
    nextStation += c.stations.length;
  }
  if (nStationsTotal !== undefined && nextStation !== nStationsTotal) throw new Error("packNetwork: every station must belong to a city");
  return { countries, cities };
}

/** Columnar stations relative to their city (see PackedNetwork.stations). */
export function packStations(cities: City[], stations: Station[]): PackedNetwork["stations"] {
  const out: PackedNetwork["stations"] = { name: [], dlon: [], dlat: [], cats: [], tpd: [] };
  for (const s of stations) {
    const c = cities[s.city]!;
    let name = s.name.replace(/^~+/, "");
    if (name.length > c.name.length && name.startsWith(c.name)) name = "~" + name.slice(c.name.length);
    out.name.push(name);
    out.dlon.push(i5(s.lon) - i5(c.lon));
    out.dlat.push(i5(s.lat) - i5(c.lat));
    out.cats.push(s.cats);
    out.tpd!.push(Math.round((s.tpd ?? 0) * 10));
  }
  return out;
}

export function unpackCities(countries: string[], pc: PackedNetwork["cities"], prec = 5): City[] {
  const f = 10 ** prec;
  const cities: City[] = [];
  let lon = 0, lat = 0, sid = 0;
  for (let i = 0; i < pc.name.length; i++) {
    lon += pc.lon[i]!;
    lat += pc.lat[i]!;
    const ids: number[] = [];
    for (let k = 0; k < pc.nStations[i]!; k++) ids.push(sid++);
    cities.push({
      id: i,
      name: pc.name[i]!,
      country: countries[pc.country[i]!]!,
      lon: lon / f,
      lat: lat / f,
      population: pc.population[i] ?? 0,
      importance: pc.importance[i]! / 1000,
      cats: pc.cats[i]!,
      stations: ids,
      tz: pc.tz[i]!,
      ...(pc.shard && pc.shard[i]! >= 0 ? { shard: pc.shard[i]! } : {}),
    });
  }
  return cities;
}

export function unpackStations(cities: City[], ps: PackedNetwork["stations"]): Station[] {
  const stations: Station[] = [];
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
  return stations;
}

export function packNetwork(n: Pick<NetworkFile, "cities" | "stations" | "corridors" | "segments">): PackedNetwork {
  const { countries, cities } = packCities(n.cities, n.stations.length);
  const p: PackedNetwork = {
    v: 1,
    countries,
    cities,
    stations: packStations(n.cities, n.stations),
    corridors: { a: [], db: [], cats: [], tpd: [[], [], [], []], snapped: [], sa: [], sb: [], poly: [] },
  };
  let pa = 0, prevCode = 0;
  const first = (city: number) => n.cities[city]!.stations[0] ?? 0;
  for (const co of n.corridors) {
    p.corridors.a.push(co.a - pa);
    pa = co.a;
    p.corridors.db.push(co.b - co.a);
    p.corridors.cats.push(co.cats);
    CATS.forEach((cat, k) => p.corridors.tpd[k]!.push(Math.round((co.tpd[cat] ?? 0) * 10)));
    p.corridors.snapped.push(co.snapped ? 1 : 0);
    p.corridors.sa.push(co.sa != null ? co.sa - first(co.a) : -1);
    p.corridors.sb.push(co.sb != null ? co.sb - first(co.b) : -1);
    if (n.segments && co.segs) {
      (p.corridors.segN ??= []).push(co.segs.length);
      for (const c of co.segs) {
        const code = c >= 0 ? 2 * c : 2 * (-c - 1) + 1;
        const d = code - prevCode;
        (p.corridors.segs ??= []).push(d >= 0 ? 2 * d : -2 * d - 1);
        prevCode = code;
      }
    } else {
      p.corridors.poly.push(encodePolyline(co.coords));
      if (n.segments) (p.corridors.segN ??= []).push(0);
    }
  }
  if (n.segments) {
    p.v = 2;
    const ps: NonNullable<PackedNetwork["segments"]> = { poly: [] };
    const ref = { lat: 0, lon: 0 };
    n.segments.forEach((sg, i) => {
      if (sg.id !== i) throw new Error("packNetwork: segment ids must be dense");
      ps.poly.push(encodePolyline(sg.coords, ref));
    });
    p.segments = ps;
  }
  return p;
}

/** Concatenate segment polylines along a signed segment list (−(id+1) = reversed). */
export function segmentPath(segs: number[], segments: { coords: [number, number][] }[]): [number, number][] {
  const out: [number, number][] = [];
  for (const code of segs) {
    const s = segments[code >= 0 ? code : -code - 1];
    if (!s) continue;
    const co = s.coords;
    const n = co.length;
    for (let i = 0; i < n; i++) {
      const pt = co[code >= 0 ? i : n - 1 - i]!;
      const q = out[out.length - 1];
      if (!q || q[0] !== pt[0] || q[1] !== pt[1]) out.push(pt);
    }
  }
  return out;
}

export function unpackNetwork(p: PackedNetwork): { cities: City[]; stations: Station[]; corridors: Corridor[]; segments?: Segment[] } {
  const cities = unpackCities(p.countries, p.cities);
  const stations = unpackStations(cities, p.stations);
  let segments: Segment[] | undefined;
  if (p.segments) {
    const ref = { lat: 0, lon: 0 };
    segments = p.segments.poly.map((poly, i) => ({ id: i, coords: decodePolyline(poly, ref), cats: 0, tpd: {}, snapped: false }));
  }
  const pk = p.corridors;
  const corridors: Corridor[] = [];
  let segPos = 0, prevCode = 0, polyPos = 0;
  let a = 0;
  for (let i = 0; i < pk.a.length; i++) {
    a += pk.a[i]!;
    const b = a + pk.db[i]!;
    const tpd: Corridor["tpd"] = {};
    CATS.forEach((cat, k) => {
      const v = pk.tpd[k]![i]!;
      if (v) tpd[cat] = v / 10;
    });
    let segs: number[] | undefined;
    const ns = pk.segN?.[i] ?? 0;
    if (segments && ns > 0) {
      segs = [];
      for (let k = 0; k < ns; k++) {
        const z = pk.segs![segPos++]!;
        prevCode += z & 1 ? -(z + 1) / 2 : z / 2;
        segs.push(prevCode & 1 ? -((prevCode - 1) / 2) - 1 : prevCode / 2);
      }
    }
    const co: Corridor = {
      id: i,
      a,
      b,
      coords: segs ? segmentPath(segs, segments!) : decodePolyline(pk.poly[pk.segN ? polyPos++ : i]!),
      cats: pk.cats[i]!,
      tpd,
      snapped: pk.snapped[i] === 1,
    };
    if (pk.sa[i]! >= 0) co.sa = cities[a]!.stations[0]! + pk.sa[i]!;
    if (pk.sb[i]! >= 0) co.sb = cities[b]!.stations[0]! + pk.sb[i]!;
    if (segs) co.segs = segs;
    corridors.push(co);
  }
  if (segments) aggregateSegments(corridors, segments);
  return segments ? { cities, stations, corridors, segments } : { cities, stations, corridors };
}

/** Fill cities/stations/corridors of a loaded NetworkFile from `packed` (no-op if not packed). */
export function expandNetwork(n: NetworkFile): NetworkFile {
  if (!n.packed) return n;
  const u = unpackNetwork(n.packed);
  n.cities = u.cities;
  n.stations = u.stations;
  n.corridors = u.corridors;
  if (u.segments) n.segments = u.segments;
  delete n.packed;
  return n;
}

/**
 * Segment attributes from the corridors using them: union of cats, any snapped,
 * sum of trips per day per category (rounded to 0.1).
 */
export function aggregateSegments(corridors: Corridor[], segments: Segment[]): void {
  for (const s of segments) {
    s.cats = 0;
    s.tpd = {};
    s.snapped = false;
  }
  for (const c of corridors) {
    if (!c.segs) continue;
    const seen = new Set<number>();
    for (const code of c.segs) {
      const id = code >= 0 ? code : -code - 1;
      if (seen.has(id)) continue;
      seen.add(id);
      const s = segments[id];
      if (!s) continue;
      s.cats |= c.cats;
      if (c.snapped) s.snapped = true;
      for (const cat of CATS) {
        const v = c.tpd[cat];
        if (v) s.tpd[cat] = (s.tpd[cat] ?? 0) + v;
      }
    }
  }
  for (const s of segments) for (const cat of CATS) if (s.tpd[cat] !== undefined) s.tpd[cat] = Math.round(s.tpd[cat]! * 10) / 10;
}
