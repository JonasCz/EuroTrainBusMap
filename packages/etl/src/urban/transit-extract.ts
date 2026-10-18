/**
 * Timetables of the rail-bound local transport (metro, tram, light rail, suburban rail, funiculars) of one
 * GTFS feed for one reference week, for the transit transfer profiles (see transit.ts). Unlike the display
 * layer (extract.ts: shapes and trips per day only) this keeps every trip: stop sequence, times and the days
 * of the reference week it runs on. City buses are left out (see transit.ts for why).
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "../db.ts";
import { c, columns, csv, extract, listZip } from "../gtfs/load.ts";
import { warn } from "../util/log.ts";
import { BBOX } from "../geonames.ts";
import { NOT_LOCAL_RE, urbanModeOf, type DiscIndex } from "./classify.ts";
import { TransitMode } from "@etbm/shared";
import { UMode } from "./types.ts";

/** Bump when the extraction changes (invalidates the cached transit timetables). */
export const TRANSIT_EXTRACT_VERSION = 4;
/** Days of the reference week: Monday … the following Monday (bit i of a trip mask = day i). */
export const WEEK_DAYS = 8;

export interface TransitPatternRaw {
  /** TransitMode bit of the route (tram, metro, rail) */
  mode: number;
  /** indices into TransitFeed.stops */
  stops: number[];
  /** minutes from the trip start: arrival (rounded up) and departure (rounded down) per stop */
  arr: number[];
  dep: number[];
  /** flat [start minute (service day), day mask] pairs */
  trips: number[];
}

export interface TransitFeed {
  key: string;
  version: number;
  /** [lon, lat] (1e-5 degrees) */
  stops: [number, number][];
  patterns: TransitPatternRaw[];
  stats: { routes: number; trips: number; freqTrips: number };
}

export interface TransitExtractOptions {
  /** Monday of the reference week (YYYY-MM-DD) */
  monday: string;
  /** feed of a city's transport authority (urban-feeds.json): its regional / suburban rail counts too */
  local: boolean;
  /** discs of the cities: trips need two stops inside one */
  cityIdx: DiscIndex;
  tmpDir: string;
}

/**
 * Whether a route of this (extended) GTFS type takes part: trams, metros, light rail, cable cars and funiculars
 * of every feed, suburban rail (109: S-Bahn, Elizabeth line, London Overground), and the heavy rail of a local
 * authority's feed (RER / Transilien in Île-de-France, regional trains in the VBB feed); never buses or coaches.
 */
export function transitRouteType(t: number, local: boolean): boolean {
  return transitModeOf(t, local) !== 0;
}

/** TransitMode bit of an (extended) GTFS route type, 0 when the route does not take part (see transitRouteType). */
export function transitModeOf(t: number, local: boolean): number {
  const m = urbanModeOf(t);
  if (m === UMode.Metro) return TransitMode.Metro;
  if (m === UMode.Tram || m === UMode.Cable) return TransitMode.Tram;
  if (t === 109 || (local && (t === 2 || (t >= 100 && t <= 108)))) return TransitMode.Rail;
  return 0;
}

const round5 = (x: number) => Math.round(x * 1e5) / 1e5;

function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** GTFS time "H:MM:SS" → seconds, or null. */
export function gtfsSeconds(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^\s*(\d+):(\d\d)(?::(\d\d))?\s*$/.exec(s);
  if (!m) return null;
  return +m[1]! * 3600 + +m[2]! * 60 + (m[3] ? +m[3] : 0);
}

/**
 * Times of one trip in minutes: departures rounded down, arrivals rounded up (a conservative ride), stops without
 * times interpolated linearly between their neighbours; null when the first or last stop has no time.
 */
export function tripMinutes(arrS: (number | null)[], depS: (number | null)[]): { arr: number[]; dep: number[] } | null {
  const n = arrS.length;
  const a = arrS.map((x, i) => x ?? depS[i] ?? null);
  const d = depS.map((x, i) => x ?? arrS[i] ?? null);
  if (a[0] == null || d[n - 1] == null) return null;
  // interpolate missing stops
  let last = 0;
  for (let i = 1; i < n; i++) {
    if (a[i] == null) continue;
    for (let k = last + 1; k < i; k++) {
      const v = d[last]! + ((a[i]! - d[last]!) * (k - last)) / (i - last);
      a[k] = v;
      d[k] = v;
    }
    last = i;
  }
  const arr: number[] = [], dep: number[] = [];
  for (let i = 0; i < n; i++) {
    // a stop's departure may round to before its arrival: a change there uses the arrival, boarding the departure
    const ai = Math.ceil(a[i]! / 60), di = Math.floor(d[i]! / 60);
    if (i && ai < dep[i - 1]!) return null; // times going backwards: broken trip
    arr.push(ai);
    dep.push(di);
  }
  return { arr, dep };
}

