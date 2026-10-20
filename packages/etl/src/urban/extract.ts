import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "../db.ts";
import { sqlStr } from "../db.ts";
import { c, columns, csv, extract, listZip } from "../gtfs/load.ts";
import { simplifyLine } from "../util/geo.ts";
import { warn } from "../util/log.ts";
import { BBOX } from "../geonames.ts";
import { NOT_LOCAL_RE, busExclusion, readableColor, stopSpanKm, urbanModeOf, type MainBusRule } from "./classify.ts";
import { tripMinutes } from "./transit-extract.ts";
import { EXTRACT_VERSION, TIME_DAYS, UMode, type LonLat, type PatternTimes, type UrbanFeed, type UrbanLine, type UrbanPattern, type UrbanStop } from "./types.ts";

export interface ExtractOptions {
  /** Reference weekday (YYYY-MM-DD) for trips per day. */
  refDate: string;
  coachRe: RegExp;
  /** The intercity network carries this feed's buses from a span on (busExclusion); null for the extra local feeds. */
  mainBus: MainBusRule | null;
  tmpDir: string;
}

/** Routes of one pattern group kept per (route, direction): the most frequent and frequent-enough variants. */
const MAX_VARIANTS = 3;
const VARIANT_SHARE = 0.3;

const round5 = (x: number) => Math.round(x * 1e5) / 1e5;

/** SQL: GTFS time "H:MM[:SS]" (an expression) → seconds, NULL when missing. */
const sec = (col: string) =>
  `try_cast(split_part(trim(${col}), ':', 1) AS INTEGER) * 3600 + try_cast(split_part(trim(${col}), ':', 2) AS INTEGER) * 60 + coalesce(try_cast(split_part(trim(${col}), ':', 3) AS INTEGER), 0)`;

function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Times of a bus pattern from its representative trip's stop times (seconds, null where missing) and the departures
 * of its trips per day type; undefined without usable times or without any departure.
 */
export function patternTimes(seq: { a: number | null; d: number | null }[], deps: number[][] | undefined): PatternTimes | undefined {
  if (!deps || !deps.some((d) => d.length)) return undefined;
  const tm = tripMinutes(seq.map((s) => s.a), seq.map((s) => s.d));
  if (!tm) return undefined;
  const t0 = tm.dep[0]!;
  return { t: tm.arr.map((x, i) => (i ? x - t0 : 0)), deps };
}

/**
 * Extract the local-transport lines of one GTFS zip: per route and direction the most frequent
 * stop sequences (with their shape), the stops they call at and a trips-per-day figure. Needs only a
 * couple of trips per route, so stop_times is filtered down to those before it is read.
 */
