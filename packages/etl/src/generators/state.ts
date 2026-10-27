/**
 * Content state of the feed generators: when did a timetable page's CONTENT last change?
 *
 * Server timestamps (Last-Modified, WordPress modified_time) say nothing reliable about the timetable, so every
 * generator hands the normalised content of each timetable it parses (the tables and their notes, not the rest of the
 * page) to `ctx.observe(key, content)`. The state keeps its hash and the first / last-changed / last-seen times per
 * page, in ONE JSON file for all generators (`work/generator-state.json`; the build workflow keeps it in R2 between
 * weekly builds, build-deploy.yml, object `generator-state.json`). Without the file (first build, local run, tests)
 * every page is new and "changed" is false.
 *
 *   { "version": 1, "generators": { "es-busbam": { "almeria-madrid": { "hash": "…", "firstSeen": "2026-10-27",
 *       "lastChanged": "2026-10-27", "lastSeen": "2026-10-27" } } } }
 *
 * The state only informs (build report, log, "page removed" warnings); it never decides whether a feed is built.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PageState {
  hash: string;
  firstSeen: string;
  lastChanged: string;
  lastSeen: string;
}
export interface StateFile {
  version: 1;
  generators: Record<string, Record<string, PageState>>;
}
export interface Observation {
  key: string;
  hash: string;
  isNew: boolean;
  /** The content differs from the last build's. */
  changed: boolean;
  firstSeen: string;
  lastChanged: string;
}

export const contentHash = (content: string): string => createHash("sha256").update(content).digest("hex").slice(0, 16);

export class GeneratorState {
  constructor(private data: StateFile = { version: 1, generators: {} }) {}

  static async load(path: string): Promise<GeneratorState> {
    try {
      if (existsSync(path)) {
        const d = JSON.parse(await readFile(path, "utf8")) as StateFile;
        if (d.version === 1 && d.generators) return new GeneratorState(d);
      }
    } catch {
      // unreadable state = no state
    }
    return new GeneratorState();
  }

  /** Pages of a generator seen by the last saved build. */
  knownPages(id: string): string[] {
    return Object.keys(this.data.generators[id] ?? {});
  }

  /** Record one page's content for a generator; the new state is kept in memory until save(). */
  observe(id: string, key: string, content: string, now = new Date()): Observation {
    const day = now.toISOString().slice(0, 10);
    const hash = contentHash(content);
    const pages = (this.data.generators[id] ??= {});
    const prev = pages[key];
    const changed = !!prev && prev.hash !== hash;
    pages[key] = { hash, firstSeen: prev?.firstSeen ?? day, lastChanged: !prev || changed ? day : prev.lastChanged, lastSeen: day };
    return { key, hash, isNew: !prev, changed, firstSeen: pages[key]!.firstSeen, lastChanged: pages[key]!.lastChanged };
  }

  /** Forget the pages of a generator that this run did not see (removed from the operator's site). */
  retain(id: string, seen: string[]): string[] {
    const pages = this.data.generators[id];
    if (!pages) return [];
    const gone = Object.keys(pages).filter((k) => !seen.includes(k));
    for (const k of gone) delete pages[k];
    return gone;
  }

  async save(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path + ".tmp", JSON.stringify(this.data, null, 1) + "\n");
    await rename(path + ".tmp", path);
  }
}
