/**
 * Geocode store of the feed generators: where the stops of a generated feed get their coordinates.
 *
 * One reviewed JSON file per generator, `packages/etl/data/geocodes/<generator id>.json` (in git: every position is
 * a reviewed fact with a diff, like data/stop-names.json). A generator never guesses a position:
 *
 *   - a stop that is in the file (by name, ignoring case, accents and punctuation, or by an alias) is used;
 *   - a stop that is NOT in the file is reported (`ctx.needsGeocoding`, via `finish()`) and the routes / trains that call
 *     at it are left out of the feed; everything else is built. The build never fails for it. If nothing is left,
 *     the generator fails with `NeedsGeocodingError`. Either way the build report names every such stop of the run and
 *     says what to do (`pnpm --filter @etbm/etl run geocode -- <id>`, src/generators/geocode.ts: looks them up on
 *     OpenStreetMap, writes them as unchecked entries, prints what the reviewing agent must look at);
 *   - an entry with `checked: null` (written by that tool, not yet reviewed) counts as missing in the same way;
 *   - entries that the timetable no longer mentions are simply unused: removed stops are not an error.
 *
 * File format:
 *   { "version": 1, "country": "es",
 *     "entries": { "<KEY>": { "name": "Puerto de Mazarrón", "lat": 37.566, "lon": -1.2663, "source": "osm",
 *                              "checked": "2026-10-26", "approx": false, "aliases": ["PUERTO DE MAZARRON"] } } }
 *   KEY = geoKey(source spelling): upper case, no accents, only letters and digits ("PUERTOMAZARRON").
 *   source: "osm" (Nominatim hit, checked), "osm-auto" (written by the geocode tool), "manual", "estimate"
 *   (approx: true – a village placed from the road order, ±3 km), "api" for coordinates copied from the operator.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GeneratorError } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const GEOCODES_DIR = join(here, "../../data/geocodes");

/** Key of a stop name: upper case, no accents, only letters and digits ("Río de Baza" = "RIO DE BAZA"). */
export const geoKey = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

export interface GeocodeEntry {
  /** Display name of the stop. */
  name: string;
  lat: number;
  lon: number;
  source: string;
  /** Date of the review (YYYY-MM-DD); null = looked up automatically, not yet reviewed (the build refuses it). */
  checked: string | null;
  /** Estimated position (±3 km). */
  approx?: boolean;
  /** Other spellings in the source (matched by geoKey as well). */
  aliases?: string[];
  /** Reviewed decision to leave this place out of the feed (no certain position exists); lat / lon are then 0. */
  skip?: boolean;
  /** Free text for the reviewer (the geocode tool writes why it is unsure). */
  note?: string;
}
export interface GeocodeFile {
  version: 1;
  /** ISO 3166 alpha-2, lower case: restricts the OSM lookups of the geocode tool. */
  country?: string;
  entries: Record<string, GeocodeEntry>;
}
export interface MissingStop {
  name: string;
  /** Where the source mentions it (table, line, train…). */
  context: string;
  /** In the store but not reviewed yet. */
  unchecked?: boolean;
}

/** A source stop without (reviewed) coordinates: the generator fails, a human / agent geocodes and checks. */
export class NeedsGeocodingError extends GeneratorError {
  constructor(
    readonly generatorId: string,
    readonly missing: MissingStop[],
  ) {
    const fresh = missing.filter((m) => !m.unchecked), unchecked = missing.filter((m) => m.unchecked);
    const list = (l: MissingStop[]) => l.slice(0, 25).map((m) => `"${m.name}" (${m.context})`).join("; ") + (l.length > 25 ? `; … ${l.length - 25} more` : "");
    super(
      `${missing.length} stop(s) need geocoding` +
        (fresh.length ? ` – new in the timetable, not in data/geocodes/${generatorId}.json: ${list(fresh)}` : "") +
        (unchecked.length ? ` – looked up but not reviewed yet (checked: null): ${list(unchecked)}` : "") +
        `. Routes calling there are left out of the feed (nothing else is left here). An agent has to geocode and check them: run \`pnpm --filter @etbm/etl run geocode -- ${generatorId}\` (OSM lookup, writes unchecked entries, prints leg-speed checks), ` +
        `correct wrong positions by hand, run it with --accept, commit the file (see .claude/skills/add-virtual-feed/SKILL.md).`,
    );
    this.name = "NeedsGeocodingError";
  }
}

