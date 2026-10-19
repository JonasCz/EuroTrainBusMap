import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "../db.ts";
import { sqlStr } from "../db.ts";
import type { FeedsConfig, ResolvedFeed } from "../feeds.ts";
import { classifyRoute, REPLACEMENT_HEADSIGN_RE, type ClassifyContext } from "../core/classify.ts";
import { sqlGtfsTime, isUtcLike, validTz } from "../core/time.ts";
import { log, warn } from "../util/log.ts";
import { StopLimit } from "@etbm/shared";
import { BBOX } from "../geonames.ts";
import { OperatorConflictError, type FeedOperators } from "../operators/registry.ts";
import type { LoadApi, OperatorAdapter } from "../operators/types.ts";

/** Version of what the loader stores: part of the --reuse-db key, so a database loaded by an older loader is reloaded. */
export const LOAD_VERSION = 3;

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
    CREATE TABLE IF NOT EXISTS stop_times(trip_key INTEGER, seq INTEGER, stop_key INTEGER, arr SMALLINT, dep SMALLINT, dist FLOAT, pd UTINYINT);
    CREATE TABLE IF NOT EXISTS stops(stop_key INTEGER, feed INTEGER, stop_id VARCHAR, name VARCHAR, lat DOUBLE, lon DOUBLE,
      parent_key INTEGER, tz VARCHAR, loc_type INTEGER);
    CREATE TABLE IF NOT EXISTS service_days(service_key INTEGER, day SMALLINT);
    CREATE TABLE IF NOT EXISTS frequencies(trip_key INTEGER, start_min SMALLINT, end_min SMALLINT, headway_s INTEGER);
    CREATE TABLE IF NOT EXISTS shapes(shape_key INTEGER, seq INTEGER, lat DOUBLE, lon DOUBLE, dist DOUBLE);
    CREATE TABLE IF NOT EXISTS limit_hints(htrip INTEGER, feed INTEGER, num VARCHAR, tz VARCHAR, rn INTEGER, n INTEGER, lat DOUBLE, lon DOUBLE,
      arr SMALLINT, dep SMALLINT, pd UTINYINT);
    CREATE TABLE IF NOT EXISTS operator_log(adapter VARCHAR, feed VARCHAR, field VARCHAR, n INTEGER);
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

  /** columns of the feed's GTFS files (operator adapters' onLoad hooks) */
  const fileColumns = new Map<string, Map<string, string>>();
  const ops = cfg.operators?.forFeed({ key: rf.key, id: def.id, country: def.country });

  // ---------- agency ----------
  await db.run(`DROP TABLE IF EXISTS t_agency; CREATE TEMP TABLE t_agency(agency_id VARCHAR, name VARCHAR, tz VARCHAR)`);
  if (files["agency.txt"]) {
    const ac = await columns(db, files["agency.txt"]);
    fileColumns.set("agency.txt", ac);
    await db.run(
      `INSERT INTO t_agency SELECT coalesce(${c(ac, "agency_id")}, ''), coalesce(${c(ac, "agency_name")}, ''), ${c(ac, "agency_timezone")} FROM ${csv(files["agency.txt"])}`,
    );
  }
  const agencies = await db.all<{ agency_id: string; name: string; tz: string | null }>(`SELECT * FROM t_agency ORDER BY ALL`);
  const defaultTz = validTz(agencies.find((a) => a.tz)?.tz) ?? "Europe/Berlin";

  // ---------- routes ----------
  const rc = await columns(db, files["routes.txt"]);
  fileColumns.set("routes.txt", rc);
  await db.run(`DROP TABLE IF EXISTS t_routes; CREATE TEMP TABLE t_routes AS SELECT
      ${c(rc, "route_id")} AS route_id, coalesce(${c(rc, "agency_id")}, '') AS agency_id,
      try_cast(${c(rc, "route_type")} AS INTEGER) AS route_type,
      coalesce(${c(rc, "route_short_name")}, '') AS short, coalesce(${c(rc, "route_long_name")}, '') AS long,
      coalesce(${c(rc, "route_desc")}, '') AS "desc", ${c(rc, "route_color")} AS color
    FROM ${csv(files["routes.txt"])} WHERE ${c(rc, "route_id")} IS NOT NULL`);

  // ---------- trips ----------
  const tc = await columns(db, files["trips.txt"]);
  fileColumns.set("trips.txt", tc);
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
  /** (route, trip prefix, tz) of the routes left to a dedicated operator's feed */
  const shadowRows: unknown[][] = [];
  for (const r of combos) {
    if (r.route_type == null) continue;
    const ag = agencyById.get(r.agency_id) ?? onlyAgency ?? agencies[0];
    const agencyName = ag?.name ?? "";
    if (dropAg && dropAg.test(agencyName)) continue;
    if (onlyAg && !onlyAg.test(agencyName)) continue;
    if (dedicated.some((re) => re.test(agencyName) || re.test(r.short) || re.test(r.long))) {
      // left to the operator's own feed, but this copy's boarding / alighting restrictions are kept (limit_hints)
      let tz = validTz(ag?.tz) ?? defaultTz;
      if (isUtcLike(tz)) tz = "UTC";
      shadowRows.push([r.route_id, r.prefix, tz]);
      continue;
    }
    const cl = classifyRoute(
      { routeType: r.route_type, agency: agencyName, shortName: r.short, longName: r.long, desc: r.desc, tripPrefix: r.prefix },
      ops ? { ...cctx, hooks: ops.classifyHooks(agencyName) } : cctx,
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
  // Rail-replacement buses under an ordinary bus line, told by the headsign ("Gera Hbf (SEV)", "Odense St. (togbus)").
  await db.run(`DELETE FROM t_kt WHERE cls IN ('bus', 'coach') AND regexp_matches(coalesce(headsign, ''), ${sqlStr(REPLACEMENT_HEADSIGN_RE.source)})`);
  const nKt = await db.scalar(`SELECT count(*) FROM t_kt`);
  if (!nKt) {
    warn(`feed ${rf.key}: no trips within the horizon`);
    await rm(dir, { recursive: true, force: true });
    return stats;
  }

  // ---------- stop_times (streamed from CSV, filtered by kept trips) ----------
  const stPath = extract(zipPath, find("stop_times.txt")!, dir);
  const sc = await columns(db, stPath);
  fileColumns.set("stop_times.txt", sc);
  const distExpr = sc.has("shape_dist_traveled") ? `try_cast(${c(sc, "shape_dist_traveled")} AS FLOAT)` : "NULL::FLOAT";
  // Boarding / alighting restrictions (StopLimit bits): only type 1 ("no pickup" / "no drop off") counts. Types 2 / 3
  // (phone the agency / ask the driver) are ordinary stops that need a reservation or a request: the Austrian PTA feeds
  // mark ordinary trains and buses that way, German heritage lines their request stops.
  const pdExpr = `(CASE WHEN ${c(sc, "pickup_type", "NULL")} = '1' THEN ${StopLimit.NoBoarding} ELSE 0 END
      | CASE WHEN ${c(sc, "drop_off_type", "NULL")} = '1' THEN ${StopLimit.NoAlighting} ELSE 0 END)::UTINYINT`;
  await db.run(`DROP TABLE IF EXISTS t_st; CREATE TEMP TABLE t_st AS
    SELECT kt.trip_key, try_cast(${c(sc, "stop_sequence")} AS INTEGER) AS seq, ${c(sc, "stop_id")} AS stop_id,
      ${sqlGtfsTime(c(sc, "arrival_time"))} AS arr, ${sqlGtfsTime(c(sc, "departure_time"))} AS dep, ${distExpr} AS dist, ${pdExpr} AS pd
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
        dist, pd
      FROM b`);
    // Trips that still have untimed stops (no timed bounds) are dropped.
    await db.run(`DELETE FROM t_st WHERE trip_key IN (SELECT trip_key FROM t_st WHERE arr IS NULL OR dep IS NULL)`);
  }

  // ---------- stops ----------
  const sp = await columns(db, files["stops.txt"]!);
  fileColumns.set("stops.txt", sp);
  await db.run(`DROP TABLE IF EXISTS t_stops_all; CREATE TEMP TABLE t_stops_all AS SELECT
      ${c(sp, "stop_id")} AS stop_id, coalesce(${c(sp, "stop_name")}, '') AS name,
      try_cast(${c(sp, "stop_lat")} AS DOUBLE) AS lat, try_cast(${c(sp, "stop_lon")} AS DOUBLE) AS lon,
      ${c(sp, "parent_station")} AS parent_id, ${c(sp, "stop_timezone")} AS tz,
      coalesce(try_cast(${c(sp, "location_type")} AS INTEGER), 0) AS loc_type,
      try_cast(${c(sp, "vehicle_type")} AS INTEGER) AS vehicle_type
    FROM ${csv(files["stops.txt"]!)} WHERE ${c(sp, "stop_id")} IS NOT NULL`);
  // Duplicate stop_ids: keep one by content (rowid is not file order: CSV scans run in parallel).
  if ((await db.scalar(`SELECT count(*) - count(DISTINCT stop_id) FROM t_stops_all`)) > 0)
    await db.run(`CREATE OR REPLACE TEMP TABLE t_stops_all AS SELECT * EXCLUDE (rn) FROM (
        SELECT *, row_number() OVER (PARTITION BY stop_id ORDER BY name, lat, lon, parent_id, tz, loc_type) AS rn FROM t_stops_all
      ) WHERE rn = 1`);
  // Drop stop_times at stops without valid coordinates.
  await db.run(`DELETE FROM t_st WHERE stop_id NOT IN (
      SELECT stop_id FROM t_stops_all WHERE lat BETWEEN ${BBOX.minLat} AND ${BBOX.maxLat} AND lon BETWEEN ${BBOX.minLon} AND ${BBOX.maxLon})`);

  // ---------- restrictions of copies left to a dedicated operator's feed ----------
  // NS publishes the Eurostar with "no boarding" at Rotterdam / Schiphol towards Amsterdam (no domestic travel), the
  // Eurostar feed does not; the trains come from the Eurostar feed (dedicatedOperators), so the copies' stops with
  // their restrictions are kept as hints, matched onto the operator's trips after dedup (build.ts).
  if (shadowRows.length) await loadLimitHints(ctx, feedIdx, rf.key, zipPath, find("stop_times.txt")!, dir, shadowRows);

  // ---------- operator adapters (packages/etl/operators): fixes on this feed's tables, scoped to their routes ----------
  if (ops) await runLoadHooks(db, ops, rf.key, fileColumns, rcRows);

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
  await db.run(`INSERT INTO stop_times SELECT st.trip_key, st.seq, k.stop_key, st.arr, st.dep, st.dist, st.pd
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


/**
 * Stops of the trips of routes left to a dedicated operator's feed (`shadow`: route_id, trip prefix, tz) that carry
 * a boarding / alighting restriction at an intermediate stop, into limit_hints (all stops of such a trip, with
 * position and times; matched onto the operator's trips in build.ts). Needs t_trips and t_stops_all.
 */
async function loadLimitHints(ctx: LoadContext, feedIdx: number, key: string, zipPath: string, stEntry: string, dir: string, shadow: unknown[][]): Promise<void> {
  const { db } = ctx;
  await db.run(`DROP TABLE IF EXISTS t_shmap`);
  await db.insertRows(
    "t_shmap",
    [{ name: "route_id", type: "VARCHAR" }, { name: "prefix", type: "VARCHAR" }, { name: "tz", type: "VARCHAR" }],
    shadow,
    join(dir, "shmap.csv"),
  );
  await db.run(`UPDATE t_shmap SET prefix = coalesce(prefix, '')`);
  await db.run(`DROP TABLE IF EXISTS t_sht; CREATE TEMP TABLE t_sht AS
    SELECT DISTINCT ON (t.trip_id) t.trip_id, coalesce(t.short_name, '') AS num, m.tz FROM t_trips t JOIN t_shmap m ON m.route_id = t.route_id AND m.prefix = t.prefix
    ORDER BY t.trip_id`);
  if (!(await db.scalar(`SELECT count(*) FROM t_sht`))) return;
  const stPath = extract(zipPath, stEntry, dir);
  const sc = await columns(db, stPath);
  if (!sc.has("pickup_type") && !sc.has("drop_off_type")) {
    await rm(stPath, { force: true });
    return;
  }
  const base = await nextKey(db, "limit_hints", "htrip");
  const pdExpr = `(CASE WHEN ${c(sc, "pickup_type", "NULL")} = '1' THEN ${StopLimit.NoBoarding} ELSE 0 END
      | CASE WHEN ${c(sc, "drop_off_type", "NULL")} = '1' THEN ${StopLimit.NoAlighting} ELSE 0 END)`;
  await db.run(`INSERT INTO limit_hints
    WITH s AS (
      SELECT sh.trip_id, sh.num, sh.tz, try_cast(${c(sc, "stop_sequence")} AS INTEGER) AS seq, ${c(sc, "stop_id")} AS stop_id,
        ${sqlGtfsTime(c(sc, "arrival_time"))} AS arr, ${sqlGtfsTime(c(sc, "departure_time"))} AS dep, ${pdExpr} AS pd
      FROM ${csv(stPath)} st JOIN t_sht sh ON sh.trip_id = ${c(sc, "trip_id", "NULL::VARCHAR", "st")}),
    w AS (SELECT *, row_number() OVER (PARTITION BY trip_id ORDER BY seq) AS rn, count(*) OVER (PARTITION BY trip_id) AS n
      FROM s WHERE seq IS NOT NULL AND coalesce(dep, arr) IS NOT NULL),
    lim AS (SELECT trip_id FROM w GROUP BY trip_id
      HAVING bool_or(((CASE WHEN rn < n THEN pd & ${StopLimit.NoBoarding} ELSE 0 END) | (CASE WHEN rn > 1 THEN pd & ${StopLimit.NoAlighting} ELSE 0 END)) > 0))
    SELECT ${base} + (dense_rank() OVER (ORDER BY w.trip_id) - 1)::INTEGER, ${feedIdx}, w.num, w.tz, w.rn, w.n, sa.lat, sa.lon,
      coalesce(w.arr, w.dep), coalesce(w.dep, w.arr), w.pd::UTINYINT
    FROM w JOIN lim USING (trip_id) JOIN t_stops_all sa USING (stop_id)
    WHERE sa.lat IS NOT NULL AND sa.lon IS NOT NULL`);
  await rm(stPath, { force: true });
  const n = await db.scalar(`SELECT count(DISTINCT htrip) FROM limit_hints WHERE feed = ${feedIdx}`);
  if (n) log(`feed ${key}: ${n} trips left to a dedicated operator's feed keep their stop restrictions as hints`);
  await db.run(`DROP TABLE IF EXISTS t_shmap; DROP TABLE IF EXISTS t_sht;`);
}

/**
 * The onLoad hooks of the operator adapters for this feed, in id order. Each sees only this feed's tables and may
 * only drop trips of the routes in its scope (agencies); two adapters whose scopes share a route fail the load.
 */
export async function runLoadHooks(db: Db, ops: FeedOperators, key: string, fileColumns: Map<string, Map<string, string>>, rcRows: unknown[][]): Promise<void> {
  // every route class belongs to at most one adapter's hook: checked for all of them before any runs
  const owner = new Map<number, string>();
  const runs: { a: OperatorAdapter; scoped: number[] | null }[] = [];
  for (const a of ops.loaders) {
    const scoped = a.appliesTo.agencies?.length ? rcRows.filter((r) => ops.covers(a, r[5] as string)).map((r) => r[0] as number) : null;
    for (const rc of scoped ?? rcRows.map((r) => r[0] as number)) {
      const o = owner.get(rc);
      if (o) throw new OperatorConflictError(`${o} and ${a.id} both have an onLoad hook for route class ${rc} of feed ${key}`);
      owner.set(rc, a.id);
    }
    if (!scoped || scoped.length) runs.push({ a, scoped });
  }
  for (const { a, scoped } of runs) await a.onLoad!(loadApi(db, a, ops, key, fileColumns, scoped));
}

const READ_ONLY_RE = /^\s*(SELECT|WITH)\b/i;

function loadApi(db: Db, a: OperatorAdapter, ops: FeedOperators, key: string, fileColumns: Map<string, Map<string, string>>, scoped: number[] | null): LoadApi {
  const readOnly = (sql: string) => {
    if (!READ_ONLY_RE.test(sql) || sql.includes(";")) throw new Error(`operator ${a.id}: only single SELECT / WITH queries are allowed (${sql.slice(0, 60)}…)`);
    return sql;
  };
  return {
    feed: ops.feed,
    columns: (file) => {
      const m = fileColumns.get(file.toLowerCase());
      return m ? new Set(m.keys()) : null;
    },
    all: async (sql) => db.all(readOnly(sql)),
    scalar: async (sql) => db.scalar(readOnly(sql)),
    dropTrips: async (sql, reason) => {
      readOnly(sql);
      const n0 = await db.scalar(`SELECT count(DISTINCT trip_key) FROM t_st`);
      const scope = scoped ? ` AND trip_key IN (SELECT trip_key FROM t_kt WHERE rc IN (${scoped.join(",")}))` : "";
      await db.run(`DELETE FROM t_st WHERE trip_key IN (${sql})${scope}`);
      const n = n0 - (await db.scalar(`SELECT count(DISTINCT trip_key) FROM t_st`));
      if (n) {
        log(`feed ${key}: operator ${a.id}: ${n} trips dropped (${reason})`);
        ops.registry.record(a.id, key, "onLoad.dropTrips", n);
      }
      return n;
    },
    setHeadsigns: async (sql, reason) => {
      readOnly(sql);
      const scope = scoped ? ` AND t_kt.rc IN (${scoped.join(",")})` : "";
      await db.run(`DROP TABLE IF EXISTS t_hs; CREATE TEMP TABLE t_hs AS SELECT DISTINCT ON (trip_key) trip_key::INTEGER AS trip_key, headsign::VARCHAR AS headsign FROM (${sql}) ORDER BY trip_key`);
      const n = await db.scalar(`SELECT count(*) FROM t_kt JOIN t_hs USING (trip_key) WHERE t_kt.headsign IS DISTINCT FROM t_hs.headsign${scope}`);
      await db.run(`UPDATE t_kt SET headsign = t_hs.headsign FROM t_hs WHERE t_kt.trip_key = t_hs.trip_key AND t_kt.headsign IS DISTINCT FROM t_hs.headsign${scope}; DROP TABLE t_hs`);
      if (n) {
        log(`feed ${key}: operator ${a.id}: ${n} trip headsigns changed (${reason})`);
        ops.registry.record(a.id, key, "onLoad.setHeadsigns", n);
      }
      return n;
    },
  };
}

export { existsSync };