/** Day masks (bit i = Monday + i) of the services of a feed's calendar files. */
async function serviceMasks(db: Db, zip: string, find: (n: string) => string | undefined, dir: string, monday: string): Promise<Map<string, number>> {
  const days = Array.from({ length: WEEK_DAYS }, (_, i) => addDays(monday, i));
  const ymd = days.map((d) => d.replace(/-/g, ""));
  const masks = new Map<string, number>();
  const cal = find("calendar.txt");
  if (cal) {
    const p = extract(zip, cal, dir);
    const cc = await columns(db, p);
    const dow = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
    const rows = await db.all<Record<string, string | null>>(
      `SELECT ${c(cc, "service_id")} AS sid, ${c(cc, "start_date")} AS s, ${c(cc, "end_date")} AS e, ${dow.map((d) => `${c(cc, d)} AS ${d}`).join(", ")} FROM ${csv(p)}`,
    );
    for (const r of rows) {
      if (!r.sid || !r.s || !r.e) continue;
      let m = 0;
      for (let i = 0; i < WEEK_DAYS; i++) if (ymd[i]! >= r.s && ymd[i]! <= r.e && r[dow[i % 7]!] === "1") m |= 1 << i;
      masks.set(r.sid, m);
    }
  }
  const cd = find("calendar_dates.txt");
  if (cd) {
    const p = extract(zip, cd, dir);
    const dc = await columns(db, p);
    const rows = await db.all<{ sid: string; d: string; t: string }>(
      `SELECT ${c(dc, "service_id")} AS sid, ${c(dc, "date")} AS d, ${c(dc, "exception_type")} AS t FROM ${csv(p)}
       WHERE ${c(dc, "date")} IN (${ymd.map((x) => `'${x}'`).join(", ")})`,
    );
    for (const r of rows) {
      const i = ymd.indexOf(r.d);
      if (i < 0 || !r.sid) continue;
      const m = masks.get(r.sid) ?? 0;
      masks.set(r.sid, r.t === "1" ? m | (1 << i) : r.t === "2" ? m & ~(1 << i) : m);
    }
  }
  return masks;
}

/** Last date (YYYY-MM-DD) with service in a feed's calendar files, or null. */
async function lastServiceDate(db: Db, zip: string, find: (n: string) => string | undefined, dir: string): Promise<string | null> {
  let last = "";
  const cal = find("calendar.txt");
  if (cal) {
    const p = extract(zip, cal, dir);
    const cc = await columns(db, p);
    const r = await db.all<{ m: string | null }>(`SELECT max(${c(cc, "end_date")}) AS m FROM ${csv(p)}`);
    if (r[0]?.m && r[0].m > last) last = r[0].m;
  }
  const cd = find("calendar_dates.txt");
  if (cd) {
    const p = extract(zip, cd, dir);
    const dc = await columns(db, p);
    const r = await db.all<{ m: string | null }>(`SELECT max(${c(dc, "date")}) AS m FROM ${csv(p)} WHERE ${c(dc, "exception_type")} = '1'`);
    if (r[0]?.m && r[0].m > last) last = r[0].m;
  }
  return /^\d{8}$/.test(last) ? `${last.slice(0, 4)}-${last.slice(4, 6)}-${last.slice(6, 8)}` : null;
}