export class GeocodeStore {
  private readonly index = new Map<string, GeocodeEntry>();
  private readonly seen = new Map<string, MissingStop>();
  /** Keys of entries the run used (the geocode tool lists unused ones). */
  readonly used = new Set<string>();

  constructor(
    readonly id: string,
    readonly file: GeocodeFile,
    private readonly allowUnchecked = false,
  ) {
    for (const [k, e] of Object.entries(file.entries)) {
      this.index.set(k, e);
      for (const a of e.aliases ?? []) this.index.set(geoKey(a), e);
      this.index.set(geoKey(e.name), e);
    }
  }

  /** Load `<dir>/<id>.json`; a missing file is an empty store (every stop is then reported as new). */
  static async load(id: string, dir = GEOCODES_DIR): Promise<GeocodeStore> {
    const path = join(dir, `${id}.json`);
    const file: GeocodeFile = existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as GeocodeFile) : { version: 1, entries: {} };
    if (file.version !== 1) throw new Error(`${path}: unknown version ${file.version}`);
    return new GeocodeStore(id, file, process.env.ETBM_GEOCODES_UNCHECKED === "1");
  }

  /** Like load(), synchronously (for tables a generator exports at import time). */
  static loadSync(id: string, dir = GEOCODES_DIR): GeocodeStore {
    const path = join(dir, `${id}.json`);
    const file: GeocodeFile = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as GeocodeFile) : { version: 1, entries: {} };
    return new GeocodeStore(id, file, process.env.ETBM_GEOCODES_UNCHECKED === "1");
  }

  /** Usable entries as `{ display name: [lat, lon] }`. */
  positions(): Record<string, [number, number]> {
    return Object.fromEntries(Object.values(this.file.entries).filter((e) => (e.checked || this.allowUnchecked) && !e.skip).map((e) => [e.name, [e.lat, e.lon] as [number, number]]));
  }

  /** The entry for a source name (reviewed or not), without recording anything. */
  lookup(name: string): GeocodeEntry | undefined {
    return this.index.get(geoKey(name));
  }

  /**
   * The reviewed entry for a source name, or undefined – the stop is then recorded as missing (with `context`) and
   * `assertComplete()` fails at the end of the run, naming all of them at once.
   */
  resolve(name: string, context: string): GeocodeEntry | undefined {
    const key = geoKey(name);
    const e = this.index.get(key);
    if (e && (e.checked || this.allowUnchecked)) {
      this.used.add(geoKey(e.name));
      return e;
    }
    if (!this.seen.has(key)) this.seen.set(key, { name, context, ...(e ? { unchecked: true } : {}) });
    return undefined;
  }

  get missing(): MissingStop[] {
    return [...this.seen.values()];
  }

  assertComplete(): void {
    if (this.seen.size) throw new NeedsGeocodingError(this.id, this.missing);
  }

  /**
   * End of a generator run: report the missing stops and what was dropped for them (the build report and the log carry
   * it); fails with NeedsGeocodingError only when nothing is left to build (`kept` = routes / trips kept).
   */
  finish(ctx: { needsGeocoding(m: MissingStop[], dropped: string[]): void }, dropped: string[], kept: number): void {
    if (!this.seen.size) return;
    ctx.needsGeocoding(this.missing, dropped);
    if (!kept) throw new NeedsGeocodingError(this.id, this.missing);
  }
}

/** Bounding box of a store's entries, widened by `pad` degrees: the area the geocode tool searches. */
export function boundsOf(file: GeocodeFile, pad = 0.6): { west: number; south: number; east: number; north: number } | null {
  const es = Object.values(file.entries).filter((e) => e.checked && !e.approx && !e.skip);
  if (!es.length) return null;
  return {
    west: Math.min(...es.map((e) => e.lon)) - pad,
    east: Math.max(...es.map((e) => e.lon)) + pad,
    south: Math.min(...es.map((e) => e.lat)) - pad,
    north: Math.max(...es.map((e) => e.lat)) + pad,
  };
}

/** Write a store file: sorted keys, one entry per line (reviewable diffs). */
export async function saveGeocodes(id: string, file: GeocodeFile, dir = GEOCODES_DIR): Promise<void> {
  const keys = Object.keys(file.entries).sort();
  const lines = keys.map((k) => ` ${JSON.stringify(k)}: ${JSON.stringify(file.entries[k])}`);
  const head = `{"version": 1${file.country ? `, "country": ${JSON.stringify(file.country)}` : ""}, "entries": {\n`;
  await writeFile(join(dir, `${id}.json`), head + lines.join(",\n") + "\n}}\n");
}
