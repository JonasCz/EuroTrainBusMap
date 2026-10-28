/**
 * Stops of the other feeds (real GTFS) near a geocoded stop of a generated feed: the geocode tool (geocode.ts) puts a
 * new stop on the existing stop of the same place instead of on the OSM hit, so the map shows one station rather than
 * two markers ("Mazarron" from the OSM town node 1 km from the "Mazarrón" bus stop of the regional feed).
 *
 * The stops come from the DuckDB database of a local data build (`work/etl.duckdb`, `local-build-deploy` skill), read
 * only; the generated feeds themselves are left out. Without a database the tool works as before and says so.
 */
import { existsSync } from "node:fs";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { Cat } from "@etbm/shared";
import { isTerminalName, normalizeStopName } from "../core/names.ts";
import { haversineKm } from "./gtfs.ts";

export interface RefStop {
  name: string;
  lat: number;
  lon: number;
  /** feed id (feeds.json) */
  feed: string;
  /** trips calling here (choice between stops of one name) */
  trips: number;
  rail: boolean;
}

export interface Snap {
  ref: RefStop;
  /** distance from the OSM position (km) */
  km: number;
  /** why this stop: "same name", "bus station", "busiest stop named like the place" */
  why: string;
}

/** Same name: any stop within this radius (km) of the OSM position. */
export const SNAP_SAME_NAME_KM = 3;
/** A bus / coach station of the place (named like it, or with a generic name). */
export const SNAP_TERMINAL_KM = 2;
/** The busiest stop whose name starts with the place name ("Mazarrón Av. Constitución" for "Mazarrón"). */
export const SNAP_CONTAINS_KM = 1.5;

/** Words that only say "station" ("Estación de Autobuses", "Autobusni kolodvor", "Bratislava, AS", "E. Moreda"). */
const GENERIC_WORDS = new Set("autobus autobuses autobusos bus buses busbahnhof zob station estacion terminal gare routiere autostazione autogara otogar autobusni autobuska kolodvor stanica dworzec autobusowy central centrale as e".split(" "));
/** Particles that some spellings leave out ("Bruck an der Mur" / "Bruck/Mur"). */
const PARTICLES = new Set("de del la las los el an der die am im d di du le les sur na nad pod".split(" "));
/** The words that name the place: normalised, without station words. */
const placeWords = (name: string) => normalizeStopName(name).split(" ").filter((w) => w && !GENERIC_WORDS.has(w));
// brackets kept: "Estacion de Autobuses (Torrevieja)" names its town
const genericTerminal = (name: string) => placeWords(name.replace(/[()[\]]/g, " ")).every((w) => PARTICLES.has(w));
/** Same place name: the same words apart from particles ("Mazarrón" = "Mazarron", "Madrid Estación Sur" = "MADRID Estación Autobuses SUR"; not "Odense Zoo" = "Odense"). */
function sameName(a: string[], b: string[]): boolean {
  const x = new Set(a.filter((w) => !PARTICLES.has(w))), y = new Set(b.filter((w) => !PARTICLES.has(w)));
  return x.size > 0 && x.size === y.size && [...x].every((w) => y.has(w));
}

/**
 * Which stops a generated feed's stop may be put on: a train stops at the railway station, a bus at a bus stop (the
 * town's railway station is often 1–2 km outside: Fiñana, Granada); "any" for a feed with both.
 */
export type SnapMode = "rail" | "bus" | "any";

/** The mode of a generated feed from its feeds.json `keep` classes. */
export function snapModeOf(keep: readonly string[]): SnapMode {
  const rail = keep.includes("rail"), road = keep.some((k) => k !== "rail");
  return rail && !road ? "rail" : road && !rail ? "bus" : "any";
}

/**
 * The existing stop a generated stop named `name`, found by OSM at `lat`/`lon`, should be put on, or null.
 * Pure. Only stops of the feed's mode count (`mode`). Preference: same name (bus before rail: coaches stop at the bus
 * station), then a bus station of the place, then the busiest stop named after the place; within a tier the busiest,
 * then the nearest.
 */
