/**
 * Reviewed coach/bus stop names (packages/etl/data/stop-names.json): a cached,
 * LLM-reviewed mapping that merges stops into the station they belong to or
 * gives them a local-language display name. See
 * .claude/skills/review-stop-names/SKILL.md for how it is produced.
 *
 * Keys: `<feed id>:<stop_id>` (stable while a feed keeps its ids), with a
 * fallback `~<normalised name>@<x>,<y>` (coordinates on a ~50 m grid) for
 * feeds whose stop ids change between releases.
 */
import { fastDist } from "../util/geo.ts";
import { fold } from "./names.ts";

export type StopNameEntry =
  | { action: "merge"; station: string; near?: [number, number]; note?: string }
  | { action: "rename"; name: string; note?: string }
  | { action: "keep"; note?: string };

export interface StopNamesFile {
  version: 1;
  /** File-level review metadata (model, date, …). */
  meta?: Record<string, unknown>;
  entries: Record<string, StopNameEntry>;
}

export function stopKey(feedId: string, stopId: string): string {
  return `${feedId}:${stopId}`;
}

/** Normalised name: folded, alphanumerics only. */
export function normName(name: string): string {
  return fold(name).replace(/[^a-z0-9]+/g, " ").trim();
}

/** Fallback key: normalised name + position on a ~50 m grid. */
export function stopAltKey(name: string, lon: number, lat: number): string {
  const gx = Math.round((lon * 111_320 * Math.cos((lat * Math.PI) / 180)) / 50);
  const gy = Math.round((lat * 110_540) / 50);
  return `~${normName(name)}@${gx},${gy}`;
}

export function lookupStopName(m: StopNamesFile | null, key: string, altKey: string): StopNameEntry | undefined {
  if (!m) return undefined;
  return m.entries[key] ?? m.entries[altKey];
}

/** Bus stop names that are likely English / exonyms / generic terminal names worth reviewing. */
export const FOREIGN_NAME_RE = new RegExp(
  "\\b(" +
    [
      "bus station", "coach station", "bus terminal", "central station", "main station", "railway station", "train station",
      "central", "airport", "south", "north", "east", "street", "square",
      "vienna", "prague", "munich", "cologne", "nuremberg", "warsaw", "rome", "venice", "florence", "milan", "turin", "naples",
      "genoa", "lisbon", "athens", "belgrade", "bucharest", "copenhagen", "gothenburg", "brussels", "antwerp", "the hague",
      "krakow", "cracow", "wroclaw", "gdansk", "poznan", "lodz", "zurich", "geneva", "lucerne", "moscow",
      "kiev", "kyiv", "lviv", "sofia", "seville", "saragossa", "hanover", "brunswick", "luxembourg city", "pilsen", "thessaloniki",
      "salonica", "bruges", "ghent", "liege", "the", "of",
    ].join("|") +
    ")\\b",
  "i",
);

export interface ApplyStop {
  key: string;
  altKey: string;
  lon: number;
  lat: number;
}

export interface ApplyStation {
  name: string;
  lon: number;
  lat: number;
  city: number;
  rail: boolean;
}

export interface ApplyResult {
  /** Merges performed: stop index → new station index. */
  merged: number;
  /** Display names by station index. */
  renames: Map<number, string>;
  /** Merge targets that could not be found (logged, no change). */
  missing: string[];
}

/**
 * Apply the reviewed mapping after station merging: "merge" moves the stop into
 * the station whose (folded) name matches within `radiusM` of `near` (or of the
 * stop); "rename" sets the display name of the stop's station unless that
 * station has rail stops (their names win); "keep" and unknown keys do nothing.
 * Mutates `stationOf`. Deterministic: candidates are compared by distance.
 */
export function applyStopNames(
  mapping: StopNamesFile | null,
  stops: ApplyStop[],
  stationOf: Int32Array,
  stations: ApplyStation[],
  radiusM = 1500,
): ApplyResult {
  const res: ApplyResult = { merged: 0, renames: new Map(), missing: [] };
  if (!mapping || !Object.keys(mapping.entries).length) return res;
  // index stations by normalised name
  const byName = new Map<string, number[]>();
  stations.forEach((s, i) => {
    const k = normName(s.name);
    let l = byName.get(k);
    if (!l) byName.set(k, (l = []));
    l.push(i);
  });
  stops.forEach((st, i) => {
    const e = lookupStopName(mapping, st.key, st.altKey);
    if (!e) return;
    if (e.action === "merge") {
      const [x, y] = e.near ?? [st.lon, st.lat];
      let best = -1, bd = Infinity;
      for (const j of byName.get(normName(e.station)) ?? []) {
        const s = stations[j]!;
        const d = fastDist(x, y, s.lon, s.lat);
        if (d <= radiusM && d < bd) [best, bd] = [j, d];
      }
      if (best < 0) {
        res.missing.push(`${st.key}: "${e.station}" not found within ${radiusM} m`);
        return;
      }
      if (stationOf[i] !== best) {
        stationOf[i] = best;
        res.merged++;
      }
    } else if (e.action === "rename") {
      const s = stationOf[i]!;
      if (!stations[s]!.rail && e.name.trim()) res.renames.set(s, e.name.trim());
    }
  });
  return res;
}
