import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GeocodeStore, NeedsGeocodingError, boundsOf, geoKey, saveGeocodes, type GeocodeFile } from "../src/generators/geocodes.ts";
import { GeneratorState } from "../src/generators/state.ts";
import { mapLimit } from "../src/generators/pool.ts";

const file = (): GeocodeFile => ({
  version: 1,
  country: "es",
  entries: {
    BAZA: { name: "Baza", lat: 37.49, lon: -2.77, source: "osm", checked: "2026-10-26" },
    PUERTOMAZARRON: { name: "Puerto de Mazarrón", lat: 37.57, lon: -1.27, source: "osm", checked: "2026-10-26", aliases: ["PUERTO DE MAZARRÓN"] },
    NEWTOWN: { name: "Newtown", lat: 37.6, lon: -2.6, source: "osm-auto", checked: null },
    NOWHERE: { name: "Nowhere", lat: 0, lon: 0, source: "none", checked: "2026-10-26", skip: true },
  },
});

describe("geocode store", () => {
  it("keys ignore case, accents and punctuation; aliases resolve to the same entry", () => {
    expect(geoKey("Río de Baza (Granada)")).toBe("RIODEBAZAGRANADA");
    expect(geoKey("Čapljina")).toBe("CAPLJINA");
    const s = new GeocodeStore("t", file());
    expect(s.resolve("baza", "x")?.name).toBe("Baza");
    expect(s.resolve("PUERTO DE MAZARRÓN", "x")).toBe(s.resolve("Puerto de Mazarron", "x"));
    expect(s.resolve("Nowhere", "x")?.skip).toBe(true);
    expect(() => s.assertComplete()).not.toThrow();
  });

  it("unknown and unreviewed stops are collected and fail together with instructions", () => {
    const s = new GeocodeStore("es-x", file());
    expect(s.resolve("Brand New", "table 3")).toBeUndefined();
    expect(s.resolve("Newtown", "table 4")).toBeUndefined(); // looked up, not reviewed
    expect(s.resolve("Brand New", "table 5")).toBeUndefined(); // reported once
    let err: unknown;
    try {
      s.assertComplete();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NeedsGeocodingError);
    const e = err as NeedsGeocodingError;
    expect(e.missing).toEqual([
      { name: "Brand New", context: "table 3" },
      { name: "Newtown", context: "table 4", unchecked: true },
    ]);
    expect(e.message).toMatch(/2 stop\(s\) need geocoding.*new in the timetable.*"Brand New" \(table 3\).*not reviewed yet.*"Newtown"/s);
    expect(e.message).toMatch(/run geocode -- es-x/);
  });

  it("unreviewed entries are usable when explicitly allowed (the review run of the geocode tool)", () => {
    const s = new GeocodeStore("t", file(), true);
    expect(s.resolve("Newtown", "x")?.lat).toBe(37.6);
    expect(Object.keys(s.positions())).toContain("Newtown");
    expect(Object.keys(new GeocodeStore("t", file()).positions())).not.toContain("Newtown");
    expect(Object.keys(s.positions())).not.toContain("Nowhere"); // skipped places have no position
  });

  it("the area searched for new stops is the box of the reviewed ones", () => {
    const b = boundsOf(file(), 0.5)!;
    expect(b.west).toBeCloseTo(-3.27);
    expect(b.east).toBeCloseTo(-0.77);
  });

  it("writes sorted keys, one entry per line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "etbm-geo-"));
    try {
      await saveGeocodes("t", file(), dir);
      const text = await readFile(join(dir, "t.json"), "utf8");
      expect(JSON.parse(text)).toEqual(file());
      expect(text.split("\n").filter((l) => l.startsWith(' "')).map((l) => l.slice(1, 7))).toEqual(['"BAZA"', '"NEWTO', '"NOWHE', '"PUERT']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("generator state", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "etbm-state-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("tells new, unchanged and changed content, and forgets pages that are gone", async () => {
    const st = new GeneratorState();
    const d1 = new Date("2026-10-01T00:00:00Z"), d2 = new Date("2026-10-08T00:00:00Z"), d3 = new Date("2026-10-15T00:00:00Z");
    expect(st.observe("g", "a", "table 1", d1)).toMatchObject({ isNew: true, changed: false, lastChanged: "2026-10-01" });
    expect(st.observe("g", "a", "table 1", d2)).toMatchObject({ isNew: false, changed: false, lastChanged: "2026-10-01" });
    expect(st.observe("g", "a", "table 1 (10:05)", d3)).toMatchObject({ isNew: false, changed: true, firstSeen: "2026-10-01", lastChanged: "2026-10-15" });
    st.observe("g", "b", "x", d3);
    const path = join(dir, "state.json");
    await st.save(path);
    const again = await GeneratorState.load(path);
    expect(again.knownPages("g").sort()).toEqual(["a", "b"]);
    expect(again.retain("g", ["a"])).toEqual(["b"]);
    expect(again.knownPages("g")).toEqual(["a"]);
    expect((await GeneratorState.load(join(dir, "missing.json"))).knownPages("g")).toEqual([]);
  });
});

describe("mapLimit", () => {
  it("runs at most `limit` at a time and keeps the order", async () => {
    let running = 0, peak = 0;
    const out = await mapLimit([30, 5, 20, 1, 10], 2, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((ok) => setTimeout(ok, ms));
      running--;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });
});

describe("run summary", () => {
  it("lists what needs geocoding, failures and changed pages for an agent", async () => {
    const { summarize, renderText } = await import("../src/run-summary.ts");
    const report = {
      build: "b1",
      generated: [
        { id: "es-busbam", feed: "es-busbam", ok: true, counts: { trips: 80 }, needsGeocoding: { stops: [{ name: "VILLA NUEVA", context: "table 7" }], dropped: ["VAC-250 Murcia – Torrevieja"] }, pages: [{ key: "almeria-madrid", changed: true, isNew: false, lastChanged: "2026-10-27" }], removedPages: ["old-line"] },
        { id: "ba-zfbih", feed: "ba-zfbih", ok: false, error: "footnote *** changed" },
      ],
      failedFeeds: [],
    };
    const s = summarize(report, [], { GITHUB_RUN_ID: "42", GITHUB_REPOSITORY: "o/r", GITHUB_SHA: "abcdef123456" });
    expect(s.todo[0]).toMatch(/GEOCODE es-busbam: 1 stop\(s\) \(VILLA NUEVA\).*geocode -- es-busbam/);
    expect(s.todo[1]).toMatch(/FIX generator ba-zfbih.*footnote \*\*\* changed/);
    expect(s.generators[0]).toMatchObject({ changedPages: ["almeria-madrid"], removedPages: ["old-line"] });
    expect(s.run.url).toBe("https://github.com/o/r/actions/runs/42");
    expect(renderText(s)).toMatch(/needs geocoding: VILLA NUEVA – table 7/);
    expect(summarize(null, ["boom"], {}).todo[0]).toMatch(/did not finish/i);
  });
});
