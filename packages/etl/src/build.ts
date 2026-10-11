import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  Cat,
  Flag,
  SCHEMA_VERSION,
  type AttributionFile,
  type CalendarsFile,
  type City,
  type CityFile,
  type Corridor,
  type Manifest,
  type NetworkFile,
  type NetworkPart,
  type Pattern,
  type Route,
  type Station,
  type Trip,
  type CatBit,
} from "@etbm/shared";
import type { Db } from "./db.ts";
import type { FeedsConfig, ResolvedFeed } from "./feeds.ts";
import type { FeedLoadStats } from "./gtfs/load.ts";
import type { CliArgs } from "./cli.ts";
import { BBOX, loadPlaces } from "./geonames.ts";
import { assignStops, chooseCityName, resolveSatellites, townFromStopName, type Place } from "./core/cities.ts";
import { describeStation, mergeStations, walkMinutes, type StopIn } from "./core/stations.ts";
import { MaskStore, getBit, newMask, popcount, setBit } from "./core/calendar.ts";
import { isoToEpochDay, tzOffsetMinutes, validTz } from "./core/time.ts";
import { resolveDuplicates, type DupPair, type DupTrip } from "./core/dedup.ts";
import { PatternStore, localizeStart, processTripStops, type RawStop } from "./core/patterns.ts";
import { displayName } from "./core/classify.ts";
import { sliceShape } from "./core/shapes.ts";
import { GridIndex, fastDist, greatCircle, haversine, round5, simplifyLine, type LonLat } from "./util/geo.ts";
import { log, warn, type StageTimer } from "./util/log.ts";
import { runSanity } from "./sanity.ts";

export interface BuildCtx {
  db: Db;
  args: CliArgs;
  cfg: FeedsConfig;
  feeds: ResolvedFeed[];
  feedStats: FeedLoadStats[];
  failed: string[];
  licenses: unknown[];
  timer: StageTimer;
  cacheDir: string;
  tmpDir: string;
  t0: number;
}

interface CityRec {
  place: number; // index into places, -1 synthetic
  name: string;
  country: string;
  lon: number;
  lat: number;
  population: number;
  tz: string;
  stopNames: string[];
  synthetic: boolean;
}

interface StationRec {
  city: number;
  name: string;
  lon: number;
  lat: number;
  cats: number;
  rail: boolean;
  weight: number;
}

const CAT_BITS: CatBit[] = [Cat.LongDistance, Cat.Regional, Cat.Coach, Cat.Bus];
const CAT_NAMES: Record<number, string> = { 1: "LongDistance", 2: "Regional", 4: "Coach", 8: "Bus" };

