import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "../db.ts";
import { sqlStr } from "../db.ts";
import type { FeedsConfig, ResolvedFeed } from "../feeds.ts";
import { classifyRoute, type ClassifyContext } from "../core/classify.ts";
import { sqlGtfsTime, isUtcLike, validTz } from "../core/time.ts";
import { log, warn } from "../util/log.ts";
import { BBOX } from "../geonames.ts";

export interface LoadContext {
  db: Db;
  cfg: FeedsConfig;
  /** ISO start date of the horizon and number of days. */
  startDate: string;
  days: number;
  tmpDir: string;
  /** Feed keys present in this build (for dedicated-operator rules). */
  presentFeedIds: Set<string>;
  dropBus: boolean;
}

export interface FeedLoadStats {
  key: string;
  routes: number;
  trips: number;
  stopTimes: number;
  stops: number;
  droppedShortBus: number;
  byCat: Record<string, number>;
  seconds: number;
}

/** Create the global tables. */
export async function initSchema(db: Db): Promise<void> {
  await db.run(`
    CREATE TABLE IF NOT EXISTS feeds(feed INTEGER, key VARCHAR, id VARCHAR, country VARCHAR, priority INTEGER, file VARCHAR);
    CREATE TABLE IF NOT EXISTS rclass(rc INTEGER, feed INTEGER, cls VARCHAR, cat INTEGER, flags INTEGER, agency VARCHAR,
      route_short VARCHAR, route_long VARCHAR, color VARCHAR, tz VARCHAR, route_type INTEGER, route_id VARCHAR, pname VARCHAR);
    CREATE TABLE IF NOT EXISTS trips(trip_key INTEGER, feed INTEGER, rc INTEGER, service_key INTEGER, headsign VARCHAR,
      short_name VARCHAR, shape_key INTEGER, has_freq BOOLEAN);
    CREATE TABLE IF NOT EXISTS stop_times(trip_key INTEGER, seq INTEGER, stop_key INTEGER, arr SMALLINT, dep SMALLINT, dist FLOAT);
    CREATE TABLE IF NOT EXISTS stops(stop_key INTEGER, feed INTEGER, stop_id VARCHAR, name VARCHAR, lat DOUBLE, lon DOUBLE,
      parent_key INTEGER, tz VARCHAR, loc_type INTEGER);
    CREATE TABLE IF NOT EXISTS service_days(service_key INTEGER, day SMALLINT);
    CREATE TABLE IF NOT EXISTS frequencies(trip_key INTEGER, start_min SMALLINT, end_min SMALLINT, headway_s INTEGER);
    CREATE TABLE IF NOT EXISTS shapes(shape_key INTEGER, seq INTEGER, lat DOUBLE, lon DOUBLE, dist DOUBLE);
  `);
}

