import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  Cat,
  CAVEAT_FLAGS,
  Flag,
  SCHEMA_VERSION,
  type AttributionFile,
  type CalendarsFile,
  type City,
  type CityFile,
  type Corridor,
  type Manifest,
  type NetworkFile,
  type Segment,
  packNetwork,
  segmentPath,
  aggregateSegments,
  type Pattern,
  type ScheduleFile,
  type ScheduleRun,
  SCHEDULE_GROUP,
  scheduleFile,
  type Route,
  type Station,
  type Trip,
  type CatBit,
  TRANSFER_MAX_M,
  StopLimit,
} from "@etbm/shared";
import type { Db } from "./db.ts";
import type { FeedsConfig, ResolvedFeed } from "./feeds.ts";
import type { FeedRef } from "./operators/types.ts";
import type { FeedLoadStats } from "./gtfs/load.ts";
import type { CliArgs } from "./cli.ts";
import { BBOX, loadPlaces, loadVillages } from "./geonames.ts";
import { adoptStationNames, assignStations, chooseCityName, foldKey, matchVillage, resolveSatellites, townFromStopName, type Place } from "./core/cities.ts";
import { describeStation, mergeStations, walkMinutes, type StopIn } from "./core/stations.ts";
import { normalizeStopName, sanitizeName } from "./core/names.ts";
import { MaskStore, getBit, newMask, popcount, setBit } from "./core/calendar.ts";
import { isoToEpochDay, tzOffsetMinutes, validTz } from "./core/time.ts";
import { resolveDuplicates, type DupPair, type DupTrip } from "./core/dedup.ts";
import { MAX_THROUGH_DWELL, findThroughRuns, type RunPiece } from "./core/through.ts";
import { PatternStore, localizeStart, processTripStops, type RawStop } from "./core/patterns.ts";
import { displayName, isHighSpeedService, RAIL_LINE_CODE_RE } from "./core/classify.ts";
import type { GeometryRequest } from "./geometry/index.ts";
import { sliceShape } from "./core/shapes.ts";
import { buildSegments } from "./core/segments.ts";
import { anchorCitiesAtMainStation } from "./core/anchor.ts";
import { applyStopNames, stopAltKey, stopKey } from "./core/stopnames.ts";
import { loadStopNames, writeStopCandidates } from "./stopnames-io.ts";
import { GridIndex, fastDist, greatCircle, haversine, round5, simplifyLine, type LonLat } from "./util/geo.ts";
import { log, warn, type StageTimer } from "./util/log.ts";
import { runSanity } from "./sanity.ts";
import { writeMapData } from "./mapdata.ts";
import { loadUrbanFeedDefs, writeUrbanLayer } from "./urban/index.ts";
import { computeTransit, gatherTransitFeeds } from "./urban/transit.ts";
import { BASEMAP_DIR, BASEMAP_MAXZOOM, BASEMAP_MINZOOM, BASEMAP_TILES_KEY, BASEMAP_VERSION, EUROPE_BBOX, installBasemapTiles } from "./basemap/tiles.ts";

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
  // Rail-replacement buses named after the train line: DELFI publishes the SEV buses of a railway as bus routes
  // "RE1" / "RB 81X" / "S1EV" of the railway's agency (or of its "Nahreisezug"), so a bus route with a train line
  // code (RAIL_LINE_CODE_RE) whose agency runs trains in the same country (any feed) is dropped like the named ones.
  {
    const cands = await db.all<{ rc: number; route_short: string }>(`SELECT rc.rc, rc.route_short FROM rclass rc JOIN feeds f USING (feed)
      WHERE rc.cls IN ('bus', 'coach') AND rc.agency IN (
        SELECT r2.agency FROM rclass r2 JOIN feeds f2 USING (feed) WHERE r2.cls = 'rail' AND f2.country = f.country)`);
    const rcs = cands.filter((r) => RAIL_LINE_CODE_RE.test(r.route_short ?? "")).map((r) => r.rc);
    if (rcs.length) {
      const n = await db.scalar(`SELECT count(*) FROM trips WHERE rc IN (${rcs.join(",")})`);
      await db.run(`DELETE FROM trips WHERE rc IN (${rcs.join(",")})`);
      stats.replacementBusTrips = n;
      log(`replacement buses: ${n} trips of ${rcs.length} bus routes named after a train line of their (rail) agency dropped`);
    }
  }

  // ------------------------------------------------------------------ stations, then cities
  // Stops are merged into stations first (purely spatial, core/stations.ts), then every station is
  // assigned to a city (core/cities.ts): a station belongs to the place whose catchment contains it
  // and, for rail / coach stations, whose core or name it matches.
  timer.start("stations");
  const places = await loadPlaces(ctx.cacheDir, cfg.userAgent, args.assets);
  resolveSatellites(places, { "TR:Istanbul": 50, "TR:Ankara": 30, "RU:Moscow": 40 });
  const stopRows = await db.all<{
    stop_key: number; feed: number; stop_id: string; feed_key: string; agency: string | null; name: string; lat: number; lon: number; parent_key: number | null; tz: string | null; cats: number; rail: boolean; n: number;
  }>(`SELECT s.stop_key, s.feed, s.stop_id, f.key AS feed_key, u.agency, s.name, s.lat, s.lon, s.parent_key, s.tz, u.cats, u.rail, u.n
      FROM stops s JOIN (
        SELECT stop_key, bit_or(cats) AS cats, bool_or(rail) AS rail, sum(n)::INTEGER AS n,
          first(agency ORDER BY n DESC, agency) FILTER (WHERE agency IS NOT NULL) AS agency
        FROM (
          SELECT st.stop_key, rc.agency, bit_or(t.cat) AS cats, bool_or(rc.cls = 'rail') AS rail, count(*) AS n
          FROM stop_times st JOIN trips t USING (trip_key) JOIN rclass rc USING (rc) GROUP BY st.stop_key, rc.agency
        ) GROUP BY stop_key
      ) u USING (stop_key)
      JOIN (SELECT DISTINCT ON (feed) feed, key FROM feeds ORDER BY feed, key) f ON f.feed = s.feed
      WHERE s.lat BETWEEN ${BBOX.minLat} AND ${BBOX.maxLat} AND s.lon BETWEEN ${BBOX.minLon} AND ${BBOX.maxLon}
      ORDER BY s.stop_key`);
  // ORDER BY: DuckDB returns rows in no particular order (parallel scans), and everything below depends on
  // the stop order: union-find merges and their tie-breaks, station ids, name choice on equal scores, city
  // assignment of synthetic towns. Without it two runs on the same database give different stations / cities.
  log(`${stopRows.length} used stops`);
  // display-safe stop names (raw ids and "CITY | " prefixes removed); the reviewed-names keys use the raw ones
  const stopIns: StopIn[] = stopRows.map((s) => ({
    lon: s.lon,
    lat: s.lat,
    name: sanitizeName(s.name),
    rail: !!s.rail,
    parent: s.parent_key != null ? `${s.parent_key}` : null,
    feed: s.feed,
    weight: s.n,
  }));
  const merge = mergeStations(stopIns);
  const stationOf = merge.stationOf;
  const nStations = merge.count;
  log(`${nStations} stations from ${stopIns.length} stops; merges by signal: ${Object.entries(merge.bySignal).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  for (const [k, v] of Object.entries(merge.bySignal)) stats[`merge_${k}`] = v;
  /** Stations (name, position, services) from their stops; the city name only matters for "S+U X Bhf" style names. */
  const describeAll = (cityNameOf?: (station: number) => string) => {
    const members: number[][] = Array.from({ length: nStations }, () => []);
    for (let i = 0; i < stopIns.length; i++) members[stationOf[i]!]!.push(i);
    return members.map((m, st): StationRec => {
      if (!m.length) return { city: -1, name: "", lon: 0, lat: 0, cats: 0, rail: false, weight: 0 }; // emptied by a merge
      const ms = m.map((i) => stopIns[i]!);
      const d = describeStation(ms, cityNameOf?.(st) ?? "");
      return {
        city: -1,
        name: d.name,
        lon: d.lon,
        lat: d.lat,
        cats: ms.reduce((a, s, k) => a | stopRows[m[k]!]!.cats, 0),
        rail: ms.some((s) => s.rail),
        weight: ms.reduce((a, s) => a + s.weight, 0),
      };
    });
  };
  let stations = describeAll();

  // ---- cities
  timer.start("cities");
  const stationStops: number[][] = Array.from({ length: nStations }, () => []);
  for (let i = 0; i < stopIns.length; i++) stationStops[stationOf[i]!]!.push(i);
  const live: number[] = [];
  for (let st = 0; st < nStations; st++) if (stationStops[st]!.length) live.push(st);
  const placeOf = assignStations(
    places,
    live.map((st) => ({
      lon: stations[st]!.lon,
      lat: stations[st]!.lat,
      names: [...new Set(stationStops[st]!.map((i) => foldKey(stopIns[i]!.name)))].filter(Boolean),
      strict: stations[st]!.rail || (stations[st]!.cats & Cat.Coach) !== 0,
    })),
  );
  const adopted = adoptStationNames(
    live.map((st) => ({ lon: stations[st]!.lon, lat: stations[st]!.lat, norm: normalizeStopName(stations[st]!.name), strict: stations[st]!.rail || (stations[st]!.cats & Cat.Coach) !== 0 })),
    placeOf,
  );
  if (adopted) log(`${adopted} bus-only stations joined the place of the rail / coach station of the same name`);
  const cities: CityRec[] = [];
  const cityOfPlace = new Map<number, number>();
  const stationCity = new Int32Array(nStations).fill(-1);
  live.forEach((st, k) => {
    const p = placeOf[k]!;
    if (p < 0) return;
    let c = cityOfPlace.get(p);
    if (c === undefined) {
      const pl = places[p]!;
      c = cities.length;
      cityOfPlace.set(p, c);
      cities.push({ place: p, name: pl.name, country: pl.country, lon: pl.lon, lat: pl.lat, population: pl.population, tz: pl.tz, stopNames: [], synthetic: false });
    }
    stationCity[st] = c;
  });
  // Synthetic cities for stations that belong to no place: clustered within 2 km, busiest first.
  const placeIdx = new GridIndex(places.map((p) => p.lon), places.map((p) => p.lat), 0.5);
  const synth: { lon: number; lat: number; city: number }[] = [];
  const synthGrid = new Map<string, number[]>();
  const sk = (lon: number, lat: number) => `${Math.floor(lon / 0.05)},${Math.floor(lat / 0.05)}`;
  let nSynth = 0;
  const unassigned = live.filter((st) => stationCity[st]! < 0).sort((a, b) => stations[b]!.weight - stations[a]!.weight);
  const tzOfStop = (st: number) => validTz(stopRows[stationStops[st]![0]!]!.tz);
  for (const st of unassigned) {
    const s = stations[st]!;
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
        name: townFromStopName(s.name),
        country: near?.country ?? "XX",
        lon: s.lon,
        lat: s.lat,
        population: 0,
        tz: tzOfStop(st) ?? near?.tz ?? "Europe/Berlin",
        stopNames: [],
        synthetic: true,
      });
      synth.push({ lon: s.lon, lat: s.lat, city: found });
      const k = sk(s.lon, s.lat);
      const arr = synthGrid.get(k) ?? [];
      arr.push(synth.length - 1);
      synthGrid.set(k, arr);
    }
    stationCity[st] = found;
  }
  // Villages: a synthetic town whose name is the name of a GeoNames populated place below cities1000 (Scariff, Feakle,
  // Bodyke; geonames.ts loadVillages) becomes that village, a named place: buses take you there (patterns: busPlace).
  // Towns matching the same village (or a cities1000 place) are joined. The rest (stop clusters named "School Road",
  // "Road End", a farm or a junction) stay synthetic: their bus stops are listed in the schedules only.
  {
    const villages = await loadVillages(ctx.cacheDir, cfg.userAgent, args.assets);
    const villageIdx = new GridIndex(villages.map((v) => v.lon), villages.map((v) => v.lat), 0.1);
    const placeById = new Map(places.map((p, i) => [p.id, i]));
    const cityOfVillage = new Map<number, number>();
    const cityStations: number[][] = cities.map(() => []);
    for (const st of live) if (cities[stationCity[st]!]!.synthetic) cityStations[stationCity[st]!]!.push(st);
    let made = 0, joined = 0;
    for (let ci = 0; ci < cities.length; ci++) {
      const c = cities[ci]!;
      if (!c.synthetic) continue;
      const sts = cityStations[ci]!.sort((a, b) => stations[b]!.weight - stations[a]!.weight);
      let m = matchVillage(c.name, c.lon, c.lat, villages, villageIdx);
      // the town is named after its busiest station; its other stops may carry the village's name
      for (let k = 1; !m && k < Math.min(sts.length, 6); k++) m = matchVillage(townFromStopName(stations[sts[k]!]!.name), stations[sts[k]!]!.lon, stations[sts[k]!]!.lat, villages, villageIdx);
      if (!m) continue;
      const v = villages[m.village]!;
      let pi = placeById.get(v.id);
      if (pi !== undefined && places[pi]!.parent !== undefined && places[pi]!.parent! >= 0) pi = places[pi]!.parent!;
      const target = pi !== undefined ? cityOfPlace.get(pi) : cityOfVillage.get(m.village);
      if (target !== undefined) {
        for (const st of sts) stationCity[st] = target;
        joined++;
        continue;
      }
      if (pi !== undefined) {
        // a cities1000 place without stations of its own (its stops lie beyond its catchment)
        const pl = places[pi]!;
        Object.assign(c, { place: pi, name: pl.name, country: pl.country, population: pl.population, synthetic: false });
        cityOfPlace.set(pi, ci);
      } else {
        Object.assign(c, { name: m.name, country: v.country, population: v.population, synthetic: false });
        cityOfVillage.set(m.village, ci);
      }
      made++;
    }
    log(`villages: ${made} synthetic towns are GeoNames villages, ${joined} more joined a village or place of the same name`);
    stats.villages = made;
    stats.villagesJoined = joined;
  }
  // A synthetic town named after a generic stop name ("Road End", "Hotel", "Mairie": at least 4 of them) says nothing:
  // add the nearest place, "Road End (Strathy)".
  {
    const count = new Map<string, number>();
    for (const c of cities) if (c.synthetic) count.set(c.name, (count.get(c.name) ?? 0) + 1);
    let renamed = 0;
    for (const c of cities) {
      if (!c.synthetic || (count.get(c.name) ?? 0) < 4) continue;
      const near = placeIdx.within(c.lon, c.lat, 25_000).map((j) => ({ j, d: fastDist(c.lon, c.lat, places[j]!.lon, places[j]!.lat) })).sort((a, b) => a.d - b.d)[0];
      if (!near) continue;
      c.name = `${c.name} (${places[near.j]!.name})`;
      renamed++;
    }
    if (renamed) log(`${renamed} synthetic towns with a generic name got the nearest place added`);
  }
  // Name matching uses rail station names (or regional bus names); coach-only stops (often English names) are ignored.
  const railNames: string[][] = cities.map(() => []);
  for (const st of live) {
    const c = stationCity[st]!;
    const s = stations[st]!;
    if (s.rail && railNames[c]!.length < 200) railNames[c]!.push(s.name);
    else if (s.cats & Cat.Bus && cities[c]!.stopNames.length < 100) cities[c]!.stopNames.push(s.name);
  }
  for (let ci = 0; ci < cities.length; ci++) {
    const c = cities[ci]!;
    if (railNames[ci]!.length) c.stopNames = railNames[ci]!;
    if (c.place < 0) continue; // synthetic towns and villages keep their name
    const pl = places[c.place]!;
    const cands = [...(pl.altNames ?? []), pl.name];
    c.name = c.stopNames.length ? chooseCityName(cands, c.stopNames) : cands[0]!;
  }
  log(`${cities.length} cities (${nSynth} synthetic, ${cities.filter((c) => c.synthetic).length} left after villages)`);
  // final station names (the city name helps "S+U Gesundbrunnen Bhf" → "Berlin Gesundbrunnen")
  const cityNameOf = (st: number) => cities[stationCity[st]!]?.name ?? "";
  stations = describeAll(cityNameOf);
  for (const st of live) stations[st]!.city = stationCity[st]!;
  // reviewed coach/bus stop names (data/stop-names.json): forced merges into a named station (the stop joins its city) and display names
  const stopNames = await loadStopNames(join(import.meta.dirname, "..", "data", "stop-names.json"));
  const stopKeys = stopRows.map((r, i) => ({ key: stopKey(r.feed_key, r.stop_id), altKey: stopAltKey(r.name, r.lon, r.lat), lon: r.lon, lat: r.lat, name: stopIns[i]!.name }));
  const sn = applyStopNames(stopNames, stopKeys, stationOf, stations);
  if (sn.merged) {
    stations = describeAll(cityNameOf);
    for (const st of live) stations[st]!.city = stationCity[st]!;
  }
  for (const m of sn.missing.slice(0, 20)) warn(`stop-names: ${m}`);
  if (stopNames) log(`stop-names: ${Object.keys(stopNames.entries).length} entries, ${sn.merged} merges, ${sn.renames.size} renames, ${sn.missing.length} merge targets not found`);
  stats.stopNameMerges = sn.merged;
  stats.stopNameRenames = sn.renames.size;
  for (const [st, name] of sn.renames) if (stations[st]!.name) stations[st]!.name = sanitizeName(name);
  const stopCity = Int32Array.from(stationOf, (st) => stationCity[st]!);
  if (args.stopCandidates) {
    const n = await writeStopCandidates(args.stopCandidates, { stopRows, stopKeys, stopCity, stationOf, stations, cities, mapping: stopNames });
    log(`stop candidates: ${n} written to ${args.stopCandidates}`);
    timer.end();
    return;
  }
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
  const rclass = new Map<number, { feed: number; cls: string; agency: string; short: string; long: string; color: string | null; tz: string; pname: string | null; routeType: number | null }>();
  // operator name override of a feed (options.agencyName, e.g. "TransDev RAIL_5241" → "Transdev")
  const agencyOverride = new Map<number, string>();
  /** feed number → the feed as the operator adapters see it */
  const feedRef = new Map<number, FeedRef>();
  for (const r of await db.all<{ feed: number; key: string; id: string; country: string }>(`SELECT feed, key, id, country FROM feeds ORDER BY feed`)) {
    const name = ctx.feeds.find((f) => f.key === r.key)?.def.options?.agencyName;
    if (name) agencyOverride.set(r.feed, name);
    feedRef.set(r.feed, { key: r.key, id: r.id, country: r.country });
  }
  for (const r of await db.all<{ rc: number; feed: number; cls: string; agency: string; route_short: string; route_long: string; color: string | null; tz: string; pname: string | null; route_type: number | null }>(
    `SELECT rc, feed, cls, agency, route_short, route_long, color, tz, pname, route_type FROM rclass ORDER BY rc`,
  ))
    rclass.set(r.rc, { feed: r.feed, cls: r.cls, agency: agencyOverride.get(r.feed) ?? r.agency ?? "", short: r.route_short ?? "", long: r.route_long ?? "", color: r.color, tz: r.tz, pname: r.pname, routeType: r.route_type });
  const feedPriority = new Map<number, number>();
  for (const r of await db.all<{ feed: number; priority: number }>(`SELECT feed, priority FROM feeds ORDER BY feed`)) feedPriority.set(r.feed, r.priority);

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
    GROUP BY ALL HAVING count(DISTINCT a.city) >= 2 ORDER BY ta, tb`);
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
  const { dropped, extraMask, keptFor } = resolveDuplicates(pairs, dupInfo);
  // A kept trip without a feed shape takes the shape of a dropped copy (an ÖBB Railjet listing only
  // Praha and Brno in Czechia gets the SŽ shape via Pardubice), so its hops follow the real track.
  let shapesAdopted = 0;
  for (const p of [...pairs].sort((x, y) => y.shared - x.shared || x.a - y.a || x.b - y.b))
    for (const d of [p.a, p.b]) {
      const k = keptFor.get(d);
      if (k !== undefined && tShape[k]! < 0 && tShape[d]! >= 0) {
        tShape[k] = tShape[d]!;
        shapesAdopted++;
      }
    }
  log(`dedup: ${pairRows.length} candidate pairs, ${dropped.size} trips dropped as cross-feed duplicates, ${shapesAdopted} kept trips took a dropped copy's shape`);
  stats.dedupDropped = dropped.size;
  // Boarding / alighting restrictions of the dropped copies go to the kept trip (the more restrictive copy wins): the
  // Eurostar feed lets anyone ride Amsterdam → Rotterdam, NS's copy (nl-openov) forbids boarding in the Netherlands
  // towards Amsterdam. A dropped copy's stop counts at the kept trip's stop in the same city at the same time (± 2 min);
  // its first stop's alighting and last stop's boarding restrictions say nothing (a copy may cover part of the run).
  const limitExtra = new Map<number, Map<number, number>>(); // kept trip → stop_sequence → StopLimit bits
  if (keptFor.size) {
    await db.run(`DROP TABLE IF EXISTS dupmap`);
    await db.insertRows("dupmap", [{ name: "dk", type: "INTEGER" }, { name: "kk", type: "INTEGER" }], [...keptFor].map(([d, k]) => [d, k]), join(ctx.tmpDir, "dupmap.csv"));
    const rows = await db.all<{ trip_key: number; seq: number; bits: number }>(`
      WITH s AS (
        SELECT st.trip_key, st.seq, m.city, (st.arr - z.off)::INTEGER AS ua, (st.dep - z.off)::INTEGER AS ud, st.pd::INTEGER AS pd,
          row_number() OVER (PARTITION BY st.trip_key ORDER BY st.seq) AS rn, count(*) OVER (PARTITION BY st.trip_key) AS n
        FROM stop_times st JOIN trips t USING (trip_key) JOIN rclass rc USING (rc) JOIN stop_map m USING (stop_key) JOIN tzoff z ON z.tz = rc.tz
        WHERE st.trip_key IN (SELECT dk FROM dupmap UNION SELECT kk FROM dupmap)),
      d AS (
        SELECT s.city, s.ua, s.ud, dm.kk,
          (CASE WHEN rn < n THEN pd & ${StopLimit.NoBoarding} ELSE 0 END) | (CASE WHEN rn > 1 THEN pd & ${StopLimit.NoAlighting} ELSE 0 END) AS bits
        FROM s JOIN dupmap dm ON dm.dk = s.trip_key WHERE s.pd > 0)
      SELECT k.trip_key, k.seq, bit_or(d.bits)::INTEGER AS bits
      FROM d JOIN s k ON k.trip_key = d.kk AND k.city = d.city AND (abs(k.ud - d.ud) <= 2 OR abs(k.ua - d.ua) <= 2)
      WHERE d.bits > 0 GROUP BY ALL ORDER BY ALL`);
    let added = 0;
    for (const r of rows) {
      let m = limitExtra.get(r.trip_key);
      if (!m) limitExtra.set(r.trip_key, (m = new Map()));
      m.set(r.seq, r.bits);
      added++;
    }
    await db.run(`DROP TABLE IF EXISTS dupmap`);
    log(`dedup: ${added} stop restrictions (no boarding / no alighting) of dropped copies added to ${limitExtra.size} kept trips`);
    stats.dedupLimitTrips = limitExtra.size;
  }
  // The same for the copies a feed left to a dedicated operator's feed (gtfs/load.ts, limit_hints: NS's Eurostar
  // trains, never loaded as trips): a hint trip's stop goes to the city of the nearest station (≤ 1.5 km), and the
  // hint applies to every kept rail / coach trip that calls at ≥ 2 of its cities at the same times (± 2 min) with the
  // same number (when both have one; another number at ≥ 3 cities), like a duplicate.
  {
    const hints = await db.all<{ htrip: number; num: string; tz: string; rn: number; n: number; lat: number; lon: number; arr: number; dep: number; pd: number }>(
      `SELECT htrip, num, tz, rn, n, lat, lon, arr, dep, pd FROM limit_hints ORDER BY htrip, rn`,
    ).catch(() => []);
    if (hints.length) {
      const stIdx = new GridIndex(stations.map((x) => x.lon), stations.map((x) => x.lat), 0.05);
      const offCache = new Map<string, number>();
      const off = (tz: string) => {
        let o = offCache.get(tz);
        if (o === undefined) offCache.set(tz, (o = tz === "UTC" ? 0 : tzOffsetMinutes(tz, startDay)));
        return o;
      };
      const hintNum = new Map<number, string>();
      const rows: unknown[][] = [];
      for (const h of hints) {
        let best = -1, bd = 1500;
        for (const j of stIdx.within(h.lon, h.lat, 1500)) {
          if (stations[j]!.city < 0) continue;
          const d = fastDist(h.lon, h.lat, stations[j]!.lon, stations[j]!.lat);
          if (d <= bd) [best, bd] = [j, d];
        }
        if (best < 0) continue;
        const bits = (h.rn < h.n ? h.pd & StopLimit.NoBoarding : 0) | (h.rn > 1 ? h.pd & StopLimit.NoAlighting : 0);
        const o = off(h.tz);
        rows.push([h.htrip, stations[best]!.city, h.arr - o, h.dep - o, bits]);
        hintNum.set(h.htrip, h.num);
      }
      await db.run(`DROP TABLE IF EXISTS hint`);
      await db.insertRows(
        "hint",
        [{ name: "htrip", type: "INTEGER" }, { name: "city", type: "INTEGER" }, { name: "ua", type: "INTEGER" }, { name: "ud", type: "INTEGER" }, { name: "bits", type: "INTEGER" }],
        rows,
        join(ctx.tmpDir, "hint.csv"),
      );
      const matches = await db.all<{ htrip: number; trip_key: number; seq: number; bits: number; nc: number }>(`
        WITH k AS (
          SELECT st.trip_key, st.seq, m.city, (st.arr - z.off)::INTEGER AS ua, (st.dep - z.off)::INTEGER AS ud
          FROM stop_times st JOIN trips t USING (trip_key) JOIN rclass rc USING (rc) JOIN stop_map m USING (stop_key) JOIN tzoff z ON z.tz = rc.tz
          WHERE rc.cls IN ('rail', 'coach') AND NOT t.has_freq AND m.city IN (SELECT DISTINCT city FROM hint)),
        j AS (SELECT h.htrip, k.trip_key, k.seq, h.city, h.bits FROM hint h JOIN k ON k.city = h.city AND (abs(k.ud - h.ud) <= 2 OR abs(k.ua - h.ua) <= 2)),
        mt AS (SELECT htrip, trip_key, count(DISTINCT city)::INTEGER AS nc FROM j GROUP BY ALL HAVING count(DISTINCT city) >= 2)
        SELECT j.htrip, j.trip_key, j.seq, bit_or(j.bits)::INTEGER AS bits, any_value(mt.nc) AS nc FROM j JOIN mt USING (htrip, trip_key)
        GROUP BY j.htrip, j.trip_key, j.seq ORDER BY ALL`);
      await db.run(`DROP TABLE IF EXISTS hint`);
      const digitsOf = (x: string | null | undefined) => (x ? (/(\d{2,6})/.exec(x)?.[1] ?? null) : null);
      let added = 0;
      const trips = new Set<number>(), used = new Set<number>();
      for (const m of matches) {
        if (!m.bits || dropped.has(m.trip_key)) continue;
        const rc = rclass.get(tRc[m.trip_key]!);
        const a = digitsOf(hintNum.get(m.htrip)), b = digitsOf(tShort[m.trip_key] ?? (rc ? displayName(rc.short, rc.long, "", rc.agency).number : null));
        // another number: the same train only when it calls at ≥ 3 of the cities at the same times (Eurostar runs
        // NS's 9315 as 9415 on some days)
        if (a && b && a !== b && m.nc < 3) continue;
        let e = limitExtra.get(m.trip_key);
        if (!e) limitExtra.set(m.trip_key, (e = new Map()));
        e.set(m.seq, (e.get(m.seq) ?? 0) | m.bits);
        trips.add(m.trip_key);
        used.add(m.htrip);
        added++;
      }
      log(`stop restrictions of ${hintNum.size} trips left to a dedicated operator's feed: ${used.size} matched, ${added} restrictions added to ${trips.size} trips`);
      stats.hintLimitTrips = trips.size;
    }
  }
  // A restriction taken from another copy is the train's rule, not the day's: it also goes to the trips of the same
  // feed with the same number and the same cities on days the other feed does not cover or with other times.
  if (limitExtra.size) {
    const feedsWith = [...new Set([...limitExtra.keys()].map((k) => tFeed[k]!))];
    const rows = await db.all<{ trip_key: number; feed: number; short_name: string; cities: number[]; seqs: number[] }>(`
      SELECT st.trip_key, t.feed, t.short_name, list(m.city ORDER BY st.seq) AS cities, list(st.seq ORDER BY st.seq) AS seqs
      FROM stop_times st JOIN trips t USING (trip_key) JOIN stop_map m USING (stop_key)
      WHERE t.feed IN (${feedsWith.join(",")}) AND coalesce(trim(t.short_name), '') <> '' GROUP BY ALL ORDER BY st.trip_key`);
    const groups = new Map<string, { trip: number; seqs: number[] }[]>();
    for (const r of rows) {
      if (dropped.has(r.trip_key)) continue;
      const k = `${r.feed}|${r.short_name}|${[...r.cities].join(",")}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push({ trip: r.trip_key, seqs: [...r.seqs] });
    }
    let spread = 0;
    for (const g of groups.values()) {
      if (g.length < 2 || !g.some((x) => limitExtra.has(x.trip))) continue;
      const bits: number[] = [];
      for (const x of g) {
        const e = limitExtra.get(x.trip);
        if (e) x.seqs.forEach((sq, i) => (bits[i] = (bits[i] ?? 0) | (e.get(sq) ?? 0)));
      }
      for (const x of g) {
        if (limitExtra.has(x.trip)) continue;
        const e = new Map<number, number>();
        x.seqs.forEach((sq, i) => bits[i] && e.set(sq, bits[i]!));
        if (!e.size) continue;
        limitExtra.set(x.trip, e);
        spread++;
      }
    }
    log(`stop restrictions from other copies spread to ${spread} more trips of the same train (number, cities)`);
    stats.spreadLimitTrips = spread;
  }

  // ------------------------------------------------------------------ through runs
  // One train published as consecutive trips with the same number (stay seated at the station where one
  // ends and the next begins): joined into one run on the days all pieces operate (core/through.ts).
  const pieceRows = await db.all<{ trip_key: number; stations: number[]; dep: number; arr: number }>(`
    WITH fl AS (
      SELECT st.trip_key, t.feed, t.short_name, arg_min(m.station, st.seq) AS fst, arg_max(m.station, st.seq) AS lst,
        min(st.dep)::INTEGER AS fdep, max(st.arr)::INTEGER AS larr
      FROM stop_times st JOIN trips t USING (trip_key) JOIN rclass rc USING (rc) JOIN stop_map m USING (stop_key)
      WHERE rc.cls = 'rail' AND NOT t.has_freq AND coalesce(trim(t.short_name), '') <> ''
      GROUP BY ALL),
    cand AS (
      SELECT a.trip_key AS ta, b.trip_key AS tb FROM fl a JOIN fl b
        ON a.feed = b.feed AND a.short_name = b.short_name AND b.fst = a.lst AND a.trip_key <> b.trip_key
          AND b.fdep - a.larr BETWEEN 0 AND ${MAX_THROUGH_DWELL}),
    keys AS (SELECT ta AS trip_key FROM cand UNION SELECT tb FROM cand)
    SELECT st.trip_key, list(m.station ORDER BY st.seq) AS stations, min(st.dep)::INTEGER AS dep, max(st.arr)::INTEGER AS arr
    FROM stop_times st JOIN stop_map m USING (stop_key) WHERE st.trip_key IN (SELECT trip_key FROM keys)
    GROUP BY st.trip_key ORDER BY st.trip_key`);
  const pieces: RunPiece[] = [];
  for (const r of pieceRows) {
    const k = r.trip_key;
    const mask = extraMask.get(k) ?? svcMask.get(tSvc[k]!);
    const rc = rclass.get(tRc[k]!);
    if (dropped.has(k) || !mask || !rc || !(tCat[k]! & (Cat.LongDistance | Cat.Regional))) continue;
    pieces.push({ key: k, feed: tFeed[k]!, number: tShort[k] ?? "", tz: rc.tz, stations: [...r.stations], dep: r.dep, arr: r.arr, mask });
  }
  const through = findThroughRuns(pieces);
  /** trip key → [run index, position in the run] */
  const throughOf = new Map<number, [number, number]>();
  through.runs.forEach((run, i) => run.keys.forEach((k, j) => throughOf.set(k, [i, j])));
  log(`through runs: ${pieces.length} candidate pieces, ${through.runs.length} runs joined from ${throughOf.size} trips (${through.rest.size} pieces keep other days as their own run)`);
  stats.throughRuns = through.runs.length;
  stats.throughPieces = throughOf.size;

  // ------------------------------------------------------------------ patterns
  timer.start("patterns");
  const freq = new Map<number, { s: number; e: number; h: number }[]>();
  for (const r of await db.all<{ trip_key: number; start_min: number; end_min: number; headway_s: number }>(`SELECT trip_key, start_min, end_min, headway_s FROM frequencies ORDER BY ALL`)) {
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
  /** per route: a high-speed service (TGV, ICE, AVE…; steers rail geometry onto / off high-speed lines) */
  const routeHs: boolean[] = [];
  const routeIndex = new Map<string, number>();
  const store = new PatternStore();
  const masks = new MaskStore();
  const tripP: number[] = [], tripS: number[] = [], tripC: number[] = [];
  const tripN: (string | undefined)[] = [];
  let patternDays: number[] = [];
  const stationWeight = (s: number) => stations[s]!.weight;
  const cityPop = (c: number) => cities[c]!.population;
  /** Named places (GeoNames towns and villages) are bus destinations; unnamed stop clusters are not. */
  const busPlace = (c: number) => !cities[c]!.synthetic;
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
  const cityRail = new Uint8Array(cities.length);
  for (const st of stations) if (st.rail) cityRail[st.city] = 1;
  const cityHasRail = (c: number) => cityRail[c] === 1;
  /** A joined through run: its days, the last piece's headsign and the pieces with a feed shape. */
  interface Joined {
    mask: Uint8Array;
    headsign: string | null;
    shapeTrips: number[];
  }
  const finalize = (tk: number, raw: RawStop[], joined?: Joined) => {
    if (dropped.has(tk)) return;
    const rc = rclass.get(tRc[tk]!);
    if (!rc) return;
    const cat = tCat[tk]!;
    if (cat === Cat.Bus)
      for (const r of raw) {
        const c = busCanon[r.city]!;
        if (c >= 0 && c !== r.station && stations[r.station]!.cats === Cat.Bus) {
          r.real = r.station;
          r.station = c;
        }
      }
    const shape = processTripStops(raw, { cat, cityPop, stationWeight, cityHasRail, busPlace, stationPos: (s) => [stations[s]!.lon, stations[s]!.lat] });
    if (!shape) {
      droppedTrips++;
      return;
    }
    const dn = rc.pname ? { name: rc.pname, number: tShort[tk] ?? undefined } : displayName(rc.short, rc.long, tShort[tk] ?? "", rc.agency);
    // Older databases (--reuse-db) may still carry the removed Deutschlandticket bit (1).
    const flags = tFlags[tk]! & (Flag.Night | CAVEAT_FLAGS);
    const color = rc.color && /^[0-9a-fA-F]{6}$/.test(rc.color) ? rc.color.toUpperCase() : undefined;
    // operator adapters (packages/etl/operators): brand / high-speed of routes their data does not name
    const ex = cfg.operators?.routeExtras({ feed: feedRef.get(rc.feed)!, agency: rc.agency, name: dn.name, short: rc.short, long: rc.long, cat, routeType: rc.routeType }) ?? {};
    const rkey = `${dn.name}\u0001${rc.agency}\u0001${cat}\u0001${flags}\u0001${color ?? ""}\u0001${ex.brand ?? ""}`;
    let route = routeIndex.get(rkey);
    if (route === undefined) {
      route = routes.length;
      const r: Route = { name: dn.name, agency: rc.agency, cat: cat as CatBit, flags };
      if (color) r.color = color;
      if (ex.brand) r.brand = ex.brand;
      routes.push(r);
      routeHs.push(cat !== Cat.Bus && cat !== Cat.Coach && isHighSpeedService({ routeType: rc.routeType, agency: rc.agency, names: [rc.pname ?? "", rc.short, rc.long, dn.name, tShort[tk] ?? ""], highSpeed: ex.highSpeed }));
      routeIndex.set(rkey, route);
    }
    const utc = rc.tz === "UTC";
    const tz = utc ? cities[shape.cities[0]!]!.tz : rc.tz;
    // no headsign: the run's real last stop (may be a stop left out of the pattern)
    const lastRaw = raw[raw.length - 1]!;
    const headsign = ((joined ? joined.headsign : tHead[tk]) ?? "").trim() || stations[lastRaw.real ?? lastRaw.station]!.name;
    const shapeTrips = joined ? joined.shapeTrips : tShape[tk]! >= 0 ? [tk] : [];
    const pid = store.add({
      route,
      stations: shape.stations,
      cities: shape.cities,
      arr: shape.arr,
      dep: shape.dep,
      headsign,
      tz: tzId(tz),
      shapeTrip: shapeTrips[0] ?? -1,
      ...(shapeTrips.length > 1 ? { shapeAlt: shapeTrips.slice(1) } : {}),
      ...(shape.via.length ? { via: shape.via } : {}),
      ...(shape.at.length ? { at: shape.at } : {}),
      ...(shape.limits.length ? { limits: shape.limits } : {}),
    });
    const base = joined ? joined.mask : (through.rest.get(tk) ?? extraMask.get(tk) ?? svcMask.get(tSvc[tk]!));
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

  // pieces of a through run are collected until the run is complete, then finalized as one trip (the first
  // piece's key); a piece that also runs on days without the others is finalized on those days by itself
  const runParts: (RawStop[] | undefined)[][] = through.runs.map((r) => new Array(r.keys.length));
  const runLeft = through.runs.map((r) => r.keys.length);
  const take = (tk: number, raw: RawStop[]) => {
    const at = throughOf.get(tk);
    if (!at) return finalize(tk, raw);
    const [ri, pos] = at;
    const run = through.runs[ri]!;
    runParts[ri]![pos] = raw;
    if (through.rest.has(tk)) finalize(tk, raw.map((r) => ({ ...r })));
    if (--runLeft[ri]! > 0) return;
    const parts = runParts[ri]! as RawStop[][];
    runParts[ri] = [];
    const last = run.keys[run.keys.length - 1]!;
    finalize(run.keys[0]!, parts.flat(), { mask: run.mask, headsign: tHead[last] ?? null, shapeTrips: run.keys.filter((k) => tShape[k]! >= 0) });
  };

  let cur = -1;
  let raw: RawStop[] = [];
  let nRows = 0;
  let curExtra: Map<number, number> | undefined;
  await db.stream(
    `SELECT st.trip_key, m.station, m.city, st.arr, st.dep, st.seq, st.pd FROM stop_times st JOIN stop_map m USING (stop_key)
     ORDER BY st.trip_key, st.seq, st.dep, st.arr, m.station`,
    (c, n) => {
      const k = c[0]!, s = c[1]!, ci = c[2]!, a = c[3]!, d = c[4]!, sq = c[5]!, pdc = c[6]!;
      for (let r = 0; r < n; r++) {
        const tk = k[r] as number;
        if (tk !== cur) {
          if (cur >= 0) take(cur, raw);
          cur = tk;
          raw = [];
          curExtra = limitExtra.get(tk);
        }
        const pd = ((pdc[r] as number | null) ?? 0) | (curExtra?.get(sq[r] as number) ?? 0);
        raw.push({ station: s[r] as number, city: ci[r] as number, arr: a[r] as number, dep: d[r] as number, ...(pd ? { pd } : {}) });
      }
      nRows += n;
      if (nRows % 20_000_000 < n) log(`  patterns: ${nRows} stop_times streamed, ${store.patterns.length} patterns, ${tripP.length} trips`);
    },
  );
  if (cur >= 0) take(cur, raw);
  const patterns = store.patterns;
  patternDays = Array.from({ length: patterns.length }, (_, i) => patternDays[i] ?? 0);
  log(`${patterns.length} patterns, ${tripP.length} trips, ${masks.masks.length} calendars, ${routes.length} routes, ${droppedTrips} trips dropped (<2 cities)`);
  anchorCitiesAtMainStation(cities, stations, patterns, patternDays, (p) => routes[patterns[p]!.route]!.cat, log);

  // ------------------------------------------------------------------ corridors
  // The drawn network connects stations: every hop between two consecutive, different stations of a
  // pattern is a corridor (undirected, keyed by the station pair), inside a city as well as between cities.
  timer.start("corridors");
  const RAIL = Cat.LongDistance | Cat.Regional;
  interface CorrAcc {
    a: number;
    b: number;
    cats: number;
    tpd: Record<number, number>;
    /** rail trains per day of high-speed services */
    tpdHs: number;
    /** fastest scheduled time (min) between the two stations: high-speed services / other trains */
    minHs: number;
    minConv: number;
    shapeTrip: number;
    /** other pieces of a joined through run with a feed shape (tried when shapeTrip's shape misses the hop) */
    shapeAlt?: number[];
    shapeW: number;
  }
  const corrIndex = new Map<number, number>();
  const corrs: CorrAcc[] = [];
  const patternCorr: number[][] = [];
  const NSTA = stations.length;
  for (let p = 0; p < patterns.length; p++) {
    const pt = patterns[p]!;
    const w = patternDays[p]!;
    const route = routes[pt.route]!;
    const list: number[] = [];
    for (let i = 0; i + 1 < pt.stations.length; i++) {
      const s1 = pt.stations[i]!, s2 = pt.stations[i + 1]!;
      const [a, b] = s1 < s2 ? [s1, s2] : [s2, s1];
      const key = a * NSTA + b;
      let id = corrIndex.get(key);
      if (id === undefined) {
        id = corrs.length;
        corrIndex.set(key, id);
        corrs.push({ a, b, cats: 0, tpd: {}, tpdHs: 0, minHs: Infinity, minConv: Infinity, shapeTrip: -1, shapeW: 0 });
      }
      list.push(id);
      if (!w) continue;
      const cr = corrs[id]!;
      cr.cats |= route.cat;
      cr.tpd[route.cat] = (cr.tpd[route.cat] ?? 0) + w / D;
      if (route.cat & RAIL) {
        const hs = routeHs[pt.route]!;
        const dt = pt.arr[i + 1]! - pt.dep[i]!;
        if (hs) cr.tpdHs += w / D;
        if (dt > 0) {
          if (hs) cr.minHs = Math.min(cr.minHs, dt);
          else cr.minConv = Math.min(cr.minConv, dt);
        }
      }
      if (pt.shapeTrip >= 0 && w > cr.shapeW) [cr.shapeTrip, cr.shapeAlt, cr.shapeW] = [pt.shapeTrip, pt.shapeAlt, w];
    }
    patternCorr.push(list);
  }
  log(`${corrs.length} corridors (${corrs.filter((c) => stations[c.a]!.city === stations[c.b]!.city).length} inside a city)`);

  // shapes for representative hops
  const neededShapes = new Map<number, number>(); // shape_key → trip
  for (const c of corrs) for (const t of c.shapeTrip >= 0 ? [c.shapeTrip, ...(c.shapeAlt ?? [])] : []) neededShapes.set(tShape[t]!, t);
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
  // Douglas-Peucker tolerance (m) of the stored line geometry (per line-graph segment). Routed lines
  // follow track / road, so they keep the detail of the (already 20-50 m) graph geometry; unsnapped
  // fallbacks are smooth curves that only need enough points to stay curved.
  const SNAPPED_TOL_M = 12, CURVE_TOL_M = 60;
  const reqs = corrs.map((c, id) => {
    const A = stations[c.a]!, B = stations[c.b]!;
    const hop: { from: [number, number]; to: [number, number]; shape?: [number, number][] } = { from: [A.lon, A.lat], to: [B.lon, B.lat] };
    for (const t of c.shapeTrip >= 0 ? [c.shapeTrip, ...(c.shapeAlt ?? [])] : []) {
      const sp = shapePts.get(tShape[t]!);
      const sl = sp && sliceShape(sp, hop.from, hop.to);
      if (sl) {
        hop.shape = sl;
        break;
      }
    }
    // rail trains per day: how much this hop tells the router about the track it uses (geometry/guide.ts)
    const tpdLong = Math.round((c.tpd[Cat.LongDistance] ?? 0) * 100) / 100;
    const tpd = Math.round(((c.tpd[Cat.LongDistance] ?? 0) + (c.tpd[Cat.Regional] ?? 0)) * 100) / 100;
    const mode = (c.cats & RAIL ? "rail" : "road") as "rail" | "road";
    const req: GeometryRequest = { id, mode, hops: [hop], a: hop.from, b: hop.to, anchored: true, tpd, tpdLong };
    if (mode === "rail") {
      if (c.tpdHs > 0) req.tpdHs = Math.round(c.tpdHs * 100) / 100;
      if (Number.isFinite(c.minHs)) req.minHs = c.minHs;
      if (Number.isFinite(c.minConv)) req.minConv = c.minConv;
    }
    return req;
  });
  if (process.env.ETBM_DUMP_GEOM_REQS) await writeFile(process.env.ETBM_DUMP_GEOM_REQS, JSON.stringify(reqs));
  // The database is not needed any more: close it and release big JS structures
  // before geometry (which runs its own DuckDB instance on a large extract).
  await db.run("CHECKPOINT");
  db.close();
  stopRows.length = 0;
  stopIns.length = 0;
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
      // Rail graph: env ETBM_RAIL_GRAPH or <work>/geometry/rail-graph-v1.bin (R2 asset). noExtract: the
      // regular build never runs the slow Overture extraction (that is the asset refresh's job);
      // without a graph, rail corridors become unsnapped curves.
      geoms = await mod.buildGeometries(reqs, { workDir: args.work, log, noExtract: !args.extractRail });
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
  const stationDep = new Float64Array(stations.length);
  const cityTrips = new Float64Array(cities.length);
  const cityCats = new Uint8Array(cities.length);
  const stationCats = new Uint8Array(stations.length);
  for (let p = 0; p < patterns.length; p++) {
    if (!patternDays[p]) continue;
    const pt = patterns[p]!;
    const cat = routes[pt.route]!.cat;
    const wCat = cat === Cat.LongDistance ? 3 : cat === Cat.Coach ? 1.5 : cat === Cat.Regional ? 1 : 0.3;
    const seen = new Set<number>();
    for (let k = 0; k + 1 < pt.stations.length; k++) stationDep[pt.stations[k]!]! += patternDays[p]! / D;
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
      outStations.push({ id: usedStation[s]!, city: usedCity[st.city]!, name: st.name, lon: round5(st.lon), lat: round5(st.lat), cats: stationCats[s]!, tpd: Math.round(stationDep[s]! * 10) / 10 });
    }
  const outCities: City[] = cityOrder.map((c, i) => {
    const cr = cities[c]!;
    // representative point: the main station (anchorCitiesAtMainStation), else the GeoNames point
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
  // corridors (stations are the endpoints)
  const corrNew = new Int32Array(corrs.length).fill(-1);
  const outCorr: Corridor[] = [];
  const corrTol = new Map<Corridor, number>();
  let snappedN = 0;
  corrs.forEach((c, id) => {
    if (!c.cats) return;
    const a = usedStation[c.a]!, b = usedStation[c.b]!;
    if (a < 0 || b < 0) return;
    const g = geomById.get(id);
    const A = stations[c.a]!, B = stations[c.b]!;
    const raw = g?.coords ?? greatCircle([A.lon, A.lat], [B.lon, B.lat]);
    const tol = g?.snapped ? SNAPPED_TOL_M : CURVE_TOL_M;
    // full-resolution geometry; simplified per line-graph segment below
    const coords = raw.map(([x, y]) => [round5(x), round5(y)] as [number, number]);
    // orient from new a to new b
    const flip = a > b;
    if (flip) coords.reverse();
    const tpd: Partial<Record<CatBit, number>> = {};
    for (const k of CAT_BITS) if (c.tpd[k]) tpd[k] = Math.round(c.tpd[k]! * 10) / 10;
    const cor: Corridor = { id: outCorr.length, a: flip ? b : a, b: flip ? a : b, coords, cats: c.cats, tpd, snapped: !!g?.snapped };
    if (cor.snapped) snappedN++;
    corrTol.set(cor, tol);
    corrNew[id] = outCorr.length;
    outCorr.push(cor);
  });
  // Order corridors by (a, b) so ids are stable-ish and pack well.
  {
    const order = outCorr.map((_, i) => i).sort((x, y) => outCorr[x]!.a - outCorr[y]!.a || outCorr[x]!.b - outCorr[y]!.b);
    const newIdOfOld = new Int32Array(outCorr.length);
    order.forEach((old, i) => (newIdOfOld[old] = i));
    const sorted = order.map((old, i) => {
      const c = outCorr[old]!;
      c.id = i;
      return c;
    });
    outCorr.length = 0;
    for (const c of sorted) outCorr.push(c);
    for (let k = 0; k < corrNew.length; k++) if (corrNew[k]! >= 0) corrNew[k] = newIdOfOld[corrNew[k]!]!;
  }
  // Line graph: shared track/road geometry is stored and drawn once (NetworkFile.segments).
  timer.start("segments");
  const segRes = buildSegments(
    outCorr.map((c) => ({
      coords: c.coords,
      cats: c.cats,
      tpd: c.tpd as Record<number, number>,
      snapped: c.snapped,
      tol: corrTol.get(c) ?? 150,
      rail: (c.cats & RAIL) !== 0,
    })),
  );
  const outSegs: Segment[] = segRes.segments.map((sg, i) => {
    const tpd: Partial<Record<CatBit, number>> = {};
    for (const k of CAT_BITS) if (sg.tpd[k]) tpd[k] = Math.round(sg.tpd[k]! * 10) / 10;
    const o: Segment = { id: i, coords: sg.coords.map(([x, y]) => [round5(x), round5(y)] as [number, number]), cats: sg.cats, tpd, snapped: sg.snapped };
    return o;
  });
  let noSeg = 0;
  outCorr.forEach((c, i) => {
    const l = segRes.corrSegs[i]!;
    if (!l.length) {
      // tiny corridor absorbed entirely into a junction: keeps its own polyline
      noSeg++;
      c.coords = simplifyLine(c.coords, corrTol.get(c) ?? 150).map(([x, y]) => [round5(x), round5(y)] as [number, number]);
      return;
    }
    c.segs = l;
    c.coords = segmentPath(l, outSegs);
  });
  if (noSeg) log(`${noSeg} corridors without segments (own polyline)`);
  aggregateSegments(outCorr, outSegs);
  log(`${outSegs.length} line-graph segments for ${outCorr.length} corridors`);
  timer.start("output");

  const build = args.build ?? `${args.startDate.replace(/-/g, "")}-${new Date().toISOString().slice(11, 16).replace(":", "")}`;
  const outRoot = args.out;
  const outDir = join(outRoot, build);
  await mkdir(join(outDir, "shard"), { recursive: true });
  // remove older builds
  if (existsSync(outRoot))
    for (const e of await readdir(outRoot)) {
      if (e !== build && e !== "manifest.json" && /^\d{8}-\d{4}/.test(e)) await rm(join(outRoot, e), { recursive: true, force: true });
    }

  const network: NetworkFile = { schema: SCHEMA_VERSION, build, timezones, cities: outCities, stations: outStations, corridors: outCorr, segments: outSegs };
  const calendars: CalendarsFile = { startDate: args.startDate, days: D, masks: masks.masks };

  // transit transfers between the stations of a city (metro / tram / suburban rail timetables, urban/transit.ts)
  let transitByCity = new Map<number, number[][]>();
  const transitStats: Record<string, number> = {};
  if (args.transit) {
    timer.start("transit");
    try {
      const tfeeds = await gatherTransitFeeds({ cfg, urbanFeeds: await loadUrbanFeedDefs(), workDir: args.work, assetsDir: args.assets, startDate: args.startDate, download: true, log });
      const tr = computeTransit(tfeeds, outCities, outStations, log);
      transitByCity = tr.byCity;
      Object.assign(transitStats, tr.stats);
    } catch (e) {
      warn(`transit: transfer times by local transport failed, building without them: ${(e as Error).stack ?? e}`);
    }
    timer.start("output");
  }

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

  // every station pair of a city within walking or cycling range (TRANSFER_MAX_M ≈ 9.9 km: a 1 h ride; a walk is
  // offered up to WALK_MAX_MIN ≈ 2 h) gets a transfer, stored as walking minutes (the web app derives the cycling
  // minutes and applies the cap of the chosen mode, see packages/shared/src/walk.ts); farther pairs have none
  const maxWalk = TRANSFER_MAX_M;
  let totalBytes = 0;
  const sizes: { city: string; bytes: number }[] = [];
  let fileCount = 0;
  // City files are packed into shards of neighbouring cities (Hilbert order), so the
  // destinations needed for onward connections usually arrive with the same request.
  const SHARD_TARGET = 1_800_000, CITY_ALONE = 20_000_000;
  const hilbertOrder = outCities.map((_, i) => i).sort((a, b) => hilbertKey(outCities[a]!) - hilbertKey(outCities[b]!));
  const shardOf = new Int32Array(outCities.length).fill(-1);
  let shardParts: string[] = [], shardBytes = 0, shardCities: number[] = [], nShards = 0;
  const flushShard = async () => {
    if (!shardParts.length) return;
    const json = `{"cities":{${shardParts.join(",")}}}`;
    await writeFile(join(outDir, "shard", `${nShards}.json`), json);
    for (const c of shardCities) shardOf[c] = nShards;
    nShards++;
    fileCount++;
    totalBytes += json.length;
    shardParts = [];
    shardBytes = 0;
    shardCities = [];
  };
  // Full stop lists of the runs (Pattern.run) live in schedule files (sched/), one per SCHEDULE_GROUP shards:
  // only a trip's schedule needs them. Each run and stop is stored once per file.
  class ScheduleAcc {
    readonly file: ScheduleFile = { stops: [], runs: [] };
    private stopIdx = new Map<number, number>();
    private runIdx = new Map<number, number>();
    private stop(s: number): number {
      let i = this.stopIdx.get(s);
      if (i === undefined) {
        const st = stations[s]!;
        this.stopIdx.set(s, (i = this.file.stops.length));
        this.file.stops.push([st.name, round5(st.lon), round5(st.lat), usedCity[st.city] ?? -1]);
      }
      return i;
    }
    run(p: number): number {
      let i = this.runIdx.get(p);
      if (i === undefined) {
        const pt = patterns[p]!;
        const r: ScheduleRun = {};
        if (pt.via) r.via = pt.via.map((x, k) => (k % 4 === 1 ? this.stop(x) : x));
        if (pt.at) r.at = pt.at.map((x, k) => (k % 2 === 1 ? this.stop(x) : x));
        this.runIdx.set(p, (i = this.file.runs.length));
        this.file.runs.push(r);
      }
      return i;
    }
  }
  let schedGroup = 0, schedAcc = new ScheduleAcc(), schedRuns = 0, schedStops = 0, schedFiles = 0, schedBytes = 0;
  const writeSchedule = async (name: string, acc: ScheduleAcc) => {
    if (!acc.file.runs.length) return;
    await mkdir(join(outDir, "sched"), { recursive: true });
    const json = JSON.stringify(acc.file);
    await writeFile(join(outDir, "sched", `${name}.json`), json);
    schedRuns += acc.file.runs.length;
    schedStops += acc.file.stops.length;
    schedFiles++;
    schedBytes += Buffer.byteLength(json);
    fileCount++;
    totalBytes += json.length;
  };
  for (const c of hilbertOrder) {
    const plist = patternsByCity[c]!;
    const localRoute = new Map<number, number>();
    const rOut: Route[] = [];
    const pOut: Pattern[] = [];
    const pTz: number[] = [];
    const tOut: Trip[] = [];
    const withRun: [local: number, pattern: number][] = []; // patterns with a full stop list (Pattern.run)
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
      const po: Pattern = {
        route: lr,
        stations: pt.stations.map((s) => usedStation[s]!),
        arr: pt.arr,
        dep: pt.dep,
        corridors: patternCorr[p]!.map((x) => corrNew[x]!),
        headsign: pt.headsign,
      };
      if (pt.limits) po.limits = pt.limits;
      if (pt.via || pt.at) withRun.push([li, p]);
      pOut.push(po);
      pTz.push(pt.tz);
      for (let k = tStartIdx[p]!; k < tStartIdx[p + 1]!; k++) {
        const t = tOrder[k]!;
        let num = tripN[t];
        const rn = routes[pt.route]!.name;
        if (num && rn && num.startsWith(rn + " ")) num = num.slice(rn.length + 1);
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
    const transit = transitByCity.get(c);
    if (transit) cf.transit = transit;
    let json = JSON.stringify(cf);
    const bytes = Buffer.byteLength(json);
    sizes.push({ city: `${outCities[c]!.name} (${c})`, bytes });
    const setRuns = (acc: ScheduleAcc) => {
      for (const [li, p] of withRun) pOut[li]!.run = acc.run(p);
      if (withRun.length) json = JSON.stringify(cf);
    };
    if (bytes > CITY_ALONE) {
      // too big for a shard: stand-alone city/<id>.json (City.shard stays undefined)
      const acc = new ScheduleAcc();
      setRuns(acc);
      await mkdir(join(outDir, "city"), { recursive: true });
      await writeFile(join(outDir, "city", `${c}.json`), json);
      await writeSchedule(`c${c}`, acc);
      fileCount++;
      totalBytes += json.length;
      continue;
    }
    if (shardBytes && shardBytes + bytes > SHARD_TARGET) await flushShard();
    // the shard this city goes into is `nShards`: its schedule file is that of its group of shards
    const group = Math.floor(nShards / SCHEDULE_GROUP);
    if (group !== schedGroup) {
      await writeSchedule(String(schedGroup), schedAcc);
      schedGroup = group;
      schedAcc = new ScheduleAcc();
    }
    setRuns(schedAcc);
    shardParts.push(`"${c}":${json}`);
    shardCities.push(c);
    shardBytes += bytes;
  }
  await flushShard();
  await writeSchedule(String(schedGroup), schedAcc);
  log(`schedules: ${schedRuns} full stop lists, ${schedStops} listed stops in ${schedFiles} files, ${(schedBytes / 1e6).toFixed(1)} MB`);
  outCities.forEach((city, i) => {
    if (shardOf[i]! >= 0) city.shard = shardOf[i]!;
  });
  sizes.sort((a, b) => b.bytes - a.bytes);
  log(`${nShards} city shards`);

  // attribution
  const attribution = buildAttribution(ctx);
  // The network is written in the compact columnar form (NetworkFile.packed).
  const files: [string, unknown][] = [];
  const packedNet: NetworkFile = { schema: SCHEMA_VERSION, build, timezones, cities: [], stations: [], corridors: [], packed: packNetwork(network) };
  files.push(["network.json", packedNet]);
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

  // basemap: small GeoJSON layers (borders, country labels) per build + land / lake vector tiles shared by all builds
  let basemapInfo: Manifest["basemap"];
  if (args.basemap) {
    timer.start("basemap");
    try {
      const bmOut = join(outDir, "basemap");
      const bmAsset = join(args.assets, "basemap");
      const modPath = join(import.meta.dirname, "../../web/scripts/basemap.ts");
      const tarFile = join(args.assets, BASEMAP_TILES_KEY);
      const haveTiles = existsSync(tarFile);
      const files = haveTiles ? BASEMAP_FILES : [...BASEMAP_FILES, "land.json", "lakes.json"];
      const have = files.every((f) => existsSync(join(bmAsset, f)));
      if (have || existsSync(modPath)) {
        if (have) log(`basemap: using asset ${bmAsset}`);
        else {
          const mod = (await import(modPath)) as { buildBasemap: (o: { outDir: string; cacheDir?: string; legacyLayers?: boolean; log?: (s: string) => void }) => Promise<void> };
          await mod.buildBasemap({ outDir: bmAsset, cacheDir: join(ctx.cacheDir, "basemap"), legacyLayers: !haveTiles, log });
        }
        await mkdir(bmOut, { recursive: true });
        for (const f of files) if (existsSync(join(bmAsset, f))) await copyFile(join(bmAsset, f), join(bmOut, f));
        for (const f of await readdir(bmOut)) {
          totalBytes += (await stat(join(bmOut, f))).size;
          fileCount++;
        }
      } else warn("basemap script not found, skipping");
      if (haveTiles) {
        const n = await installBasemapTiles(tarFile, outRoot);
        const bytes = (await readFile(join(outRoot, BASEMAP_DIR, "index.json"), "utf8")).length;
        basemapInfo = { version: BASEMAP_VERSION, dir: BASEMAP_DIR, minzoom: BASEMAP_MINZOOM, maxzoom: BASEMAP_MAXZOOM, bounds: EUROPE_BBOX };
        stats.basemapTiles = n - 1;
        log(`basemap: ${n} tile files unpacked to ${join(outRoot, BASEMAP_DIR)} (index ${(bytes / 1024).toFixed(0)} KiB)`);
      } else warn(`basemap: ${BASEMAP_TILES_KEY} not in the assets; drawing the coarse 1:50m land / lakes (run the refresh-assets workflow)`);
    } catch (e) {
      warn(`basemap failed: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ progressive map data
  // core.json, stations.json, vector tiles of the drawn network, per-shard geo files
  timer.start("mapdata");
  const md = await writeMapData(network, outDir, log);
  totalBytes += md.bytes;
  fileCount += md.files;

  // ------------------------------------------------------------------ local transport (display layer, own pass over the feed zips)
  let urbanInfo: Manifest["urban"];
  let urbanStats: Record<string, number> = {};
  if (args.urban) {
    timer.start("urban");
    try {
      const ur = await writeUrbanLayer({ buildDir: outDir, work: args.work, assets: args.assets, startDate: args.startDate, stations: network.stations, licenses: ctx.licenses, log });
      urbanInfo = ur.info;
      urbanStats = ur.stats;
      totalBytes += ur.bytes;
      fileCount += ur.files;
    } catch (e) {
      warn(`urban: local transport layer failed, building without it: ${(e as Error).stack ?? e}`);
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
    segments: outSegs.length,
    corridorsSnapped: snappedN,
    patterns: patterns.length,
    trips: tripP.length,
    calendars: masks.masks.length,
    routes: routes.length,
    files: fileCount,
    outputBytes: totalBytes,
  });
  Object.assign(stats, urbanStats, transitStats);
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
  const sanity = runSanity({ network, calendars, readCity: (id) => readCityCache(outDir, id, outCities[id]?.shard), readSchedule: (id) => readScheduleCache(outDir, outCities[id]!) });
  for (const w of sanity.warnings) warn(`sanity: ${w}`);
  for (const e of sanity.errors) warn(`SANITY ERROR: ${e}`);
  timer.end();

  stats.durationSec = Math.round((Date.now() - ctx.t0) / 1000);
  const manifest: Manifest = { schema: SCHEMA_VERSION, build, generatedAt: new Date().toISOString(), startDate: args.startDate, days: D, stats, mapdata: md.mapdata, transfers: md.transfers, ...(basemapInfo ? { basemap: basemapInfo } : {}), ...(urbanInfo ? { urban: urbanInfo } : {}) };
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
  // What the operator adapters changed: load-time rows (operator_log, kept with the database) and build-time ones.
  {
    const ops: Record<string, Record<string, number>> = {};
    for (const r of await db.all<{ adapter: string; feed: string; field: string; n: number }>(`SELECT adapter, feed, field, sum(n)::INTEGER AS n FROM operator_log GROUP BY ALL ORDER BY ALL`).catch(() => []))
      (ops[r.adapter] ??= {})[`${r.field}@${r.feed}`] = r.n;
    for (const [a, m] of Object.entries(cfg.operators?.summary() ?? {})) Object.assign((ops[a] ??= {}), m);
    report.operators = ops;
    for (const a of Object.keys(ops).sort()) log(`operator ${a}: ${Object.entries(ops[a]!).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  }
  // The report goes to the work dir, not into the published data.
  await writeFile(join(args.work, "build-report.json"), JSON.stringify(report, null, 1));
  await rm(join(outRoot, "build-report.json"), { force: true });
  await writeFile(join(outRoot, "manifest.json"), JSON.stringify(manifest));
  log(`build ${build}: ${JSON.stringify(stats)}`);
  log(`biggest city files: ${sizes.slice(0, 8).map((s) => `${s.city} ${(s.bytes / 1e6).toFixed(1)}MB`).join(", ")}`);
  if (sanity.errors.length) {
    console.error(`sanity check failed with ${sanity.errors.length} structural errors`);
    process.exitCode = 1;
  }
}

import { readFileSync } from "node:fs";
let shardCache: { n: number; data: { cities: Record<string, CityFile> } } | null = null;
function readCityCache(outDir: string, id: number, shard: number | undefined): CityFile | null {
  try {
    if (shard === undefined) return JSON.parse(readFileSync(join(outDir, "city", `${id}.json`), "utf8")) as CityFile;
    if (shardCache?.n !== shard) shardCache = { n: shard, data: JSON.parse(readFileSync(join(outDir, "shard", `${shard}.json`), "utf8")) };
    return shardCache.data.cities[String(id)] ?? null;
  } catch {
    return null;
  }
}

let schedCache: { path: string; data: ScheduleFile | null } | null = null;
function readScheduleCache(outDir: string, city: City): ScheduleFile | null {
  const path = scheduleFile(city);
  if (schedCache?.path !== path) {
    let data: ScheduleFile | null = null;
    try {
      data = JSON.parse(readFileSync(join(outDir, path), "utf8")) as ScheduleFile;
    } catch {
      /* no schedule file */
    }
    schedCache = { path, data };
  }
  return schedCache.data;
}

/** Position on a 2^16×2^16 Hilbert curve over the map bounding box. */
function hilbertKey(c: { lon: number; lat: number }): number {
  const n = 1 << 16;
  let x = Math.max(0, Math.min(n - 1, Math.floor(((c.lon - BBOX.minLon) / (BBOX.maxLon - BBOX.minLon)) * n)));
  let y = Math.max(0, Math.min(n - 1, Math.floor(((c.lat - BBOX.minLat) / (BBOX.maxLat - BBOX.minLat)) * n)));
  let d = 0;
  for (let s = n >> 1; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0, ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = n - 1 - x;
        y = n - 1 - y;
      }
      [x, y] = [y, x];
    }
  }
  return d;
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
  const seen = new Set<string>();
  for (const rf of ctx.feeds) {
    // one entry per feed definition (multi-file feeds collapse into one line)
    if (!used.has(rf.key) || seen.has(rf.def.id)) continue;
    seen.add(rf.def.id);
    const e = rf.transitousFile ? lic.get(rf.transitousFile) : undefined;
    const src: AttributionFile["sources"][number] = e
      ? {
          name: rf.def.name,
          license: e.spdx_license_identifier ?? (e.license_url ? "see terms" : "unknown"),
          url: e.license_url ?? e.publisher?.url ?? undefined,
          attribution: e.publisher?.name,
        }
      : { name: rf.def.name, license: rf.def.license ?? "see source", url: rf.def.licenseUrl, attribution: rf.def.attribution };
    if (!src.url) delete src.url;
    if (!src.attribution || rf.def.name.toLowerCase().includes(src.attribution.toLowerCase())) delete src.attribution;
    sources.push(src);
  }
  sources.push(
    { name: "Transitous (feed mirror)", license: "various", url: "https://transitous.org/" },
    { name: "GeoNames", license: "CC-BY-4.0", url: "https://www.geonames.org/" },
    { name: "OpenStreetMap via Overture Maps (rail geometry)", license: "ODbL-1.0", url: "https://www.openstreetmap.org/copyright", attribution: "© OpenStreetMap contributors" },
    { name: "Natural Earth (borders, lakes)", license: "Public Domain", url: "https://www.naturalearthdata.com/" },
    { name: "OpenStreetMap land polygons (coastline)", license: "ODbL-1.0", url: "https://osmdata.openstreetmap.de/data/land-polygons.html", attribution: "© OpenStreetMap contributors" },
  );
  return { sources };
}

export const BASEMAP_FILES = ["borders.json", "labels.json"];