export async function runBuild(ctx: BuildCtx): Promise<void> {
  const { db, args, cfg, timer } = ctx;
  const D = args.days;
  const startDay = isoToEpochDay(args.startDate);
  const stats: Record<string, number> = {};
  const report: Record<string, unknown> = { args: { ...args }, feeds: ctx.feedStats, failedFeeds: ctx.failed };

  // ------------------------------------------------------------------ categories
  timer.start("categories");
  await db.run(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS cat INTEGER; ALTER TABLE trips ADD COLUMN IF NOT EXISTS flags INTEGER;`);
  await db.run(`UPDATE trips SET cat = rc.cat, flags = rc.flags FROM rclass rc WHERE trips.rc = rc.rc`);
  await db.run(`UPDATE trips SET cat = x.c FROM (
      SELECT st.trip_key,
        CASE WHEN (span >= 100 AND span / greatest(1, n - 1) >= 18) OR (span >= 250 AND dur >= 150) THEN ${Cat.LongDistance} ELSE ${Cat.Regional} END AS c
      FROM (SELECT st.trip_key, count(*) AS n, max(st.arr) - min(st.dep) AS dur,
              sqrt(pow((max(s.lat) - min(s.lat)) * 111.2, 2) + pow((max(s.lon) - min(s.lon)) * 111.2 * cos(radians(avg(s.lat))), 2)) AS span
            FROM stop_times st JOIN stops s USING (stop_key)
            WHERE st.trip_key IN (SELECT trip_key FROM trips WHERE cat IS NULL) GROUP BY st.trip_key) st
    ) x WHERE trips.trip_key = x.trip_key`);
  await db.run(`DELETE FROM trips WHERE cat IS NULL`);

  // ------------------------------------------------------------------ cities
  timer.start("cities");
  const places = await loadPlaces(ctx.cacheDir, cfg.userAgent);
  resolveSatellites(places, { "TR:Istanbul": 50, "TR:Ankara": 30, "RU:Moscow": 40 });
  const stopRows = await db.all<{
    stop_key: number; feed: number; name: string; lat: number; lon: number; parent_key: number | null; tz: string | null; cats: number; rail: boolean; n: number;
  }>(`SELECT s.stop_key, s.feed, s.name, s.lat, s.lon, s.parent_key, s.tz, u.cats, u.rail, u.n
      FROM stops s JOIN (
        SELECT st.stop_key, bit_or(t.cat) AS cats, bool_or(rc.cls = 'rail') AS rail, count(*)::INTEGER AS n
        FROM stop_times st JOIN trips t USING (trip_key) JOIN rclass rc USING (rc) GROUP BY st.stop_key
      ) u USING (stop_key)
      WHERE s.lat BETWEEN ${BBOX.minLat} AND ${BBOX.maxLat} AND s.lon BETWEEN ${BBOX.minLon} AND ${BBOX.maxLon}`);
  // Use the parent station's coordinates for city assignment when available (keeps platforms together).
  const parentPos = new Map<number, { lat: number; lon: number }>();
  for (const r of await db.all<{ stop_key: number; lat: number; lon: number }>(
    `SELECT stop_key, lat, lon FROM stops WHERE stop_key IN (SELECT DISTINCT parent_key FROM stops WHERE parent_key IS NOT NULL)`,
  ))
    if (r.lat && r.lon) parentPos.set(r.stop_key, r);
  log(`${stopRows.length} used stops`);
  const assignPts = stopRows.map((s) => (s.parent_key != null && parentPos.get(s.parent_key)) || s);
  const placeOf = assignStops(places, assignPts);

  const cities: CityRec[] = [];
  const cityOfPlace = new Map<number, number>();
  const stopCity = new Int32Array(stopRows.length).fill(-1);
  for (let i = 0; i < stopRows.length; i++) {
    const p = placeOf[i]!;
    if (p < 0) continue;
    let c = cityOfPlace.get(p);
    if (c === undefined) {
      const pl = places[p]!;
      c = cities.length;
      cityOfPlace.set(p, c);
      cities.push({
        place: p, name: pl.name, country: pl.country, lon: pl.lon, lat: pl.lat, population: pl.population, tz: pl.tz, stopNames: [], synthetic: false,
      });
    }
    stopCity[i] = c;
  }
  // Synthetic cities for unassigned stops: cluster within 2 km.
  const placeIdx = new GridIndex(places.map((p) => p.lon), places.map((p) => p.lat), 0.5);
  const synth: { lon: number; lat: number; city: number }[] = [];
  const synthGrid = new Map<string, number[]>();
  const sk = (lon: number, lat: number) => `${Math.floor(lon / 0.05)},${Math.floor(lat / 0.05)}`;
  let nSynth = 0;
  const unassigned = [...Array(stopRows.length).keys()].filter((i) => stopCity[i]! < 0).sort((a, b) => stopRows[b]!.n - stopRows[a]!.n);
  for (const i of unassigned) {
    const s = assignPts[i]!;
    let found = -1;
    const cx = Math.floor(s.lon / 0.05), cy = Math.floor(s.lat / 0.05);
    for (let dx = -1; dx <= 1 && found < 0; dx++)
      for (let dy = -1; dy <= 1 && found < 0; dy++)
        for (const j of synthGrid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (fastDist(s.lon, s.lat, synth[j]!.lon, synth[j]!.lat) <= 2000) {
            found = synth[j]!.city;
            break;
          }
        }
    if (found < 0) {
      // nearest real place for country / tz
      let near: Place | undefined;
      for (const r of [20_000, 80_000, 250_000]) {
        const c = placeIdx.within(s.lon, s.lat, r);
        if (c.length) {
          let bd = Infinity;
          for (const j of c) {
            const d = fastDist(s.lon, s.lat, places[j]!.lon, places[j]!.lat);
            if (d < bd) {
              bd = d;
              near = places[j];
            }
          }
          break;
        }
      }
      found = cities.length;
      nSynth++;
      cities.push({
        place: -1,
        name: townFromStopName(stopRows[i]!.name),
        country: near?.country ?? "XX",
        lon: s.lon,
        lat: s.lat,
        population: 0,
        tz: validTz(stopRows[i]!.tz) ?? near?.tz ?? "Europe/Berlin",
        stopNames: [],
        synthetic: true,
      });
      synth.push({ lon: s.lon, lat: s.lat, city: found });
      const k = sk(s.lon, s.lat);
      const arr = synthGrid.get(k) ?? [];
      arr.push(synth.length - 1);
      synthGrid.set(k, arr);
    }
    stopCity[i] = found;
  }
  // Name matching uses rail stop names (or regional bus names); coach-only stops (often English names) are ignored.
  const railNames: string[][] = cities.map(() => []);
  for (let i = 0; i < stopRows.length; i++) {
    const c = cities[stopCity[i]!]!;
    const r = stopRows[i]!;
    if (r.rail && railNames[stopCity[i]!]!.length < 200) railNames[stopCity[i]!]!.push(r.name);
    else if (r.cats & Cat.Bus && c.stopNames.length < 100) c.stopNames.push(r.name);
  }
  for (let ci = 0; ci < cities.length; ci++) {
    const c = cities[ci]!;
    if (railNames[ci]!.length) c.stopNames = railNames[ci]!;
    if (c.synthetic) continue;
    const pl = places[c.place]!;
    const cands = [...(pl.altNames ?? []), pl.name];
    c.name = c.stopNames.length ? chooseCityName(cands, c.stopNames) : cands[0]!;
  }
  log(`${cities.length} cities (${nSynth} synthetic)`);

  // ------------------------------------------------------------------ stations
  timer.start("stations");
  const stopIns: StopIn[] = stopRows.map((s, i) => ({
    lon: s.lon,
    lat: s.lat,
    name: s.name,
    rail: !!s.rail,
    parent: s.parent_key != null ? `${s.parent_key}` : null,
    feed: s.feed,
    city: stopCity[i]!,
    weight: s.n,
  }));
  const { stationOf, count: nStations } = mergeStations(stopIns);
  const members: number[][] = Array.from({ length: nStations }, () => []);
  for (let i = 0; i < stopIns.length; i++) members[stationOf[i]!]!.push(i);
  const stations: StationRec[] = members.map((m) => {
    const ms = m.map((i) => stopIns[i]!);
    const d = describeStation(ms, cities[ms[0]!.city]!.name);
    return {
      city: ms[0]!.city,
      name: d.name,
      lon: d.lon,
      lat: d.lat,
      cats: ms.reduce((a, s, k) => a | stopRows[m[k]!]!.cats, 0),
      rail: ms.some((s) => s.rail),
      weight: ms.reduce((a, s) => a + s.weight, 0),
    };
  });
  log(`${nStations} stations from ${stopIns.length} stops`);
  await db.run(`DROP TABLE IF EXISTS stop_map`);
  await db.insertRows(
    "stop_map",
    [{ name: "stop_key", type: "INTEGER" }, { name: "station", type: "INTEGER" }, { name: "city", type: "INTEGER" }],
    stopRows.map((s, i) => [s.stop_key, stationOf[i], stopCity[i]]),
    join(ctx.tmpDir, "stop_map.csv"),
  );

  // ------------------------------------------------------------------ calendars
  timer.start("calendars");
  // Internal masks cover days -1..D (bit j ↔ day j-1).
  const DI = D + 2;
  const svcMask = new Map<number, Uint8Array>();
  await db.stream(`SELECT service_key, list(day ORDER BY day) AS days FROM service_days GROUP BY service_key`, (cols, n) => {
    for (let r = 0; r < n; r++) {
      const m = newMask(DI);
      for (const d of cols[1]![r] as number[]) if (d >= -1 && d <= D) setBit(m, d + 1);
      svcMask.set(cols[0]![r] as number, m);
    }
  });
  log(`${svcMask.size} services`);

  // ------------------------------------------------------------------ trip metadata
  const maxTrip = await db.scalar(`SELECT coalesce(max(trip_key), 0) FROM trips`);
  const tRc = new Int32Array(maxTrip + 1).fill(-1);
  const tSvc = new Int32Array(maxTrip + 1);
  const tShape = new Int32Array(maxTrip + 1).fill(-1);
  const tCat = new Uint8Array(maxTrip + 1);
  const tFlags = new Uint8Array(maxTrip + 1);
  const tFeed = new Int16Array(maxTrip + 1);
  const tFreq = new Uint8Array(maxTrip + 1);
  const tHead: (string | null)[] = new Array(maxTrip + 1).fill(null);
  const tShort: (string | null)[] = new Array(maxTrip + 1).fill(null);
  await db.stream(`SELECT trip_key, rc, service_key, shape_key, cat, flags, feed, has_freq, headsign, short_name FROM trips`, (c, n) => {
    for (let r = 0; r < n; r++) {
      const k = c[0]![r] as number;
      tRc[k] = c[1]![r] as number;
      tSvc[k] = c[2]![r] as number;
      tShape[k] = (c[3]![r] as number | null) ?? -1;
      tCat[k] = c[4]![r] as number;
      tFlags[k] = (c[5]![r] as number) ?? 0;
      tFeed[k] = c[6]![r] as number;
      tFreq[k] = c[7]![r] ? 1 : 0;
      tHead[k] = (c[8]![r] as string | null) ?? null;
      tShort[k] = (c[9]![r] as string | null) ?? null;
    }
  });
  const rclass = new Map<number, { cls: string; agency: string; short: string; long: string; color: string | null; tz: string; pname: string | null }>();
  for (const r of await db.all<{ rc: number; cls: string; agency: string; route_short: string; route_long: string; color: string | null; tz: string; pname: string | null }>(
    `SELECT rc, cls, agency, route_short, route_long, color, tz, pname FROM rclass`,
  ))
    rclass.set(r.rc, { cls: r.cls, agency: r.agency ?? "", short: r.route_short ?? "", long: r.route_long ?? "", color: r.color, tz: r.tz, pname: r.pname });
  const feedPriority = new Map<number, number>();
  for (const r of await db.all<{ feed: number; priority: number }>(`SELECT feed, priority FROM feeds`)) feedPriority.set(r.feed, r.priority);

  // ------------------------------------------------------------------ cross-feed dedup
  timer.start("dedup");
  const tzList = [...new Set([...rclass.values()].map((r) => r.tz))];
  await db.run(`DROP TABLE IF EXISTS tzoff`);
  await db.insertRows(
    "tzoff",
    [{ name: "tz", type: "VARCHAR" }, { name: "off", type: "INTEGER" }],
    tzList.map((tz) => [tz, tz === "UTC" ? 0 : tzOffsetMinutes(tz, startDay)]),
    join(ctx.tmpDir, "tzoff.csv"),
  );
  await db.run(`CREATE OR REPLACE TEMP TABLE ev AS
    SELECT st.trip_key, t.feed, rc.cls = 'rail' AS rail, m.city, (st.dep - z.off)::INTEGER AS u
    FROM stop_times st JOIN trips t USING (trip_key) JOIN rclass rc USING (rc) JOIN stop_map m USING (stop_key) JOIN tzoff z ON z.tz = rc.tz
    WHERE rc.cls IN ('rail', 'coach') AND NOT t.has_freq`);
  await db.run(`CREATE OR REPLACE TEMP TABLE ev2 AS SELECT * FROM ev WHERE city IN (
      SELECT city FROM ev GROUP BY city HAVING count(DISTINCT feed) >= 2)`);
  const pairRows = await db.all<{ ta: number; tb: number; n: number }>(`
    SELECT a.trip_key AS ta, b.trip_key AS tb, count(DISTINCT a.city)::INTEGER AS n
    FROM ev2 a JOIN (SELECT ev2.*, d FROM ev2, (VALUES (-2), (-1), (0), (1), (2)) v(d)) b
      ON a.city = b.city AND a.rail = b.rail AND a.u = b.u + b.d AND a.feed < b.feed
    GROUP BY ALL HAVING count(DISTINCT a.city) >= 2`);
  await db.run(`DROP TABLE IF EXISTS ev; DROP TABLE IF EXISTS ev2;`);
  const dupTripKeys = new Set<number>();
  for (const p of pairRows) {
    dupTripKeys.add(p.ta);
    dupTripKeys.add(p.tb);
  }
  const dupInfo = new Map<number, DupTrip>();
  if (dupTripKeys.size) {
    await db.run(`DROP TABLE IF EXISTS dupkeys`);
    await db.insertRows("dupkeys", [{ name: "trip_key", type: "INTEGER" }], [...dupTripKeys].map((k) => [k]), join(ctx.tmpDir, "dupkeys.csv"));
    for (const r of await db.all<{ trip_key: number; nc: number; dur: number }>(`
      SELECT st.trip_key, count(DISTINCT m.city)::INTEGER AS nc, (max(st.arr) - min(st.dep))::INTEGER AS dur
      FROM stop_times st JOIN stop_map m USING (stop_key) WHERE st.trip_key IN (SELECT trip_key FROM dupkeys) GROUP BY st.trip_key`)) {
      const k = r.trip_key;
      const rc = rclass.get(tRc[k]!);
      dupInfo.set(k, {
        key: k,
        cities: r.nc,
        duration: r.dur,
        priority: feedPriority.get(tFeed[k]!) ?? 0,
        mask: svcMask.get(tSvc[k]!) ?? newMask(DI),
        number: tShort[k] ?? (rc ? displayName(rc.short, rc.long, "", rc.agency).number : null),
      });
    }
  }
  const pairs: DupPair[] = pairRows.map((p) => ({ a: p.ta, b: p.tb, shared: p.n }));
  const { dropped, extraMask } = resolveDuplicates(pairs, dupInfo);
  log(`dedup: ${pairRows.length} candidate pairs, ${dropped.size} trips dropped as cross-feed duplicates`);
  stats.dedupDropped = dropped.size;

  // ------------------------------------------------------------------ patterns
  timer.start("patterns");
  const freq = new Map<number, { s: number; e: number; h: number }[]>();
  for (const r of await db.all<{ trip_key: number; start_min: number; end_min: number; headway_s: number }>(`SELECT * FROM frequencies`)) {
    let a = freq.get(r.trip_key);
    if (!a) freq.set(r.trip_key, (a = []));
    a.push({ s: r.start_min, e: r.end_min, h: r.headway_s });
  }
  const timezones: string[] = [];
  const tzIndex = new Map<string, number>();
  const tzId = (tz: string) => {
    let i = tzIndex.get(tz);
    if (i === undefined) {
      i = timezones.length;
      timezones.push(tz);
      tzIndex.set(tz, i);
    }
    return i;
  };
  const routes: Route[] = [];
  const routeIndex = new Map<string, number>();
  const store = new PatternStore();
  const masks = new MaskStore();
  const tripP: number[] = [], tripS: number[] = [], tripC: number[] = [];
  const tripN: (string | undefined)[] = [];
  let patternDays: number[] = [];
  const stationWeight = (s: number) => stations[s]!.weight;
  const cityPop = (c: number) => cities[c]!.population;
  let droppedTrips = 0;

  // Bus-only stops in towns below 100k inhabitants are represented by one station per town
  // (the most served one) to keep the network small; big cities keep their individual stops.
  const busCanon = new Int32Array(cities.length).fill(-1);
  for (let st = 0; st < stations.length; st++) {
    const s = stations[st]!;
    if (s.cats !== Cat.Bus || cities[s.city]!.population >= 100_000) continue;
    const cur = busCanon[s.city]!;
    if (cur < 0 || stations[cur]!.weight < s.weight) busCanon[s.city] = st;
  }
  const isShared = (st: number) => stations[st]!.cats !== Cat.Bus;
  const finalize = (tk: number, raw: RawStop[]) => {
    if (dropped.has(tk)) return;
    const rc = rclass.get(tRc[tk]!);
    if (!rc) return;
    const cat = tCat[tk]!;
    if (cat === Cat.Bus)
      for (const r of raw) {
        const c = busCanon[r.city]!;
        if (c >= 0 && stations[r.station]!.cats === Cat.Bus) r.station = c;
      }
    const shape = processTripStops(raw, { cat, cityPop, stationWeight, isShared, minBusCityPop: cfg.minBusCityPop ?? 1000 });
    if (!shape) {
      droppedTrips++;
      return;
    }
    const dn = rc.pname ? { name: rc.pname, number: tShort[tk] ?? undefined } : displayName(rc.short, rc.long, tShort[tk] ?? "", rc.agency);
    let flags = tFlags[tk]!;
    // Deutschlandticket only applies to services that run in Germany.
    if (flags & Flag.DTicket && !shape.cities.some((c) => cities[c]!.country === "DE")) flags &= ~Flag.DTicket;
    const color = rc.color && /^[0-9a-fA-F]{6}$/.test(rc.color) ? rc.color.toUpperCase() : undefined;
    const rkey = `${dn.name}\u0001${rc.agency}\u0001${cat}\u0001${flags}\u0001${color ?? ""}`;
    let route = routeIndex.get(rkey);
    if (route === undefined) {
      route = routes.length;
      const r: Route = { name: dn.name, agency: rc.agency, cat: cat as CatBit, flags };
      if (color) r.color = color;
      routes.push(r);
      routeIndex.set(rkey, route);
    }
    const utc = rc.tz === "UTC";
    const tz = utc ? cities[shape.cities[0]!]!.tz : rc.tz;
    const headsign = (tHead[tk] ?? "").trim() || stations[shape.stations[shape.stations.length - 1]!]!.name;
    const pid = store.add({
      route,
      stations: shape.stations,
      cities: shape.cities,
      arr: shape.arr,
      dep: shape.dep,
      headsign,
      tz: tzId(tz),
      shapeTrip: tShape[tk]! >= 0 ? tk : -1,
    });
    const base = extraMask.get(tk) ?? svcMask.get(tSvc[tk]!);
    if (!base) return;
    let starts = [shape.start];
    const fr = freq.get(tk);
    if (fr) {
      starts = [];
      for (const f of fr) for (let s = f.s * 60; s < f.e * 60 && starts.length < 2000; s += f.h) starts.push(Math.floor(s / 60));
    }
    for (const s of starts) {
      const variants: { start: number; m: Uint8Array }[] = [];
      if (utc) {
        const days: number[] = [];
        for (let j = 0; j < DI; j++) if (getBit(base, j)) days.push(j - 1);
        for (const g of localizeStart(s, days, (d) => tzOffsetMinutes(tz, startDay + d))) {
          const m = newMask(D);
          for (const d of g.days) {
            const o = d + g.shift;
            if (o >= 0 && o < D) setBit(m, o);
          }
          variants.push({ start: g.start, m });
        }
      } else {
        const m = newMask(D);
        for (let d = 0; d < D; d++) if (getBit(base, d + 1)) setBit(m, d);
        variants.push({ start: s, m });
      }
      for (const v of variants) {
        const pc = popcount(v.m);
        if (!pc) continue;
        tripP.push(pid);
        tripS.push(v.start);
        tripC.push(masks.add(v.m));
        tripN.push(dn.number);
        patternDays[pid] = (patternDays[pid] ?? 0) + pc;
      }
    }
  };

  let cur = -1;
  let raw: RawStop[] = [];
  let nRows = 0;
  await db.stream(
    `SELECT st.trip_key, m.station, m.city, st.arr, st.dep FROM stop_times st JOIN stop_map m USING (stop_key)
     ORDER BY st.trip_key, st.seq`,
    (c, n) => {
      const k = c[0]!, s = c[1]!, ci = c[2]!, a = c[3]!, d = c[4]!;
      for (let r = 0; r < n; r++) {
        const tk = k[r] as number;
        if (tk !== cur) {
          if (cur >= 0) finalize(cur, raw);
          cur = tk;
          raw = [];
        }
        raw.push({ station: s[r] as number, city: ci[r] as number, arr: a[r] as number, dep: d[r] as number });
      }
      nRows += n;
      if (nRows % 20_000_000 < n) log(`  patterns: ${nRows} stop_times streamed, ${store.patterns.length} patterns, ${tripP.length} trips`);
    },
  );
  if (cur >= 0) finalize(cur, raw);
  const patterns = store.patterns;
  patternDays = Array.from({ length: patterns.length }, (_, i) => patternDays[i] ?? 0);
  log(`${patterns.length} patterns, ${tripP.length} trips, ${masks.masks.length} calendars, ${routes.length} routes, ${droppedTrips} trips dropped (<2 cities)`);

  // ------------------------------------------------------------------ corridors
  timer.start("corridors");
  interface CorrAcc {
    a: number;
    b: number;
    cats: number;
    dt: number;
    tpd: Record<number, number>;
    hops: Map<string, { from: number; to: number; w: number; shapeTrip: number }>;
    sa: Map<number, number>;
    sb: Map<number, number>;
  }
  const corrIndex = new Map<string, number>();
  const corrs: CorrAcc[] = [];
  const patternCorr: number[][] = [];
  for (let p = 0; p < patterns.length; p++) {
    const pt = patterns[p]!;
    const w = patternDays[p]!;
    const route = routes[pt.route]!;
    const list: number[] = [];
    for (let i = 0; i + 1 < pt.cities.length; i++) {
      const c1 = pt.cities[i]!, c2 = pt.cities[i + 1]!;
      if (c1 === c2) continue;
      const [a, b] = c1 < c2 ? [c1, c2] : [c2, c1];
      const key = `${a},${b}`;
      let id = corrIndex.get(key);
      if (id === undefined) {
        id = corrs.length;
        corrIndex.set(key, id);
        corrs.push({ a, b, cats: 0, dt: 0, tpd: {}, hops: new Map(), sa: new Map(), sb: new Map() });
      }
      list.push(id);
      if (!w) continue;
      const cr = corrs[id]!;
      cr.cats |= route.cat;
      if (route.flags & Flag.DTicket) cr.dt |= route.cat;
      cr.tpd[route.cat] = (cr.tpd[route.cat] ?? 0) + w / D;
      const s1 = pt.stations[i]!, s2 = pt.stations[i + 1]!;
      const [from, to] = c1 === a ? [s1, s2] : [s2, s1];
      const hk = `${from},${to}`;
      const h = cr.hops.get(hk);
      if (h) {
        h.w += w;
        if (h.shapeTrip < 0 && pt.shapeTrip >= 0) h.shapeTrip = pt.shapeTrip;
      } else cr.hops.set(hk, { from, to, w, shapeTrip: pt.shapeTrip });
      cr.sa.set(from, (cr.sa.get(from) ?? 0) + w);
      cr.sb.set(to, (cr.sb.get(to) ?? 0) + w);
    }
    patternCorr.push(list);
  }
  log(`${corrs.length} corridors`);

  // shapes for representative hops
  const neededShapes = new Map<number, number>(); // shape_key → trip
  const hopLists = corrs.map((c) => [...c.hops.values()].sort((x, y) => y.w - x.w).slice(0, 3));
  for (const hl of hopLists) for (const h of hl) if (h.shapeTrip >= 0) neededShapes.set(tShape[h.shapeTrip]!, h.shapeTrip);
  const shapePts = new Map<number, LonLat[]>();
  if (neededShapes.size) {
    await db.run(`DROP TABLE IF EXISTS needshape`);
    await db.insertRows("needshape", [{ name: "shape_key", type: "INTEGER" }], [...neededShapes.keys()].map((k) => [k]), join(ctx.tmpDir, "needshape.csv"));
    await db.stream(
      `SELECT shape_key, list([lon, lat] ORDER BY seq) FROM shapes WHERE shape_key IN (SELECT shape_key FROM needshape) GROUP BY shape_key`,
      (c, n) => {
        for (let r = 0; r < n; r++) shapePts.set(c[0]![r] as number, c[1]![r] as LonLat[]);
      },
    );
  }
  log(`${shapePts.size} feed shapes loaded for geometry`);

  // ------------------------------------------------------------------ geometry
  timer.start("geometry");
  const RAIL = Cat.LongDistance | Cat.Regional;
  const reqs = corrs.map((c, id) => {
    const A = cities[c.a]!, B = cities[c.b]!;
    const hops = hopLists[id]!.map((h) => {
      const f = stations[h.from]!, t = stations[h.to]!;
      const hop: { from: [number, number]; to: [number, number]; shape?: [number, number][] } = { from: [f.lon, f.lat], to: [t.lon, t.lat] };
      const sp = h.shapeTrip >= 0 ? shapePts.get(tShape[h.shapeTrip]!) : undefined;
      if (sp) {
        const sl = sliceShape(sp, hop.from, hop.to);
        if (sl) hop.shape = sl;
      }
      return hop;
    });
    return { id, mode: (c.cats & RAIL ? "rail" : "road") as "rail" | "road", hops, a: [A.lon, A.lat] as [number, number], b: [B.lon, B.lat] as [number, number] };
  });
  // The database is not needed any more: close it and release big JS structures
  // before geometry (which runs its own DuckDB instance on a large extract).
  await db.run("CHECKPOINT");
  db.close();
  stopRows.length = 0;
  stopIns.length = 0;
  members.length = 0;
  svcMask.clear();
  tHead.length = 0;
  tShort.length = 0;
  dupInfo.clear();
  freq.clear();
  extraMask.clear();
  places.length = 0;
  (globalThis as { gc?: () => void }).gc?.();

  shapePts.clear();
  let geoms: { id: number; coords: [number, number][]; snapped: boolean }[] | null = null;
  if (args.geometry && reqs.length) {
    try {
      const mod = await import("./geometry/index.ts");
      geoms = await mod.buildGeometries(reqs, { workDir: join(args.work, "geometry"), log });
    } catch (e) {
      warn(`geometry module failed, using straight lines: ${(e as Error).stack ?? e}`);
    }
  }
  const geomById = new Map<number, { coords: [number, number][]; snapped: boolean }>();
  for (const g of geoms ?? []) geomById.set(g.id, g);

  // ------------------------------------------------------------------ output assembly
  timer.start("output");
  const usedCity = new Int32Array(cities.length).fill(-1);
  const usedStation = new Int32Array(stations.length).fill(-1);
  const cityTrips = new Float64Array(cities.length);
  const cityCats = new Uint8Array(cities.length);
  const stationCats = new Uint8Array(stations.length);
  for (let p = 0; p < patterns.length; p++) {
    if (!patternDays[p]) continue;
    const pt = patterns[p]!;
    const cat = routes[pt.route]!.cat;
    const wCat = cat === Cat.LongDistance ? 3 : cat === Cat.Coach ? 1.5 : cat === Cat.Regional ? 1 : 0.3;
    const seen = new Set<number>();
    for (const s of pt.stations) {
      stationCats[s]! |= cat;
      const c = stations[s]!.city;
      cityCats[c]! |= cat;
      if (!seen.has(c)) {
        seen.add(c);
        cityTrips[c]! += (wCat * patternDays[p]!) / D;
      }
    }
  }
  // dense ids: cities sorted by importance desc so that low ids are big hubs
  let maxTpd = 1;
  for (const v of cityTrips) if (v > maxTpd) maxTpd = v;
  const imp = (c: number) => {
    const pop = cities[c]!.population;
    const p = Math.min(1, Math.log10(1 + pop) / 7);
    const s = Math.log10(1 + cityTrips[c]!) / Math.log10(1 + maxTpd);
    return 0.5 * p + 0.5 * s;
  };
  const cityOrder = [...Array(cities.length).keys()].filter((c) => cityTrips[c]! > 0).sort((a, b) => imp(b) - imp(a));
  const maxImp = cityOrder.length ? imp(cityOrder[0]!) : 1;
  cityOrder.forEach((c, i) => (usedCity[c] = i));
  // stations: grouped per city in city order
  const stationsByCity: number[][] = cityOrder.map(() => []);
  for (let p = 0; p < patterns.length; p++) {
    if (!patternDays[p]) continue;
    for (const s of patterns[p]!.stations) {
      if (usedStation[s]! === -2) continue;
      const c = usedCity[stations[s]!.city]!;
      if (c < 0 || usedStation[s]! >= 0) continue;
      usedStation[s] = -2;
      stationsByCity[c]!.push(s);
    }
  }
  let sid = 0;
  for (const list of stationsByCity) {
    list.sort((a, b) => stations[b]!.weight - stations[a]!.weight);
    for (const s of list) usedStation[s] = sid++;
  }
  const outStations: Station[] = [];
  for (const list of stationsByCity)
    for (const s of list) {
      const st = stations[s]!;
      outStations.push({ id: usedStation[s]!, city: usedCity[st.city]!, name: st.name, lon: round5(st.lon), lat: round5(st.lat), cats: stationCats[s]! });
    }
  const outCities: City[] = cityOrder.map((c, i) => {
    const cr = cities[c]!;
    // representative point: weighted mean of rail stations if any, else city point
    return {
      id: i,
      name: cr.name,
      country: cr.country,
      lon: round5(cr.lon),
      lat: round5(cr.lat),
      population: cr.population,
      importance: Math.round((imp(c) / maxImp) * 1000) / 1000,
      cats: cityCats[c]!,
      stations: stationsByCity[i]!.map((s) => usedStation[s]!),
      tz: tzId(cr.tz),
    };
  });
  // corridors
  const corrNew = new Int32Array(corrs.length).fill(-1);
  const outCorr: Corridor[] = [];
  let snappedN = 0;
  corrs.forEach((c, id) => {
    if (!c.cats) return;
    const a = usedCity[c.a]!, b = usedCity[c.b]!;
    if (a < 0 || b < 0) return;
    const g = geomById.get(id);
    const A = cities[c.a]!, B = cities[c.b]!;
    const raw = g?.coords ?? greatCircle([A.lon, A.lat], [B.lon, B.lat]);
    const coords = simplifyLine(raw, c.cats & RAIL ? 40 : c.cats & Cat.Coach ? 200 : 500).map(([x, y]) => [round5(x), round5(y)] as [number, number]);
    // orient from new a to new b
    const flip = a > b;
    if (flip) coords.reverse();
    const tpd: Partial<Record<CatBit, number>> = {};
    for (const k of CAT_BITS) if (c.tpd[k]) tpd[k] = Math.round(c.tpd[k]! * 10) / 10;
    const top = (m: Map<number, number>) => {
      let best = -1, bw = -1;
      for (const [s, w] of m) if (w > bw && usedStation[s]! >= 0) [best, bw] = [s, w];
      return best >= 0 ? usedStation[best]! : undefined;
    };
    const sa = top(c.sa), sb = top(c.sb);
    const cor: Corridor = { id: outCorr.length, a: flip ? b : a, b: flip ? a : b, coords, cats: c.cats, tpd, snapped: !!g?.snapped };
    if (c.dt) cor.dtCats = c.dt;
    const [ea, eb] = flip ? [sb, sa] : [sa, sb];
    if (ea !== undefined) cor.sa = ea;
    if (eb !== undefined) cor.sb = eb;
    if (cor.snapped) snappedN++;
    corrNew[id] = outCorr.length;
    outCorr.push(cor);
  });

  const build = args.build ?? `${args.startDate.replace(/-/g, "")}-${new Date().toISOString().slice(11, 16).replace(":", "")}`;
  const outRoot = args.out;
  const outDir = join(outRoot, build);
  await mkdir(join(outDir, "city"), { recursive: true });
  // remove older builds
  if (existsSync(outRoot))
    for (const e of await readdir(outRoot)) {
      if (e !== build && e !== "manifest.json" && /^\d{8}-\d{4}/.test(e)) await rm(join(outRoot, e), { recursive: true, force: true });
    }

  const network: NetworkFile = { schema: SCHEMA_VERSION, build, timezones, cities: outCities, stations: outStations, corridors: outCorr };
  const calendars: CalendarsFile = { startDate: args.startDate, days: D, masks: masks.masks };

  // city files
  const patternsByCity: number[][] = cityOrder.map(() => []);
  for (let p = 0; p < patterns.length; p++) {
    if (!patternDays[p]) continue;
    const seen = new Set<number>();
    for (const s of patterns[p]!.stations) {
      const c = usedCity[stations[s]!.city]!;
      if (c >= 0 && !seen.has(c)) {
        seen.add(c);
        patternsByCity[c]!.push(p);
      }
    }
  }
  // trips grouped by pattern (counting sort)
  const tStartIdx = new Int32Array(patterns.length + 1);
  for (const p of tripP) tStartIdx[p + 1]!++;
  for (let i = 0; i < patterns.length; i++) tStartIdx[i + 1]! += tStartIdx[i]!;
  const tOrder = new Int32Array(tripP.length);
  const fill = tStartIdx.slice();
  for (let t = 0; t < tripP.length; t++) tOrder[fill[tripP[t]!]!++] = t;

  const maxWalk = ((45 - 3) * 75) / 1.3;
  let totalBytes = 0;
  const sizes: { city: string; bytes: number }[] = [];
  let fileCount = 0;
  for (let c = 0; c < cityOrder.length; c++) {
    const plist = patternsByCity[c]!;
    const localRoute = new Map<number, number>();
    const rOut: Route[] = [];
    const pOut: Pattern[] = [];
    const pTz: number[] = [];
    const tOut: Trip[] = [];
    plist.sort((a, b) => a - b);
    for (const p of plist) {
      const pt = patterns[p]!;
      let lr = localRoute.get(pt.route);
      if (lr === undefined) {
        lr = rOut.length;
        localRoute.set(pt.route, lr);
        rOut.push(routes[pt.route]!);
      }
      const li = pOut.length;
      pOut.push({
        route: lr,
        stations: pt.stations.map((s) => usedStation[s]!),
        arr: pt.arr,
        dep: pt.dep,
        corridors: patternCorr[p]!.map((x) => corrNew[x]!),
        headsign: pt.headsign,
      });
      pTz.push(pt.tz);
      for (let k = tStartIdx[p]!; k < tStartIdx[p + 1]!; k++) {
        const t = tOrder[k]!;
        const num = tripN[t];
        tOut.push(num ? [li, tripS[t]!, tripC[t]!, num] : [li, tripS[t]!, tripC[t]!]);
      }
    }
    tOut.sort((x, y) => x[1] - y[1] || x[0] - y[0]);
    const stIds = stationsByCity[c]!;
    const transfers: [number, number, number][] = [];
    for (let i = 0; i < stIds.length; i++)
      for (let j = 0; j < stIds.length; j++) {
        if (i === j) continue;
        const a = stations[stIds[i]!]!, b = stations[stIds[j]!]!;
        const d = haversine(a.lon, a.lat, b.lon, b.lat);
        if (d <= maxWalk) transfers.push([usedStation[stIds[i]!]!, usedStation[stIds[j]!]!, walkMinutes(d)]);
      }
    const anyRail = stIds.some((s) => stations[s]!.rail);
    const cf: CityFile = { city: c, routes: rOut, patterns: pOut, patternTz: pTz, trips: tOut, transfers, minTransfer: anyRail ? 5 : 3 };
    const json = JSON.stringify(cf);
    await writeFile(join(outDir, "city", `${c}.json`), json);
    fileCount++;
    totalBytes += json.length;
    sizes.push({ city: `${outCities[c]!.name} (${c})`, bytes: Buffer.byteLength(json) });
  }
  sizes.sort((a, b) => b.bytes - a.bytes);

  // attribution
  const attribution = buildAttribution(ctx);
  // Split the network into continuation parts if it would exceed the per-file limit.
  const files: [string, unknown][] = [];
  {
    const LIMIT = 18_000_000;
    const size = (x: unknown) => Buffer.byteLength(JSON.stringify(x));
    const main: NetworkFile = { ...network, stations: [], corridors: [] };
    let used = size(main);
    const parts: NetworkPart[] = [];
    let cur: NetworkPart | null = null;
    let curSize = 0;
    const place = (kind: "stations" | "corridors", item: Station | Corridor) => {
      const sz = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (!cur && used + sz <= LIMIT) {
        (main[kind] as (Station | Corridor)[]).push(item);
        used += sz;
        return;
      }
      if (!cur || curSize + sz > LIMIT) {
        cur = {};
        parts.push(cur);
        curSize = 30;
      }
      ((cur[kind] ??= []) as (Station | Corridor)[]).push(item);
      curSize += sz;
    };
    for (const st of network.stations) place("stations", st);
    for (const co of network.corridors) place("corridors", co);
    if (parts.length) {
      main.parts = parts.map((_, i) => `network-${i + 1}.json`);
      parts.forEach((p, i) => files.push([`network-${i + 1}.json`, p]));
      log(`network split into network.json + ${parts.length} part(s)`);
    }
    files.unshift(["network.json", main]);
  }
  files.push(
    ["calendars.json", calendars],
    ["attribution.json", attribution],
  );
  for (const [name, obj] of files) {
    const json = JSON.stringify(obj);
    await writeFile(join(outDir, name), json);
    totalBytes += json.length;
    fileCount++;
  }

  // basemap (frontend script)
  if (args.basemap) {
    timer.start("basemap");
    try {
      const modPath = join(import.meta.dirname, "../../web/scripts/basemap.ts");
      if (existsSync(modPath)) {
        const mod = (await import(modPath)) as { buildBasemap: (o: { outDir: string; cacheDir?: string; log?: (s: string) => void }) => Promise<void> };
        await mod.buildBasemap({ outDir: join(outDir, "basemap"), cacheDir: join(ctx.cacheDir, "basemap"), log });
        for (const f of await readdir(join(outDir, "basemap"))) {
          totalBytes += (await stat(join(outDir, "basemap", f))).size;
          fileCount++;
        }
      } else warn("basemap script not found, skipping");
    } catch (e) {
      warn(`basemap failed: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ stats, sanity, manifest
  timer.start("sanity");
  const catTrips: Record<string, number> = {};
  for (let t = 0; t < tripP.length; t++) {
    const cat = routes[patterns[tripP[t]!]!.route]!.cat;
    catTrips[CAT_NAMES[cat]!] = (catTrips[CAT_NAMES[cat]!] ?? 0) + 1;
  }
  const catRoutes: Record<string, number> = {};
  for (const r of routes) catRoutes[CAT_NAMES[r.cat]!] = (catRoutes[CAT_NAMES[r.cat]!] ?? 0) + 1;
  Object.assign(stats, {
    feeds: ctx.feedStats.filter((f) => f.trips > 0).length,
    feedsFailed: ctx.failed.length,
    cities: outCities.length,
    stations: outStations.length,
    corridors: outCorr.length,
    corridorsSnapped: snappedN,
    patterns: patterns.length,
    trips: tripP.length,
    calendars: masks.masks.length,
    routes: routes.length,
    files: fileCount,
    outputBytes: totalBytes,
  });
  for (const [k, v] of Object.entries(catTrips)) stats[`trips${k}`] = v;
  for (const [k, v] of Object.entries(catRoutes)) stats[`routes${k}`] = v;

  const byCountry: Record<string, { cities: number; trips: number }> = {};
  for (const c of outCities) {
    const e = (byCountry[c.country] ??= { cities: 0, trips: 0 });
    e.cities++;
  }
  for (let p = 0; p < patterns.length; p++) {
    const cnt = tStartIdx[p + 1]! - tStartIdx[p]!;
    if (!cnt) continue;
    const c0 = usedCity[patterns[p]!.cities[0]!]!;
    if (c0 < 0) continue;
    const e = (byCountry[outCities[c0]!.country] ??= { cities: 0, trips: 0 });
    e.trips += cnt;
  }
  const sanity = runSanity({ network, calendars, readCity: (id) => readCityCache(outDir, id) });
  for (const w of sanity.warnings) warn(`sanity: ${w}`);
  for (const e of sanity.errors) warn(`SANITY ERROR: ${e}`);
  timer.end();

  stats.durationSec = Math.round((Date.now() - ctx.t0) / 1000);
  const manifest: Manifest = { schema: SCHEMA_VERSION, build, generatedAt: new Date().toISOString(), startDate: args.startDate, days: D, stats };
  Object.assign(report, {
    build,
    stats,
    stageSeconds: timer.durations,
    tripsByCategory: catTrips,
    routesByCategory: catRoutes,
    byCountry,
    biggestCityFiles: sizes.slice(0, 25),
    sanity,
  });
  await writeFile(join(outRoot, "build-report.json"), JSON.stringify(report, null, 1));
  await writeFile(join(outRoot, "manifest.json"), JSON.stringify(manifest));
  log(`build ${build}: ${JSON.stringify(stats)}`);
  log(`biggest city files: ${sizes.slice(0, 8).map((s) => `${s.city} ${(s.bytes / 1e6).toFixed(1)}MB`).join(", ")}`);
  if (sanity.errors.length) {
    console.error(`sanity check failed with ${sanity.errors.length} structural errors`);
    process.exitCode = 1;
  }
}

import { readFileSync } from "node:fs";
function readCityCache(outDir: string, id: number): CityFile | null {
  try {
    return JSON.parse(readFileSync(join(outDir, "city", `${id}.json`), "utf8")) as CityFile;
  } catch {
    return null;
  }
}

interface LicenseEntry {
  filename?: string;
  human_name?: string;
  spdx_license_identifier?: string | null;
  license_url?: string | null;
  source?: string;
  publisher?: { name?: string; url?: string } | null;
  operators?: string[];
}

function buildAttribution(ctx: BuildCtx): AttributionFile {
  const lic = new Map<string, LicenseEntry>();
  for (const e of ctx.licenses as LicenseEntry[]) if (e.filename) lic.set(e.filename, e);
  const used = new Set(ctx.feedStats.filter((f) => f.trips > 0).map((f) => f.key));
  const sources: AttributionFile["sources"] = [];
  for (const rf of ctx.feeds) {
    if (!used.has(rf.key)) continue;
    const e = rf.transitousFile ? lic.get(rf.transitousFile) : undefined;
    if (e) {
      sources.push({
        name: `${rf.def.name}${e.human_name && !rf.def.name.includes(e.human_name) ? ` – ${e.human_name}` : ""}`,
        license: e.spdx_license_identifier ?? (e.license_url ? "see license" : "unknown"),
        url: e.license_url ?? e.publisher?.url ?? e.source,
        attribution: e.publisher?.name ?? (e.operators ?? []).slice(0, 5).join(", "),
      });
    } else {
      sources.push({
        name: rf.def.name,
        license: rf.def.license ?? "see source",
        url: rf.def.licenseUrl ?? rf.urls[0],
        attribution: rf.def.attribution,
      });
    }
  }
  sources.push(
    { name: "Transitous (feed mirror)", license: "various", url: "https://transitous.org/", attribution: "Feeds processed and mirrored by Transitous" },
    { name: "GeoNames", license: "CC-BY-4.0", url: "https://www.geonames.org/", attribution: "GeoNames" },
    { name: "OpenStreetMap via Overture Maps (rail geometry)", license: "ODbL-1.0", url: "https://www.openstreetmap.org/copyright", attribution: "© OpenStreetMap contributors" },
    { name: "Natural Earth (basemap)", license: "Public Domain", url: "https://www.naturalearthdata.com/" },
  );
  return { sources };
}