export function listZip(zip: string): string[] {
  return execFileSync("unzip", ["-Z1", zip], { maxBuffer: 1 << 26 })
    .toString("utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function extract(zip: string, entry: string, dir: string): string {
  execFileSync("unzip", ["-o", "-j", "-q", zip, entry, "-d", dir], { stdio: ["ignore", "ignore", "pipe"] });
  return join(dir, entry.split("/").pop()!);
}

async function nextKey(db: Db, table: string, col: string): Promise<number> {
  return (await db.scalar(`SELECT coalesce(max(${col}), -1) + 1 FROM ${table}`)) as number;
}

/** read_csv expression for a GTFS file (all varchar, tolerant). */
export function csv(path: string): string {
  return `read_csv(${sqlStr(path)}, all_varchar=true, header=true, delim=',', quote='"', escape='"', strict_mode=false, null_padding=true, ignore_errors=true, sample_size=-1)`;
}

/** Map of normalized column name → SQL expression (quoted original). */
export async function columns(db: Db, path: string): Promise<Map<string, string>> {
  const rows = await db.all<{ column_name: string }>(`DESCRIBE SELECT * FROM ${csv(path)}`);
  const m = new Map<string, string>();
  for (const r of rows) {
    const norm = r.column_name.replace(/^﻿/, "").trim().toLowerCase();
    m.set(norm, `"${r.column_name.replace(/"/g, '""')}"`);
  }
  return m;
}

export function c(cols: Map<string, string>, name: string, fallback = "NULL::VARCHAR", alias = ""): string {
  const q = cols.get(name);
  return q ? `nullif(trim(${alias ? alias + "." : ""}${q}), '')` : fallback;
}

export async function loadFeed(ctx: LoadContext, feedIdx: number, rf: ResolvedFeed, zipPath: string): Promise<FeedLoadStats> {
  const t0 = Date.now();
  const { db, cfg } = ctx;
  const def = rf.def;
  const opts = def.options ?? {};
  const dir = join(ctx.tmpDir, `feed-${feedIdx}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const stats: FeedLoadStats = { key: rf.key, routes: 0, trips: 0, stopTimes: 0, stops: 0, droppedShortBus: 0, byCat: {}, seconds: 0 };

  const entries = listZip(zipPath);
  const find = (name: string) =>
    entries.find((e) => e.split("/").pop()!.toLowerCase() === name && !e.startsWith("__MACOSX"));
  const files: Record<string, string | null> = {};
  for (const n of ["agency.txt", "routes.txt", "trips.txt", "calendar.txt", "calendar_dates.txt", "frequencies.txt", "stops.txt"]) {
    const e = find(n);
    files[n] = e ? extract(zipPath, e, dir) : null;
  }
  if (!files["routes.txt"] || !files["trips.txt"] || !find("stop_times.txt") || !files["stops.txt"]) {
    warn(`feed ${rf.key}: missing required GTFS files, skipping`);
    await rm(dir, { recursive: true, force: true });
    return stats;
  }
  await db.run(
    `INSERT INTO feeds VALUES (${feedIdx}, ${sqlStr(rf.key)}, ${sqlStr(def.id)}, ${sqlStr(def.country)}, ${opts.priority ?? 0}, ${sqlStr(rf.transitousFile ?? "")})`,
  );

  // ---------- agency ----------
  await db.run(`DROP TABLE IF EXISTS t_agency; CREATE TEMP TABLE t_agency(agency_id VARCHAR, name VARCHAR, tz VARCHAR)`);
  if (files["agency.txt"]) {
    const ac = await columns(db, files["agency.txt"]);
    await db.run(
      `INSERT INTO t_agency SELECT coalesce(${c(ac, "agency_id")}, ''), coalesce(${c(ac, "agency_name")}, ''), ${c(ac, "agency_timezone")} FROM ${csv(files["agency.txt"])}`,
    );
  }
  const agencies = await db.all<{ agency_id: string; name: string; tz: string | null }>(`SELECT * FROM t_agency ORDER BY ALL`);
  const defaultTz = validTz(agencies.find((a) => a.tz)?.tz) ?? "Europe/Berlin";

  // ---------- routes ----------
  const rc = await columns(db, files["routes.txt"]);
  await db.run(`DROP TABLE IF EXISTS t_routes; CREATE TEMP TABLE t_routes AS SELECT
      ${c(rc, "route_id")} AS route_id, coalesce(${c(rc, "agency_id")}, '') AS agency_id,
      try_cast(${c(rc, "route_type")} AS INTEGER) AS route_type,
      coalesce(${c(rc, "route_short_name")}, '') AS short, coalesce(${c(rc, "route_long_name")}, '') AS long,
      coalesce(${c(rc, "route_desc")}, '') AS "desc", ${c(rc, "route_color")} AS color
    FROM ${csv(files["routes.txt"])} WHERE ${c(rc, "route_id")} IS NOT NULL`);

  // ---------- trips ----------
  const tc = await columns(db, files["trips.txt"]);
  await db.run(`DROP TABLE IF EXISTS t_trips; CREATE TEMP TABLE t_trips AS SELECT
      ${c(tc, "route_id")} AS route_id, ${c(tc, "service_id")} AS service_id, ${c(tc, "trip_id")} AS trip_id,
      ${opts.headsignIsNumber ? "NULL::VARCHAR" : c(tc, "trip_headsign")} AS headsign,
      ${opts.headsignIsNumber ? `coalesce(${c(tc, "trip_short_name")}, ${c(tc, "trip_headsign")})` : c(tc, "trip_short_name")} AS short_name,
      ${c(tc, "shape_id")} AS shape_id,
      coalesce(nullif(regexp_extract(${c(tc, "trip_short_name", "''")}, '^\\s*([A-Za-zÀ-ž]+)', 1), ''),
        ${opts.tripPrefixRegex ? `nullif(regexp_extract(${c(tc, "trip_id")}, ${sqlStr(opts.tripPrefixRegex)}, 1), '')` : "NULL"}, '') AS prefix
    FROM ${csv(files["trips.txt"])} WHERE ${c(tc, "trip_id")} IS NOT NULL`);

  // ---------- calendars → service days within horizon ----------
  const start = ctx.startDate;
  await db.run(`DROP TABLE IF EXISTS t_svcdays; CREATE TEMP TABLE t_svcdays(service_id VARCHAR, day INTEGER)`);
  if (files["calendar.txt"]) {
    const cc = await columns(db, files["calendar.txt"]);
    const wd = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => `coalesce(${c(cc, d)}, '0')`);
    await db.run(`INSERT INTO t_svcdays
      SELECT service_id, i FROM (
        SELECT ${c(cc, "service_id")} AS service_id, [${wd.join(", ")}] AS w,
          try_strptime(${c(cc, "start_date")}, '%Y%m%d')::DATE AS s, try_strptime(${c(cc, "end_date")}, '%Y%m%d')::DATE AS e
        FROM ${csv(files["calendar.txt"])}
      ) cal, range(-1, ${ctx.days + 1}) r(i)
      WHERE (DATE '${start}' + i::INTEGER) BETWEEN s AND e AND w[isodow(DATE '${start}' + i::INTEGER)] = '1'`);
  }
  if (files["calendar_dates.txt"]) {
    const dc = await columns(db, files["calendar_dates.txt"]);
    await db.run(`DROP TABLE IF EXISTS t_ex; CREATE TEMP TABLE t_ex AS SELECT * FROM (
        SELECT ${c(dc, "service_id")} AS service_id,
          (try_strptime(${c(dc, "date")}, '%Y%m%d')::DATE - DATE '${start}')::INTEGER AS day,
          try_cast(${c(dc, "exception_type")} AS INTEGER) AS t
        FROM ${csv(files["calendar_dates.txt"])}) WHERE day BETWEEN -1 AND ${ctx.days}`);
    await db.run(`DELETE FROM t_svcdays WHERE (service_id, day) IN (SELECT (service_id, day) FROM t_ex WHERE t = 2)`);
    await db.run(`INSERT INTO t_svcdays SELECT DISTINCT service_id, day FROM t_ex WHERE t = 1
                  EXCEPT SELECT service_id, day FROM t_svcdays`);
  }

  // ---------- classification per (route, trip prefix) ----------
  const combos = await db.all<{
    route_id: string; agency_id: string; route_type: number | null; short: string; long: string; desc: string; color: string | null; prefix: string; n: number;
  }>(`SELECT r.route_id, r.agency_id, r.route_type, r.short, r.long, r."desc", r.color, t.prefix, count(*) AS n
      FROM t_trips t JOIN t_routes r USING (route_id) GROUP BY ALL ORDER BY ALL`);
  const agencyById = new Map(agencies.map((a) => [a.agency_id, a]));
  const onlyAgency = agencies.length === 1 ? agencies[0] : undefined;
  const cctx: ClassifyContext = {
    keep: ctx.dropBus ? def.keep.filter((k) => k !== "bus") : def.keep,
    opts,
    country: def.country,
    coachRe: new RegExp(cfg.coachOperators, "i"),
    urbanRe: cfg.urbanAgencies ? new RegExp(cfg.urbanAgencies, "i") : null,
  };
  const dropAg = opts.dropAgencies ? new RegExp(opts.dropAgencies, "i") : null;
  const onlyAg = opts.onlyAgencies ? new RegExp(opts.onlyAgencies, "i") : null;
  const dedicated = cfg.dedicatedOperators
    .filter((d) => !d.feeds.includes(def.id) && d.feeds.some((f) => ctx.presentFeedIds.has(f)))
    .map((d) => new RegExp(d.pattern, "i"));
  let rcBase = await nextKey(db, "rclass", "rc");
  const rcRows: unknown[][] = [];
  const mapRows: unknown[][] = [];
  const rcIndex = new Map<string, number>();
  for (const r of combos) {
    if (r.route_type == null) continue;
    const ag = agencyById.get(r.agency_id) ?? onlyAgency ?? agencies[0];
    const agencyName = ag?.name ?? "";
    if (dropAg && dropAg.test(agencyName)) continue;
    if (onlyAg && !onlyAg.test(agencyName)) continue;
    if (dedicated.some((re) => re.test(agencyName) || re.test(r.short) || re.test(r.long))) continue;
    const cl = classifyRoute(
      { routeType: r.route_type, agency: agencyName, shortName: r.short, longName: r.long, desc: r.desc, tripPrefix: r.prefix },
      cctx,
    );
    if (!cl) continue;
    let tz = validTz(ag?.tz) ?? defaultTz;
    if (isUtcLike(tz)) tz = "UTC";
    const pname = opts.prefixNames?.[r.prefix] ?? null;
    const k = [cl.cls, cl.cat, cl.flags, agencyName, r.short, r.long, r.color ?? "", tz, r.route_type, r.route_id, pname ?? ""].join("\u0001");
    let id = rcIndex.get(k);
    if (id === undefined) {
      id = rcBase++;
      rcIndex.set(k, id);
      rcRows.push([id, feedIdx, cl.cls, cl.cat, cl.flags, agencyName, r.short, r.long, r.color, tz, r.route_type, r.route_id, pname]);
    }
    mapRows.push([r.route_id, r.prefix, id]);
  }
  if (!rcRows.length) {
    warn(`feed ${rf.key}: no routes kept`);
    await rm(dir, { recursive: true, force: true });
    return stats;
  }
  await db.insertRows(
    "rclass",
    [
      { name: "rc", type: "INTEGER" }, { name: "feed", type: "INTEGER" }, { name: "cls", type: "VARCHAR" }, { name: "cat", type: "INTEGER" },
      { name: "flags", type: "INTEGER" }, { name: "agency", type: "VARCHAR" }, { name: "route_short", type: "VARCHAR" },
      { name: "route_long", type: "VARCHAR" }, { name: "color", type: "VARCHAR" }, { name: "tz", type: "VARCHAR" },
      { name: "route_type", type: "INTEGER" }, { name: "route_id", type: "VARCHAR" }, { name: "pname", type: "VARCHAR" },
    ],
    rcRows,
    join(dir, "rc.csv"),
  );
  await db.run(`DROP TABLE IF EXISTS t_rcmap`);
  await db.insertRows(
    "t_rcmap",
    [{ name: "route_id", type: "VARCHAR" }, { name: "prefix", type: "VARCHAR" }, { name: "rc", type: "INTEGER" }],
    mapRows,
    join(dir, "rcmap.csv"),
  );
  await db.run(`UPDATE t_rcmap SET prefix = coalesce(prefix, '')`);
  stats.routes = rcRows.length;

  // ---------- services ----------
  // Keys are numbered in a fixed order (ORDER BY in every row_number): DuckDB scans in parallel and does not
  // preserve insertion order, so OVER () would number rows differently from run to run.
  const svcBase = await nextKey(db, "service_days", "service_key");
  await db.run(`DROP TABLE IF EXISTS t_svc; CREATE TEMP TABLE t_svc AS
    SELECT service_id, ${svcBase} + (row_number() OVER (ORDER BY service_id) - 1)::INTEGER AS service_key
    FROM (SELECT DISTINCT service_id FROM t_svcdays)`);

  // ---------- kept trips ----------
  const tripBase = await nextKey(db, "trips", "trip_key");
  await db.run(`DROP TABLE IF EXISTS t_kt; CREATE TEMP TABLE t_kt AS
    SELECT ${tripBase} + (row_number() OVER (ORDER BY t.trip_id, m.rc, s.service_key, t.headsign, t.short_name, t.shape_id) - 1)::INTEGER AS trip_key, t.trip_id, m.rc, s.service_key, t.headsign, t.short_name, t.shape_id,
           rc.cls
    FROM t_trips t
    JOIN t_rcmap m ON m.route_id = t.route_id AND m.prefix = t.prefix
    JOIN t_svc s ON s.service_id = t.service_id
    JOIN rclass rc ON rc.rc = m.rc`);
  // Duplicate trip_ids would explode joins; keep the first.
  await db.run(`DELETE FROM t_kt WHERE trip_key NOT IN (SELECT min(trip_key) FROM t_kt GROUP BY trip_id)`);
  const nKt = await db.scalar(`SELECT count(*) FROM t_kt`);
  if (!nKt) {
    warn(`feed ${rf.key}: no trips within the horizon`);
    await rm(dir, { recursive: true, force: true });
    return stats;
  }

  // ---------- stop_times (streamed from CSV, filtered by kept trips) ----------
  const stPath = extract(zipPath, find("stop_times.txt")!, dir);
  const sc = await columns(db, stPath);
  const distExpr = sc.has("shape_dist_traveled") ? `try_cast(${c(sc, "shape_dist_traveled")} AS FLOAT)` : "NULL::FLOAT";
  await db.run(`DROP TABLE IF EXISTS t_st; CREATE TEMP TABLE t_st AS
    SELECT kt.trip_key, try_cast(${c(sc, "stop_sequence")} AS INTEGER) AS seq, ${c(sc, "stop_id")} AS stop_id,
      ${sqlGtfsTime(c(sc, "arrival_time"))} AS arr, ${sqlGtfsTime(c(sc, "departure_time"))} AS dep, ${distExpr} AS dist
    FROM ${csv(stPath)} st JOIN t_kt kt ON kt.trip_id = ${c(sc, "trip_id", "NULL::VARCHAR", "st")}`);
  await rm(stPath, { force: true });
  await db.run(`DELETE FROM t_st WHERE seq IS NULL OR stop_id IS NULL`);

  // Fill missing times: use the other of arr/dep, then linear interpolation between timed stops.
  await db.run(`UPDATE t_st SET arr = coalesce(arr, dep), dep = coalesce(dep, arr) WHERE arr IS NULL OR dep IS NULL`);
  const untimed = await db.scalar(`SELECT count(*) FROM t_st WHERE arr IS NULL`);
  if (untimed > 0) {
    await db.run(`CREATE OR REPLACE TEMP TABLE t_st AS
      WITH a AS (SELECT *, row_number() OVER (PARTITION BY trip_key ORDER BY seq) AS rn FROM t_st),
      b AS (SELECT *,
        last_value(CASE WHEN dep IS NOT NULL THEN dep END IGNORE NULLS) OVER w1 AS pt,
        last_value(CASE WHEN dep IS NOT NULL THEN rn END IGNORE NULLS) OVER w1 AS pr,
        first_value(CASE WHEN arr IS NOT NULL THEN arr END IGNORE NULLS) OVER w2 AS nt,
        first_value(CASE WHEN arr IS NOT NULL THEN rn END IGNORE NULLS) OVER w2 AS nr
        FROM a
        WINDOW w1 AS (PARTITION BY trip_key ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
               w2 AS (PARTITION BY trip_key ORDER BY seq ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING))
      SELECT trip_key, seq, stop_id,
        coalesce(arr, CASE WHEN nr > pr THEN (pt + (nt - pt) * (rn - pr) / (nr - pr))::INTEGER END) AS arr,
        coalesce(dep, CASE WHEN nr > pr THEN (pt + (nt - pt) * (rn - pr) / (nr - pr))::INTEGER END) AS dep,
        dist
      FROM b`);
    // Trips that still have untimed stops (no timed bounds) are dropped.
    await db.run(`DELETE FROM t_st WHERE trip_key IN (SELECT trip_key FROM t_st WHERE arr IS NULL OR dep IS NULL)`);
  }

  // ---------- stops ----------
  const sp = await columns(db, files["stops.txt"]!);
  await db.run(`DROP TABLE IF EXISTS t_stops_all; CREATE TEMP TABLE t_stops_all AS SELECT
      ${c(sp, "stop_id")} AS stop_id, coalesce(${c(sp, "stop_name")}, '') AS name,
      try_cast(${c(sp, "stop_lat")} AS DOUBLE) AS lat, try_cast(${c(sp, "stop_lon")} AS DOUBLE) AS lon,
      ${c(sp, "parent_station")} AS parent_id, ${c(sp, "stop_timezone")} AS tz,
      coalesce(try_cast(${c(sp, "location_type")} AS INTEGER), 0) AS loc_type
    FROM ${csv(files["stops.txt"]!)} WHERE ${c(sp, "stop_id")} IS NOT NULL`);
  // Duplicate stop_ids: keep one by content (rowid is not file order: CSV scans run in parallel).
  if ((await db.scalar(`SELECT count(*) - count(DISTINCT stop_id) FROM t_stops_all`)) > 0)
    await db.run(`CREATE OR REPLACE TEMP TABLE t_stops_all AS SELECT * EXCLUDE (rn) FROM (
        SELECT *, row_number() OVER (PARTITION BY stop_id ORDER BY name, lat, lon, parent_id, tz, loc_type) AS rn FROM t_stops_all
      ) WHERE rn = 1`);
  // Drop stop_times at stops without valid coordinates.
  await db.run(`DELETE FROM t_st WHERE stop_id NOT IN (
      SELECT stop_id FROM t_stops_all WHERE lat BETWEEN ${BBOX.minLat} AND ${BBOX.maxLat} AND lon BETWEEN ${BBOX.minLon} AND ${BBOX.maxLon})`);

  // ---------- bus filter: drop short (urban) bus/coach trips ----------
  const minKm = opts.minBusKm ?? cfg.minBusKm;
  const nBefore = await db.scalar(`SELECT count(DISTINCT trip_key) FROM t_st`);
  await db.run(`DELETE FROM t_st WHERE trip_key IN (
      SELECT st.trip_key FROM t_st st JOIN t_kt kt USING (trip_key) JOIN t_stops_all s USING (stop_id)
      WHERE kt.cls IN ('bus', 'coach')
      GROUP BY st.trip_key
      HAVING sqrt(pow((max(s.lat) - min(s.lat)) * 111.2, 2) + pow((max(s.lon) - min(s.lon)) * 111.2 * cos(radians(avg(s.lat))), 2)) < ${minKm})`);
  // Trips with fewer than 2 stops are useless.
  await db.run(`DELETE FROM t_st WHERE trip_key IN (SELECT trip_key FROM t_st GROUP BY trip_key HAVING count(*) < 2)`);
  const nAfter = await db.scalar(`SELECT count(DISTINCT trip_key) FROM t_st`);
  stats.droppedShortBus = nBefore - nAfter;

  // ---------- stops used (+ parents) ----------
  const stopBase = await nextKey(db, "stops", "stop_key");
  await db.run(`DROP TABLE IF EXISTS t_stopkeys; CREATE TEMP TABLE t_stopkeys AS
    WITH used AS (SELECT DISTINCT stop_id FROM t_st),
    par AS (SELECT DISTINCT s.parent_id AS stop_id FROM t_stops_all s JOIN used USING (stop_id) WHERE s.parent_id IS NOT NULL),
    allids AS (SELECT stop_id FROM used UNION SELECT p.stop_id FROM par p JOIN t_stops_all s USING (stop_id))
    SELECT stop_id, ${stopBase} + (row_number() OVER (ORDER BY stop_id) - 1)::INTEGER AS stop_key FROM allids`);
  await db.run(`INSERT INTO stops
    SELECT k.stop_key, ${feedIdx}, s.stop_id, s.name, s.lat, s.lon, pk.stop_key, s.tz, s.loc_type
    FROM t_stopkeys k JOIN t_stops_all s USING (stop_id) LEFT JOIN t_stopkeys pk ON pk.stop_id = s.parent_id`);
  stats.stops = await db.scalar(`SELECT count(*) FROM t_stopkeys`);

  // ---------- shapes for rail trips ----------
  const shapesEntry = find("shapes.txt");
  await db.run(`DROP TABLE IF EXISTS t_shapekeys; CREATE TEMP TABLE t_shapekeys(shape_id VARCHAR, shape_key INTEGER)`);
  if (shapesEntry && opts.shapes !== false) {
    const shapeBase = await nextKey(db, "shapes", "shape_key");
    await db.run(`INSERT INTO t_shapekeys SELECT shape_id, ${shapeBase} + (row_number() OVER (ORDER BY shape_id) - 1)::INTEGER FROM (
        SELECT DISTINCT shape_id FROM t_kt WHERE cls = 'rail' AND shape_id IS NOT NULL
          AND trip_key IN (SELECT DISTINCT trip_key FROM t_st))`);
    if ((await db.scalar(`SELECT count(*) FROM t_shapekeys`)) > 0) {
      const shPath = extract(zipPath, shapesEntry, dir);
      const hc = await columns(db, shPath);
      await db.run(`INSERT INTO shapes SELECT k.shape_key, try_cast(${c(hc, "shape_pt_sequence")} AS INTEGER),
          try_cast(${c(hc, "shape_pt_lat")} AS DOUBLE), try_cast(${c(hc, "shape_pt_lon")} AS DOUBLE),
          try_cast(${c(hc, "shape_dist_traveled")} AS DOUBLE)
        FROM ${csv(shPath)} sh JOIN t_shapekeys k ON k.shape_id = ${c(hc, "shape_id", "NULL::VARCHAR", "sh")}`);
      await rm(shPath, { force: true });
    }
  }

  // ---------- insert into global tables ----------
  await db.run(`INSERT INTO trips SELECT kt.trip_key, ${feedIdx}, kt.rc, kt.service_key, kt.headsign, kt.short_name, sk.shape_key, false
    FROM t_kt kt LEFT JOIN t_shapekeys sk USING (shape_id) WHERE kt.trip_key IN (SELECT DISTINCT trip_key FROM t_st)`);
  await db.run(`INSERT INTO stop_times SELECT st.trip_key, st.seq, k.stop_key, st.arr, st.dep, st.dist
    FROM t_st st JOIN t_stopkeys k USING (stop_id)`);
  await db.run(`INSERT INTO service_days SELECT s.service_key, d.day FROM t_svcdays d JOIN t_svc s USING (service_id)
    WHERE s.service_key IN (SELECT DISTINCT service_key FROM t_kt)`);
  if (files["frequencies.txt"]) {
    const fc = await columns(db, files["frequencies.txt"]);
    await db.run(`INSERT INTO frequencies SELECT kt.trip_key, ${sqlGtfsTime(c(fc, "start_time"))}, ${sqlGtfsTime(c(fc, "end_time"))},
        try_cast(${c(fc, "headway_secs")} AS INTEGER)
      FROM ${csv(files["frequencies.txt"])} f JOIN t_kt kt ON kt.trip_id = ${c(fc, "trip_id", "NULL::VARCHAR", "f")}
      WHERE try_cast(${c(fc, "headway_secs")} AS INTEGER) > 0`);
    await db.run(`UPDATE trips SET has_freq = true WHERE trip_key IN (SELECT trip_key FROM frequencies) AND feed = ${feedIdx}`);
  }

  stats.trips = await db.scalar(`SELECT count(*) FROM trips WHERE feed = ${feedIdx}`);
  stats.stopTimes = await db.scalar(`SELECT count(*) FROM t_st`);
  for (const r of await db.all<{ cls: string; cat: number | null; n: number }>(
    `SELECT rc.cls, rc.cat, count(*) AS n FROM trips t JOIN rclass rc USING (rc) WHERE t.feed = ${feedIdx} GROUP BY ALL`,
  ))
    stats.byCat[`${r.cls}:${r.cat ?? "?"}`] = r.n;

  await db.run(`DROP TABLE IF EXISTS t_st; DROP TABLE IF EXISTS t_kt; DROP TABLE IF EXISTS t_trips; DROP TABLE IF EXISTS t_stops_all;
    DROP TABLE IF EXISTS t_routes; DROP TABLE IF EXISTS t_svcdays; DROP TABLE IF EXISTS t_ex; DROP TABLE IF EXISTS t_svc;
    DROP TABLE IF EXISTS t_rcmap; DROP TABLE IF EXISTS t_stopkeys; DROP TABLE IF EXISTS t_shapekeys; DROP TABLE IF EXISTS t_agency;`);
  await rm(dir, { recursive: true, force: true });
  stats.seconds = Math.round((Date.now() - t0) / 100) / 10;
  log(
    `feed ${rf.key}: ${stats.routes} route classes, ${stats.trips} trips, ${stats.stopTimes} stop_times, ${stats.stops} stops, ` +
      `-${stats.droppedShortBus} short bus trips, ${JSON.stringify(stats.byCat)} in ${stats.seconds}s`,
  );
  return stats;
}

export { existsSync };