export function pickRefStop(name: string, lat: number, lon: number, refs: RefStop[], mode: SnapMode = "any"): Snap | null {
  const cands: { s: Snap; tier: number }[] = [];
  const own = placeWords(name);
  for (const r of refs) {
    if ((mode === "rail" && !r.rail) || (mode === "bus" && r.rail)) continue;
    const km = haversineKm(lat, lon, r.lat, r.lon);
    if (km > SNAP_SAME_NAME_KM) continue;
    const term = !r.rail && isTerminalName(r.name);
    // the stop's name starts with the place name ("Murcia Plaza" for "Murcia"; not "Mazarrón" for "Puerto de
    // Mazarrón", not "Port d'Alcúdia" for "Alcúdia")
    const words = placeWords(r.name);
    const named = own.length > 0 && own.every((w, i) => words[i] === w);
    if (sameName(own, words)) cands.push({ s: { ref: r, km, why: "same name" }, tier: r.rail ? 1 : 0 });
    else if (term && km <= SNAP_TERMINAL_KM && (named || genericTerminal(r.name))) cands.push({ s: { ref: r, km, why: "bus station" }, tier: 2 });
    else if (named && km <= SNAP_CONTAINS_KM) cands.push({ s: { ref: r, km, why: "busiest stop named like the place" }, tier: 3 });
  }
  cands.sort((a, b) => a.tier - b.tier || b.s.ref.trips - a.s.ref.trips || a.s.km - b.s.km);
  return cands[0]?.s ?? null;
}

/** Reads the stops of a build database around given positions. */
export class RefStops {
  private constructor(
    private readonly conn: DuckDBConnection,
    private readonly exclude: string[],
    private readonly mode: SnapMode,
  ) {}

  /** Open `path` read-only; null when there is no database (or it is locked by a running build). */
  static async open(path: string, excludeFeeds: string[], mode: SnapMode = "any"): Promise<RefStops | string> {
    if (!existsSync(path)) return `no database at ${path}`;
    try {
      const inst = await DuckDBInstance.create(path, { access_mode: "READ_ONLY" });
      return new RefStops(await inst.connect(), excludeFeeds, mode);
    } catch (e) {
      return `cannot open ${path}: ${(e as Error).message.split("\n")[0]}`;
    }
  }

  /** Stops with trips within `km` of a position (a box query, then the exact distance). */
  async near(lat: number, lon: number, km = SNAP_SAME_NAME_KM): Promise<RefStop[]> {
    const dLat = km / 111, dLon = km / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
    const ex = this.exclude.map((f) => `'${f.replace(/'/g, "''")}'`).join(", ") || "''";
    const rail = Cat.LongDistance | Cat.Regional;
    const r = await this.conn.runAndReadAll(`
      SELECT s.name, s.lat, s.lon, f.id AS feed, count(DISTINCT st.trip_key)::INTEGER AS trips,
             bool_or((rc.cat & ${rail}) <> 0) AS rail
      FROM stops s JOIN feeds f ON f.feed = s.feed
      JOIN stop_times st ON st.stop_key = s.stop_key
      JOIN trips t ON t.trip_key = st.trip_key JOIN rclass rc ON rc.rc = t.rc
      WHERE s.lat BETWEEN ${lat - dLat} AND ${lat + dLat} AND s.lon BETWEEN ${lon - dLon} AND ${lon + dLon}
        AND f.id NOT IN (${ex})
      GROUP BY s.name, s.lat, s.lon, f.id`);
    return (r.getRowObjects() as unknown as RefStop[])
      .map((x) => ({ ...x, lat: Number(x.lat), lon: Number(x.lon), trips: Number(x.trips), rail: !!x.rail }))
      .filter((x) => x.name && haversineKm(lat, lon, x.lat, x.lon) <= km);
  }

  /** Where `name` (found by OSM at lat/lon) should be: see pickRefStop. */
  async snap(name: string, lat: number, lon: number): Promise<Snap | null> {
    return pickRefStop(name, lat, lon, await this.near(lat, lon), this.mode);
  }
}