export async function extractFeed(db: Db, key: string, zip: string, opt: ExtractOptions): Promise<UrbanFeed | null> {
  const dir = join(opt.tmpDir, `urban-${key.replace(/[^\w.-]/g, "_")}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  try {
    const entries = listZip(zip);
    const find = (name: string) => entries.find((e) => e.split("/").pop()!.toLowerCase() === name && !e.startsWith("__MACOSX"));
    const need = ["routes.txt", "trips.txt", "stop_times.txt", "stops.txt"];
    if (need.some((n) => !find(n))) return null;
    const rPath = extract(zip, find("routes.txt")!, dir);
    const rc = await columns(db, rPath);
    // ---- candidate routes
    await db.run(`DROP TABLE IF EXISTS u_routes; CREATE TEMP TABLE u_routes AS SELECT
        ${c(rc, "route_id")} AS route_id, coalesce(${c(rc, "agency_id")}, '') AS agency_id,
        try_cast(${c(rc, "route_type")} AS INTEGER) AS rtype,
        coalesce(${c(rc, "route_short_name")}, '') AS short, coalesce(${c(rc, "route_long_name")}, '') AS long,
        coalesce(${c(rc, "route_desc")}, '') AS rdesc, ${c(rc, "route_color")} AS color
      FROM ${csv(rPath)} WHERE ${c(rc, "route_id")} IS NOT NULL`);
    const rrows = await db.all<{ route_id: string; agency_id: string; rtype: number | null; short: string; long: string; rdesc: string; color: string | null }>(
      `SELECT * FROM u_routes ORDER BY ALL`,
    );
    const agencyName = new Map<string, string>();
    const aPath = find("agency.txt");
    if (aPath) {
      const ap = extract(zip, aPath, dir);
      const ac = await columns(db, ap);
      for (const a of await db.all<{ id: string; name: string }>(
        `SELECT coalesce(${c(ac, "agency_id")}, '') AS id, coalesce(${c(ac, "agency_name")}, '') AS name FROM ${csv(ap)} ORDER BY ALL`,
      ))
        agencyName.set(a.id, a.name);
    }
    const dropped: Record<string, number> = {};
    const drop = (why: string) => (dropped[why] = (dropped[why] ?? 0) + 1);
    const routes = new Map<string, { mode: number; short: string; long: string; agency: string; color: string }>();
    const singleAgency = agencyName.size === 1 ? [...agencyName.values()][0]! : "";
    for (const r of rrows) {
      if (r.rtype == null) continue;
      const mode = urbanModeOf(r.rtype);
      if (mode == null) continue;
      const agency = agencyName.get(r.agency_id) ?? singleAgency;
      const names = `${r.short} ${r.long} ${r.rdesc}`;
      if (NOT_LOCAL_RE.test(names)) {
        drop("not-local");
        continue;
      }
      if (mode === UMode.Bus && (opt.coachRe.test(agency) || opt.coachRe.test(names))) {
        drop("coach");
        continue;
      }
      routes.set(r.route_id, { mode, short: r.short, long: r.long, agency, color: readableColor(r.color ?? "") });
    }
    if (!routes.size) return null;
    await db.run(`DROP TABLE IF EXISTS u_keep; CREATE TEMP TABLE u_keep(route_id VARCHAR)`);
    await db.insertRows("u_keep", [{ name: "route_id", type: "VARCHAR" }], [...routes.keys()].map((k) => [k]), join(dir, "keep.csv"));

    // ---- trips, active services on the reference day
    const tPath = extract(zip, find("trips.txt")!, dir);
    const tc = await columns(db, tPath);
    await db.run(`DROP TABLE IF EXISTS u_trips; CREATE TEMP TABLE u_trips AS SELECT
        ${c(tc, "route_id")} AS route_id, ${c(tc, "service_id")} AS service_id, ${c(tc, "trip_id")} AS trip_id,
        coalesce(${c(tc, "direction_id")}, '') AS dir, coalesce(${c(tc, "shape_id")}, '') AS shape_id,
        coalesce(${c(tc, "trip_headsign")}, '') AS headsign
      FROM ${csv(tPath)} WHERE ${c(tc, "trip_id")} IS NOT NULL AND ${c(tc, "route_id")} IN (SELECT route_id FROM u_keep)`);
    const ref = opt.refDate;
    // services per day type (TIME_DAYS): the reference Wednesday, the Saturday and the Sunday after it
    const dates = [ref, addDays(ref, 3), addDays(ref, 4)];
    await db.run(`DROP TABLE IF EXISTS u_actd; CREATE TEMP TABLE u_actd(service_id VARCHAR, day INTEGER)`);
    const cal = find("calendar.txt");
    const calPath = cal ? extract(zip, cal, dir) : null;
    const calCols = calPath ? await columns(db, calPath) : null;
    const cd = find("calendar_dates.txt");
    const cdPath = cd ? extract(zip, cd, dir) : null;
    const cdCols = cdPath ? await columns(db, cdPath) : null;
    for (let k = 0; k < dates.length; k++) {
      const date = dates[k]!;
      if (calPath && calCols) {
        const cc = calCols;
        const dow = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
        const wd = dow.map((d) => `coalesce(${c(cc, d)}, '0')`);
        await db.run(`INSERT INTO u_actd SELECT service_id, ${k} FROM (
            SELECT ${c(cc, "service_id")} AS service_id, [${wd.join(", ")}] AS w,
              try_strptime(${c(cc, "start_date")}, '%Y%m%d')::DATE AS s, try_strptime(${c(cc, "end_date")}, '%Y%m%d')::DATE AS e
            FROM ${csv(calPath)}) WHERE DATE '${date}' BETWEEN s AND e AND w[isodow(DATE '${date}')] = '1'`);
      }
      if (cdPath && cdCols) {
        const dc = cdCols;
        await db.run(`DROP TABLE IF EXISTS u_ex; CREATE TEMP TABLE u_ex AS SELECT ${c(dc, "service_id")} AS service_id,
            try_cast(${c(dc, "exception_type")} AS INTEGER) AS t
          FROM ${csv(cdPath)} WHERE try_strptime(${c(dc, "date")}, '%Y%m%d')::DATE = DATE '${date}'`);
        await db.run(`DELETE FROM u_actd WHERE day = ${k} AND service_id IN (SELECT service_id FROM u_ex WHERE t = 2)`);
        await db.run(`INSERT INTO u_actd SELECT DISTINCT service_id, ${k} FROM u_ex WHERE t = 1 AND service_id NOT IN (SELECT service_id FROM u_actd WHERE day = ${k})`);
      }
    }
    await db.run(`DROP TABLE IF EXISTS u_active; CREATE TEMP TABLE u_active AS SELECT DISTINCT service_id FROM u_actd WHERE day = 0`);
    // routes without any active trip on the reference day count all their trips (expired or sparse calendars)
    await db.run(`DROP TABLE IF EXISTS u_trips2; CREATE TEMP TABLE u_trips2 AS
      SELECT t.*, (t.service_id IN (SELECT service_id FROM u_active)) AS act FROM u_trips t`);
    await db.run(`DROP TABLE IF EXISTS u_use; CREATE TEMP TABLE u_use AS
      SELECT t.* FROM u_trips2 t WHERE t.act OR t.route_id NOT IN (SELECT route_id FROM u_trips2 WHERE act)`);
    // ---- pattern groups: per route and direction the most frequent shape (or headsign)
    const groups = await db.all<{ route_id: string; dir: string; g: string; n: number; rep: string; shape_id: string; headsign: string }>(
      `SELECT route_id, dir, CASE WHEN shape_id <> '' THEN shape_id ELSE headsign END AS g, count(*) AS n, min(trip_id) AS rep,
          min(shape_id) AS shape_id, min(headsign) AS headsign
        FROM u_use GROUP BY route_id, dir, g ORDER BY route_id, dir, g`,
    );
    const perRoute = new Map<string, typeof groups>();
    for (const g of groups) {
      let a = perRoute.get(g.route_id);
      if (!a) perRoute.set(g.route_id, (a = []));
      a.push(g);
    }
    const chosen: { route: string; dir: string; g: string; n: number; rep: string; shape: string }[] = [];
    const tpdOf = new Map<string, number>();
    for (const [rid, gs] of perRoute) {
      const byDir = new Map<string, typeof groups>();
      for (const g of gs) {
        let a = byDir.get(g.dir);
        if (!a) byDir.set(g.dir, (a = []));
        a.push(g);
      }
      let tpd = 0;
      for (const [dir, ds] of byDir) {
        ds.sort((a, b) => b.n - a.n || (a.g < b.g ? -1 : a.g > b.g ? 1 : 0));
        const total = ds.reduce((s, x) => s + x.n, 0);
        tpd = Math.max(tpd, byDir.size === 1 && dir === "" ? total / 2 : total);
        ds.slice(0, MAX_VARIANTS).forEach((g, i) => {
          if (i === 0 || g.n >= VARIANT_SHARE * ds[0]!.n) chosen.push({ route: rid, dir, g: g.g, n: g.n, rep: g.rep, shape: g.shape_id });
        });
      }
      tpdOf.set(rid, Math.round(tpd * 10) / 10);
    }
    if (!chosen.length) return null;
    await db.run(`DROP TABLE IF EXISTS u_rep; CREATE TEMP TABLE u_rep(trip_id VARCHAR, ix INTEGER)`);
    await db.insertRows("u_rep", [{ name: "trip_id", type: "VARCHAR" }, { name: "ix", type: "INTEGER" }], chosen.map((x, i) => [x.rep, i]), join(dir, "rep.csv"));

    // ---- stop_times of the representative trips (with their times), and the first departure of every trip of a
    // chosen bus pattern on the three day types (PatternTimes: station changes by bus)
    const sPath = extract(zip, find("stop_times.txt")!, dir);
    const sc = await columns(db, sPath);
    await db.run(`DROP TABLE IF EXISTS u_st; CREATE TEMP TABLE u_st AS
      SELECT r.ix, try_cast(${c(sc, "stop_sequence")} AS INTEGER) AS seq, ${c(sc, "stop_id")} AS stop_id,
        ${sec(c(sc, "arrival_time"))} AS a, ${sec(c(sc, "departure_time"))} AS d
      FROM ${csv(sPath)} st JOIN u_rep r ON r.trip_id = ${c(sc, "trip_id", "NULL::VARCHAR", "st")}
      WHERE ${c(sc, "stop_id")} IS NOT NULL`);
    const busChosen = chosen.flatMap((x, ix) => (routes.get(x.route)!.mode === UMode.Bus ? [[x.route, x.dir, x.g, ix]] : []));
    const deps = new Map<number, number[][]>();
    if (busChosen.length) {
      // the chosen bus patterns with the first and last stop of their representative trip
      // (empty strings come back from the CSV import as NULL)
      await db.run(`DROP TABLE IF EXISTS u_bch0; CREATE TEMP TABLE u_bch0(route_id VARCHAR, dir VARCHAR, g VARCHAR, ix INTEGER)`);
      await db.insertRows("u_bch0", [{ name: "route_id", type: "VARCHAR" }, { name: "dir", type: "VARCHAR" }, { name: "g", type: "VARCHAR" }, { name: "ix", type: "INTEGER" }], busChosen, join(dir, "bch.csv"));
      await db.run(`DROP TABLE IF EXISTS u_bch; CREATE TEMP TABLE u_bch AS
        SELECT b.route_id, coalesce(b.dir, '') AS dir, coalesce(b.g, '') AS g, b.ix, e.f, e.l FROM u_bch0 b
        LEFT JOIN (SELECT ix, arg_min(stop_id, seq) AS f, arg_max(stop_id, seq) AS l FROM u_st GROUP BY ix) e USING (ix)`);
      // every trip of these routes on the three day types, with its first departure and first / last stop
      await db.run(`DROP TABLE IF EXISTS u_btrips; CREATE TEMP TABLE u_btrips AS
        SELECT t.trip_id, min(t.route_id) AS route_id, min(t.dir) AS dir, min(CASE WHEN t.shape_id <> '' THEN t.shape_id ELSE t.headsign END) AS g,
          bit_or(1 << a.day) AS mask
        FROM u_trips t JOIN u_actd a USING (service_id)
        WHERE t.route_id IN (SELECT route_id FROM u_bch) GROUP BY t.trip_id`);
      await db.run(`DROP TABLE IF EXISTS u_first; CREATE TEMP TABLE u_first AS
        SELECT ${c(sc, "trip_id", "NULL::VARCHAR", "st")} AS trip_id,
          arg_min(coalesce(${sec(c(sc, "departure_time", "NULL::VARCHAR", "st"))}, ${sec(c(sc, "arrival_time", "NULL::VARCHAR", "st"))}), try_cast(${c(sc, "stop_sequence", "NULL::VARCHAR", "st")} AS INTEGER)) AS s,
          arg_min(${c(sc, "stop_id", "NULL::VARCHAR", "st")}, try_cast(${c(sc, "stop_sequence", "NULL::VARCHAR", "st")} AS INTEGER)) AS f,
          arg_max(${c(sc, "stop_id", "NULL::VARCHAR", "st")}, try_cast(${c(sc, "stop_sequence", "NULL::VARCHAR", "st")} AS INTEGER)) AS l
        FROM ${csv(sPath)} st WHERE ${c(sc, "trip_id", "NULL::VARCHAR", "st")} IN (SELECT trip_id FROM u_btrips) GROUP BY 1`);
      // a trip belongs to the chosen pattern of its group, else to one of its route and direction with the same
      // first and last stop (a weekend trip under another shape id); other variants are left out
      await db.run(`CREATE OR REPLACE TEMP TABLE u_btrips AS
        SELECT b.trip_id, coalesce(m1.ix, m2.ix) AS ix, b.mask, f.s FROM u_btrips b JOIN u_first f USING (trip_id)
        LEFT JOIN u_bch m1 ON m1.route_id = b.route_id AND m1.dir = b.dir AND m1.g = b.g
        LEFT JOIN (SELECT route_id, dir, f, l, min(ix) AS ix FROM u_bch GROUP BY ALL) m2
          ON m2.route_id = b.route_id AND m2.dir = b.dir AND m2.f = f.f AND m2.l = f.l
        WHERE coalesce(m1.ix, m2.ix) IS NOT NULL AND f.s IS NOT NULL`);
      // frequency-based trips: a departure per headway from start to end
      const freq = new Map<string, [number, number, number][]>();
      const fEntry = find("frequencies.txt");
      if (fEntry) {
        const fp = extract(zip, fEntry, dir);
        const fc = await columns(db, fp);
        for (const r of await db.all<{ id: string; s: number | null; e: number | null; h: number | null }>(
          `SELECT ${c(fc, "trip_id")} AS id, ${sec(c(fc, "start_time"))} AS s, ${sec(c(fc, "end_time"))} AS e, try_cast(${c(fc, "headway_secs")} AS INTEGER) AS h
           FROM ${csv(fp)} WHERE ${c(fc, "trip_id")} IN (SELECT trip_id FROM u_btrips) ORDER BY ALL`,
        )) {
          if (r.s == null || r.e == null || !r.h || r.h <= 0) continue;
          let a = freq.get(r.id);
          if (!a) freq.set(r.id, (a = []));
          a.push([r.s, r.e, r.h]);
        }
      }
      await db.stream(`SELECT trip_id, ix, mask, s FROM u_btrips`, (cols, n) => {
        for (let r = 0; r < n; r++) {
          const ix = cols[1]![r] as number, mask = Number(cols[2]![r]);
          let d = deps.get(ix);
          if (!d) deps.set(ix, (d = Array.from({ length: TIME_DAYS }, () => [])));
          const fr = freq.get(cols[0]![r] as string);
          const starts: number[] = [];
          if (fr) for (const [s0, e0, h] of fr) for (let t = s0; t < e0; t += h) starts.push(Math.floor(t / 60));
          else starts.push(Math.floor(Number(cols[3]![r]) / 60));
          for (let k = 0; k < TIME_DAYS; k++) if (mask & (1 << k)) d[k]!.push(...starts);
        }
      });
      for (const d of deps.values()) for (const x of d) x.sort((a, b) => a - b);
    }
    await rm(sPath, { force: true });
    // ---- stops
    const spPath = extract(zip, find("stops.txt")!, dir);
    const sp = await columns(db, spPath);
    await db.run(`DROP TABLE IF EXISTS u_stops; CREATE TEMP TABLE u_stops AS SELECT
        ${c(sp, "stop_id")} AS stop_id, coalesce(${c(sp, "stop_name")}, '') AS name,
        try_cast(${c(sp, "stop_lat")} AS DOUBLE) AS lat, try_cast(${c(sp, "stop_lon")} AS DOUBLE) AS lon,
        coalesce(${c(sp, "parent_station")}, '') AS parent
      FROM ${csv(spPath)} WHERE ${c(sp, "stop_id")} IS NOT NULL`);
    await db.run(`DELETE FROM u_stops WHERE lat IS NULL OR lon IS NULL OR lat NOT BETWEEN ${BBOX.minLat} AND ${BBOX.maxLat} OR lon NOT BETWEEN ${BBOX.minLon} AND ${BBOX.maxLon}`);
    // duplicate stop_ids: keep one by content (rowid is not file order, CSV scans run in parallel)
    await db.run(`CREATE OR REPLACE TEMP TABLE u_stops AS SELECT * EXCLUDE (rn) FROM (
        SELECT *, row_number() OVER (PARTITION BY stop_id ORDER BY name, lat, lon, parent) AS rn FROM u_stops) WHERE rn = 1`);
    const stopRows = await db.all<{ ix: number; seq: number; stop_id: string; name: string; lat: number; lon: number; parent: string; a: number | null; d: number | null }>(
      `SELECT st.ix, st.seq, st.stop_id, s.name, s.lat, s.lon, s.parent, st.a, st.d FROM u_st st JOIN u_stops s USING (stop_id) ORDER BY st.ix, st.seq`,
    );
    const seqOf = new Map<number, typeof stopRows>();
    for (const r of stopRows) {
      let a = seqOf.get(r.ix);
      if (!a) seqOf.set(r.ix, (a = []));
      a.push(r);
    }
    // ---- shapes of the chosen trips
    const shapeIds = [...new Set(chosen.map((x) => x.shape).filter(Boolean))];
    const shapes = new Map<string, LonLat[]>();
    const shEntry = find("shapes.txt");
    if (shapeIds.length && shEntry) {
      const shPath = extract(zip, shEntry, dir);
      const hc = await columns(db, shPath);
      await db.run(`DROP TABLE IF EXISTS u_shid; CREATE TEMP TABLE u_shid(shape_id VARCHAR)`);
      await db.insertRows("u_shid", [{ name: "shape_id", type: "VARCHAR" }], shapeIds.map((s) => [s]), join(dir, "shid.csv"));
      const rows = await db.all<{ sid: string; lat: number; lon: number }>(
        `SELECT ${c(hc, "shape_id", "NULL::VARCHAR", "sh")} AS sid, try_cast(${c(hc, "shape_pt_lat")} AS DOUBLE) AS lat, try_cast(${c(hc, "shape_pt_lon")} AS DOUBLE) AS lon
         FROM ${csv(shPath)} sh WHERE ${c(hc, "shape_id", "NULL::VARCHAR", "sh")} IN (SELECT shape_id FROM u_shid)
         ORDER BY sid, try_cast(${c(hc, "shape_pt_sequence")} AS INTEGER)`,
      );
      for (const r of rows) {
        if (r.lat == null || r.lon == null || r.lat < BBOX.minLat || r.lat > BBOX.maxLat) continue;
        let a = shapes.get(r.sid);
        if (!a) shapes.set(r.sid, (a = []));
        a.push([r.lon, r.lat]);
      }
    }

    // ---- assemble lines
    const feedStops: UrbanStop[] = [];
    const stopIdx = new Map<string, number>();
    const stopOf = (r: { stop_id: string; name: string; lat: number; lon: number; parent: string }) => {
      let i = stopIdx.get(r.stop_id);
      if (i === undefined) {
        i = feedStops.length;
        stopIdx.set(r.stop_id, i);
        feedStops.push({ id: r.stop_id, name: r.name, lon: round5(r.lon), lat: round5(r.lat), parent: r.parent });
      }
      return i;
    };
    // bus routes: decided per route on its longest pattern (busExclusion), so a route is drawn by one layer only
    const busSpan = new Map<string, number>();
    chosen.forEach((ch, ix) => {
      const seq = seqOf.get(ix);
      if (routes.get(ch.route)!.mode === UMode.Bus && seq && seq.length >= 2) busSpan.set(ch.route, Math.max(busSpan.get(ch.route) ?? 0, stopSpanKm(seq)));
    });
    const busOut = new Set<string>();
    for (const [rid, span] of busSpan) {
      const why = busExclusion(span, routes.get(rid)!.agency, opt.mainBus);
      if (why) {
        drop(why);
        busOut.add(rid);
      }
    }
    const lines = new Map<string, UrbanLine>();
    let shaped = 0;
    chosen.forEach((ch, ix) => {
      const seq = seqOf.get(ix);
      if (!seq || seq.length < 2 || busOut.has(ch.route)) return;
      const r = routes.get(ch.route)!;
      const sh = ch.shape ? shapes.get(ch.shape) : undefined;
      let coords: LonLat[];
      let geom: UrbanPattern["geom"];
      if (sh && sh.length >= 2) {
        coords = simplifyLine(sh, 3).map(([x, y]) => [round5(x), round5(y)]);
        geom = "shape";
        shaped++;
      } else {
        coords = seq.map((s) => [round5(s.lon), round5(s.lat)] as LonLat);
        geom = "stops";
      }
      let line = lines.get(ch.route);
      if (!line) {
        const first = seq[0]!.name, last = seq[seq.length - 1]!.name;
        line = {
          mode: r.mode as UrbanLine["mode"],
          name: (r.short || r.long).slice(0, 12),
          desc: (r.short && r.long ? r.long : first && last && first !== last ? `${first} – ${last}` : "").slice(0, 90),
          agency: r.agency.slice(0, 60),
          color: r.color,
          tpd: tpdOf.get(ch.route) ?? 0,
          patterns: [],
        };
        lines.set(ch.route, line);
      }
      const times = r.mode === UMode.Bus ? patternTimes(seq, deps.get(ix)) : undefined;
      line.patterns.push({ coords, stops: seq.map(stopOf), trips: ch.n, geom, ...(times ? { times } : {}) });
    });
    const out: UrbanFeed = {
      key,
      version: EXTRACT_VERSION,
      lines: [...lines.values()],
      stops: feedStops,
      stats: { routes: routes.size, kept: lines.size, shaped, dropped },
    };
    return out;
  } catch (e) {
    warn(`urban ${key}: ${(e as Error).message.slice(0, 300)}`);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
    void sqlStr;
  }
}