/** Extract the transit timetable of one feed for the reference week, or null when it has no such lines. */
export async function extractTransitFeed(db: Db, key: string, zip: string, opt: TransitExtractOptions): Promise<TransitFeed | null> {
  const dir = join(opt.tmpDir, `transit-${key.replace(/[^\w.-]/g, "_")}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  try {
    const entries = listZip(zip);
    const find = (name: string) => entries.find((e) => e.split("/").pop()!.toLowerCase() === name && !e.startsWith("__MACOSX"));
    if (["routes.txt", "trips.txt", "stop_times.txt", "stops.txt"].some((n) => !find(n))) return null;
    const rPath = extract(zip, find("routes.txt")!, dir);
    const rc = await columns(db, rPath);
    const routes = await db.all<{ id: string; t: number | null; names: string }>(
      `SELECT ${c(rc, "route_id")} AS id, try_cast(${c(rc, "route_type")} AS INTEGER) AS t,
         concat_ws(' ', ${c(rc, "route_short_name")}, ${c(rc, "route_long_name")}, ${c(rc, "route_desc")}) AS names
       FROM ${csv(rPath)} WHERE ${c(rc, "route_id")} IS NOT NULL`,
    );
    const keep = routes.filter((r) => r.t != null && transitRouteType(r.t, opt.local) && !NOT_LOCAL_RE.test(r.names ?? "")).map((r) => [r.id, transitModeOf(r.t!, opt.local)]);
    if (!keep.length) return null;
    await db.run(`DROP TABLE IF EXISTS x_keep; CREATE TEMP TABLE x_keep(route_id VARCHAR, mode INTEGER)`);
    await db.insertRows("x_keep", [{ name: "route_id", type: "VARCHAR" }, { name: "mode", type: "INTEGER" }], keep, join(dir, "keep.csv"));
    // a feed whose calendar ends before the end of the reference week (an expired one, or one published for the
    // next two weeks only) is read for its last whole week: a missing day would count as a day without service
    let monday = opt.monday;
    const last = await lastServiceDate(db, zip, find, dir);
    if (last && last < addDays(monday, WEEK_DAYS - 1)) {
      const d = new Date(addDays(last, -(WEEK_DAYS - 1)) + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // the Monday on or before
      monday = d.toISOString().slice(0, 10);
    }
    const masks = await serviceMasks(db, zip, find, dir, monday);
    const active = [...masks].filter(([, m]) => m !== 0);
    if (!active.length) return null;
    await db.run(`DROP TABLE IF EXISTS x_mask; CREATE TEMP TABLE x_mask(service_id VARCHAR, mask INTEGER)`);
    await db.insertRows("x_mask", [{ name: "service_id", type: "VARCHAR" }, { name: "mask", type: "INTEGER" }], active, join(dir, "mask.csv"));
    const tPath = extract(zip, find("trips.txt")!, dir);
    const tc = await columns(db, tPath);
    await db.run(`DROP TABLE IF EXISTS x_trips; CREATE TEMP TABLE x_trips AS
      SELECT ${c(tc, "trip_id", "NULL::VARCHAR", "t")} AS trip_id, m.mask, k.mode FROM ${csv(tPath)} t
      JOIN x_mask m ON m.service_id = ${c(tc, "service_id", "NULL::VARCHAR", "t")}
      JOIN x_keep k ON k.route_id = ${c(tc, "route_id", "NULL::VARCHAR", "t")}
      WHERE ${c(tc, "trip_id", "NULL::VARCHAR", "t")} IS NOT NULL`);
    await rm(tPath, { force: true });
    // a trip listed twice (duplicate rows) is one trip
    await db.run(`CREATE OR REPLACE TEMP TABLE x_trips AS SELECT trip_id, bit_or(mask) AS mask, max(mode) AS mode FROM x_trips GROUP BY trip_id`);
    if (!(await db.scalar(`SELECT count(*) FROM x_trips`))) return null;
    const sPath = extract(zip, find("stop_times.txt")!, dir);
    const sc = await columns(db, sPath);
    await db.run(`DROP TABLE IF EXISTS x_st; CREATE TEMP TABLE x_st AS
      SELECT ${c(sc, "trip_id", "NULL::VARCHAR", "st")} AS trip_id, try_cast(${c(sc, "stop_sequence", "NULL::VARCHAR", "st")} AS INTEGER) AS seq,
        ${c(sc, "stop_id", "NULL::VARCHAR", "st")} AS stop_id, ${c(sc, "arrival_time", "NULL::VARCHAR", "st")} AS a, ${c(sc, "departure_time", "NULL::VARCHAR", "st")} AS d
      FROM ${csv(sPath)} st WHERE ${c(sc, "trip_id", "NULL::VARCHAR", "st")} IN (SELECT trip_id FROM x_trips)`);
    await rm(sPath, { force: true });
    const spPath = extract(zip, find("stops.txt")!, dir);
    const sp = await columns(db, spPath);
    const stopRows = await db.all<{ id: string; lat: number | null; lon: number | null }>(
      `SELECT ${c(sp, "stop_id")} AS id, try_cast(${c(sp, "stop_lat")} AS DOUBLE) AS lat, try_cast(${c(sp, "stop_lon")} AS DOUBLE) AS lon
       FROM ${csv(spPath)} WHERE ${c(sp, "stop_id")} IN (SELECT DISTINCT stop_id FROM x_st)`,
    );
    const stopPos = new Map<string, [number, number]>();
    for (const s of stopRows) {
      if (s.lat == null || s.lon == null || s.lat < BBOX.minLat || s.lat > BBOX.maxLat || s.lon < BBOX.minLon || s.lon > BBOX.maxLon) continue;
      stopPos.set(s.id, [round5(s.lon), round5(s.lat)]);
    }
    // frequency-based trips: one trip per headway from start to end
    const freq = new Map<string, [number, number, number][]>();
    const fEntry = find("frequencies.txt");
    if (fEntry) {
      const fp = extract(zip, fEntry, dir);
      const fc = await columns(db, fp);
      for (const r of await db.all<{ id: string; s: string; e: string; h: number | null }>(
        `SELECT ${c(fc, "trip_id")} AS id, ${c(fc, "start_time")} AS s, ${c(fc, "end_time")} AS e, try_cast(${c(fc, "headway_secs")} AS INTEGER) AS h FROM ${csv(fp)}
         WHERE ${c(fc, "trip_id")} IN (SELECT trip_id FROM x_trips)`,
      )) {
        const s = gtfsSeconds(r.s), e = gtfsSeconds(r.e);
        if (s == null || e == null || !r.h || r.h <= 0) continue;
        let a = freq.get(r.id);
        if (!a) freq.set(r.id, (a = []));
        a.push([s, e, r.h]);
      }
    }
    const stopIdx = new Map<string, number>();
    const stops: [number, number][] = [];
    const pats = new Map<string, TransitPatternRaw>();
    let nTrips = 0, freqTrips = 0;
    const addTrip = (tid: string, mask: number, mode: number, sids: string[], as: (number | null)[], ds: (number | null)[]) => {
      // drop stops without coordinates
      const keepIx: number[] = [];
      for (let i = 0; i < sids.length; i++) if (stopPos.has(sids[i]!)) keepIx.push(i);
      if (keepIx.length < 2) return;
      let inside = 0;
      for (const i of keepIx) {
        const [lon, lat] = stopPos.get(sids[i]!)!;
        if (opt.cityIdx.contains(lon, lat) && ++inside >= 2) break;
      }
      if (inside < 2) return;
      const tm = tripMinutes(keepIx.map((i) => as[i]!), keepIx.map((i) => ds[i]!));
      if (!tm) return;
      const start = tm.dep[0]!;
      const sIx = keepIx.map((i) => {
        const id = sids[i]!;
        let k = stopIdx.get(id);
        if (k === undefined) {
          stopIdx.set(id, (k = stops.length));
          stops.push(stopPos.get(id)!);
        }
        return k;
      });
      const arr = tm.arr.map((x) => x - start), dep = tm.dep.map((x) => x - start);
      const key = `${mode}|${sIx.join(",")}|${arr.join(",")}|${dep.join(",")}`;
      let p = pats.get(key);
      if (!p) pats.set(key, (p = { mode, stops: sIx, arr, dep, trips: [] }));
      const fr = freq.get(tid);
      if (fr) {
        for (const [s, e, h] of fr)
          for (let t = s; t < e; t += h) {
            // the template's first departure is shifted to each start
            p.trips.push(Math.floor(t / 60), mask);
            freqTrips++;
          }
      } else p.trips.push(start, mask);
      nTrips++;
    };
    // rows sorted by trip and sequence, assembled into trips here (a list aggregate runs out of memory on big feeds)
    let curId = "", curMask = 0, curMode = 0;
    let cs: string[] = [], ca: (number | null)[] = [], cd: (number | null)[] = [];
    const sec = (col: string) =>
      `try_cast(split_part(trim(${col}), ':', 1) AS INTEGER) * 3600 + try_cast(split_part(trim(${col}), ':', 2) AS INTEGER) * 60 + coalesce(try_cast(split_part(trim(${col}), ':', 3) AS INTEGER), 0)`;
    await db.stream(
      `SELECT st.trip_id, t.mask, st.stop_id, ${sec("st.a")} AS a, ${sec("st.d")} AS d, t.mode
       FROM x_st st JOIN x_trips t USING (trip_id) WHERE st.stop_id IS NOT NULL ORDER BY st.trip_id, st.seq`,
      (cols, n) => {
        for (let r = 0; r < n; r++) {
          const tid = cols[0]![r] as string;
          if (tid !== curId) {
            if (cs.length) addTrip(curId, curMask, curMode, cs, ca, cd);
            curId = tid;
            curMask = cols[1]![r] as number;
            curMode = cols[5]![r] as number;
            cs = []; ca = []; cd = [];
          }
          cs.push(cols[2]![r] as string);
          ca.push((cols[3]![r] as number | null) ?? null);
          cd.push((cols[4]![r] as number | null) ?? null);
        }
      },
    );
    if (cs.length) addTrip(curId, curMask, curMode, cs, ca, cd);
    if (!pats.size) return null;
    return { key, version: TRANSIT_EXTRACT_VERSION, stops, patterns: [...pats.values()], stats: { routes: keep.length, trips: nTrips, freqTrips } };
  } catch (e) {
    warn(`transit ${key}: ${(e as Error).message.slice(0, 300)}`);
    return null;
  } finally {
    await db.run(`DROP TABLE IF EXISTS x_st; DROP TABLE IF EXISTS x_trips; DROP TABLE IF EXISTS x_mask; DROP TABLE IF EXISTS x_keep`).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}
