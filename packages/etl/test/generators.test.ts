import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Db } from "../src/db.ts";
import { GENERATORS_DIR, loadFeedsConfig, resolveFeeds, type FeedDef, type FeedsConfig } from "../src/feeds.ts";
import { initSchema, loadFeed } from "../src/gtfs/load.ts";
import { dateRange, gtfsFiles, isoWeekday, timetableChange, timetablePeriod, validateGtfs, type GtfsFeed } from "../src/generators/gtfs.ts";
import { applyGenerators, generatorContext, loadGeneratorFiles, runGenerator, serviceWindow, type GeneratorSet } from "../src/generators/registry.ts";
import { GeneratorError, type FeedGenerator, type GeneratorContext } from "../src/generators/types.ts";
import zfbih, { FOOTNOTES, STATIONS, parseMainPage, parsePairPage } from "../generators/ba-zfbih.ts";

const here = import.meta.dirname;
const FIX = join(here, "fixtures", "zfbih");
const START = "2026-10-18";
const DAYS = 60;

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/**
 * A fake site: the timetable page (optionally edited) and the station form answers of the fixtures; any other pair
 * answers "no trains", as the real form does for stations no common train serves.
 */
async function fakeSite(edit: (html: string) => string = (h) => h) {
  const main = edit(await readFile(join(FIX, "timetable.html"), "utf8"));
  const pairs = new Map<string, string>();
  for (const f of await readdir(FIX)) {
    const m = /^pair-(.+)-(.+)\.html$/.exec(f);
    if (m) pairs.set([m[1], m[2]].sort().join("|"), await readFile(join(FIX, f), "utf8"));
  }
  const none = pairs.get("fojnica|sarajevo")!;
  const queries: string[] = [];
  const fetchText: GeneratorContext["fetchText"] = async (_url, opts) => {
    if (!opts?.form) return main;
    const a = opts.form.redvoznje_pol!, b = opts.form.redvoznje_dol!;
    queries.push(`${a}|${b}`);
    const html = pairs.get([slug(a), slug(b)].sort().join("|"));
    // answers keep the station names of the request (the fixture may have been asked the other way round)
    return html ?? none;
  };
  return { fetchText, queries };
}

function ctxWith(fetchText: GeneratorContext["fetchText"], startDate = START, warnings: string[] = []): GeneratorContext {
  return generatorContext({ id: "test", userAgent: "t", startDate, days: DAYS, warnings, fetchText, log: () => {}, warn: () => {} });
}

const stopsOf = (feed: GtfsFeed, trip: string) => {
  const name = new Map(feed.stops.map((s) => [s.stop_id, s.stop_name]));
  return feed.stopTimes.filter((s) => s.trip_id === trip).sort((a, b) => a.stop_sequence - b.stop_sequence).map((s) => name.get(s.stop_id));
};
const datesOf = (feed: GtfsFeed, trip: string) => feed.services.get(feed.trips.find((t) => t.trip_id === trip)!.service_id)!;

describe("GTFS helpers", () => {
  it("annual timetable change: Sunday after the second Saturday of December", () => {
    expect(timetableChange(2025)).toBe("2025-12-14");
    expect(timetableChange(2026)).toBe("2026-12-13");
    expect(timetableChange(2018)).toBe("2018-12-09"); // 1 Dec 2018 was a Saturday
    expect(timetablePeriod("2026-10-18")).toEqual({ start: "2025-12-14", end: "2026-12-12" });
    expect(timetablePeriod("2026-12-13")).toEqual({ start: "2026-12-13", end: "2027-12-11" });
  });

  it("validation refuses dangling ids and times going backwards", () => {
    const feed: GtfsFeed = {
      agency: [{ agency_id: "a", agency_name: "A", agency_url: "https://a.example", agency_timezone: "Europe/Sarajevo" }],
      stops: [
        { stop_id: "x", stop_name: "X", stop_lat: 43.8, stop_lon: 18.4 },
        { stop_id: "y", stop_name: "Y", stop_lat: 43.9, stop_lon: 18.3 },
      ],
      routes: [{ route_id: "r", agency_id: "a", route_short_name: "R", route_long_name: "", route_type: 2 }],
      trips: [{ route_id: "r", service_id: "s", trip_id: "t", trip_headsign: "Y" }],
      stopTimes: [
        { trip_id: "t", stop_sequence: 1, stop_id: "x", arr: 600, dep: 600 },
        { trip_id: "t", stop_sequence: 2, stop_id: "y", arr: 630, dep: 630 },
      ],
      services: new Map([["s", ["2026-10-20"]]]),
      info: { publisher: "p", publisherUrl: "https://p.example", lang: "en", version: "1", sourceUrl: "https://p.example" },
    };
    expect(() => validateGtfs(feed, { from: "2026-10-17", to: "2026-12-17" })).not.toThrow();
    expect(() => validateGtfs(feed, { from: "2026-11-01", to: "2026-12-17" })).toThrow(/no trip runs/);
    feed.stopTimes[1]!.arr = 590;
    expect(() => validateGtfs(feed)).toThrow(/backwards/);
    feed.stopTimes[1]!.arr = 630;
    feed.trips[0]!.route_id = "nope";
    expect(() => validateGtfs(feed)).toThrow(/unknown route/);
    feed.trips[0]!.route_id = "r";
    expect(gtfsFiles(feed)["calendar_dates.txt"]).toBe("service_id,date,exception_type\ns,20261020,1\n");
  });
});

describe("ba-zfbih (ŽFBiH timetable page)", () => {
  it("reads the table, the footnotes and the station form of the page", async () => {
    const page = parseMainPage(await readFile(join(FIX, "timetable.html"), "utf8"));
    expect(page.years).toEqual([2025, 2026]);
    expect(page.rows).toHaveLength(39);
    expect(page.rows[0]).toEqual({ number: "720", marker: "", type: "Fast train", from: "Čapljina", to: "Sarajevo", dep: 6 * 60 + 3, arr: 8 * 60 + 35 });
    expect(page.rows.find((r) => r.number === "392")).toMatchObject({ marker: "*", from: "Ploče", to: "Sarajevo" });
    // "Sarajevo – Pazarić" with an en dash
    expect(page.rows.find((r) => r.number === "2411")).toMatchObject({ from: "Sarajevo", to: "Pazarić" });
    expect([...page.footnotes.keys()]).toEqual(FOOTNOTES.map((f) => f.marker));
    for (const f of FOOTNOTES) expect(page.footnotes.get(f.marker)).toBe(f.text);
    expect(page.stations).toHaveLength(54);
    for (const s of page.stations) expect(STATIONS[s], s).toBeDefined();
  });

  it("reads the station form's answers (both directions, or no trains)", async () => {
    const rows = parsePairPage(await readFile(join(FIX, "pair-sarajevo-konjic.html"), "utf8"), "Sarajevo", "Konjic");
    expect(rows).toContainEqual({ number: "721", from: "Sarajevo", to: "Konjic", dep: 16 * 60 + 46, arr: 17 * 60 + 55 });
    expect(rows).toContainEqual({ number: "720", from: "Konjic", to: "Sarajevo", dep: 7 * 60 + 22, arr: 8 * 60 + 35 });
    expect(parsePairPage(await readFile(join(FIX, "pair-sarajevo-fojnica.html"), "utf8"), "Sarajevo", "Fojnica")).toEqual([]);
    expect(() => parsePairPage("<html><body>Maintenance</body></html>", "Sarajevo", "Konjic")).toThrow(GeneratorError);
  });

  it("happy path: a valid feed with the trains of the window, their stops and calendars", async () => {
    const site = await fakeSite();
    const feed = await zfbih.generate(ctxWith(site.fetchText));
    validateGtfs(feed, serviceWindow(START, DAYS));
    // anchors: Sarajevo, then Maglaj for the Maglaj – Zenica trains; every other form station is asked once per anchor
    expect(site.queries).toHaveLength(2 * 53);
    expect(site.queries[0]).toMatch(/^Sarajevo\|/);
    // 39 trains; the Ploče trains (* until June, ** summer) and 2158 (**** summer) do not run in Oct – Dec 2026
    expect(feed.trips).toHaveLength(32);
    for (const n of ["390", "391", "392", "393", "1390", "1391", "2158"]) expect(feed.trips.some((t) => t.trip_id === n)).toBe(false);
    // intermediate stops from the station form fixtures (Hadžići, Konjic, Mostar), times as in the table at the ends
    expect(stopsOf(feed, "720")).toEqual(["Čapljina", "Mostar", "Konjic", "Hadžići", "Sarajevo"]);
    const st720 = feed.stopTimes.filter((s) => s.trip_id === "720");
    expect(st720.map((s) => s.arr)).toEqual([363, 393, 442, 498, 515]);
    expect(feed.routes.find((r) => r.route_id === feed.trips.find((t) => t.trip_id === "720")!.route_id)).toMatchObject({ route_short_name: "Fast train", route_type: 103, route_long_name: "Čapljina – Sarajevo" });
    expect(feed.routes.find((r) => r.route_id === feed.trips.find((t) => t.trip_id === "2150")!.route_id)).toMatchObject({ route_short_name: "Local train", route_type: 106 });
    // calendars: up to the end of the 2025/26 timetable (12 Dec 2026)
    const all = dateRange("2026-10-17", "2026-12-12");
    expect(datesOf(feed, "720")).toEqual(all);
    const weekdays = datesOf(feed, "2150"); // *** not on weekends and public holidays
    expect(weekdays.every((d) => isoWeekday(d) < 5)).toBe(true);
    expect(weekdays).not.toContain("2026-11-25"); // Statehood Day (Wednesday)
    expect(weekdays).toContain("2026-11-24");
    expect(datesOf(feed, "710").some((d) => isoWeekday(d) === 5)).toBe(false); // not on Saturdays
    expect(datesOf(feed, "711").some((d) => isoWeekday(d) === 6)).toBe(false); // not on Sundays
    expect(datesOf(feed, "2170")).toEqual(all); // daily outside the summer weekends
    // coordinates from the script's station table
    expect(feed.stops.find((s) => s.stop_name === "Sarajevo")).toMatchObject({ stop_lat: 43.86046, stop_lon: 18.39895 });
  });

  it("a changed footnote text fails the source", async () => {
    const site = await fakeSite((h) => h.replace("Trains do not operate on weekends and public holidays.", "Trains do not operate on weekends."));
    await expect(zfbih.generate(ctxWith(site.fetchText))).rejects.toThrow(/footnote \*\*\* changed/);
    expect(site.queries).toHaveLength(0); // before the slow station queries
  });

  it("a new asterisk footnote fails the source", async () => {
    const site = await fakeSite((h) => h.replace("<a>******* Train 711 does not operate on Sundays.</a>", "<a>******* Train 711 does not operate on Sundays.</a><br><br><a>******** Train 2413 operates on Mondays only.</a>"));
    await expect(zfbih.generate(ctxWith(site.fetchText))).rejects.toThrow(/unknown footnote \*{8}/);
  });

  it("a train with an asterisk count that has no footnote fails the source", async () => {
    const site = await fakeSite((h) => h.replace("<td>2413</td>", "<td>2413********</td>"));
    await expect(zfbih.generate(ctxWith(site.fetchText))).rejects.toThrow(/train 2413\*{8}: no footnote/);
  });

  it("a footnote that does not name the train fails the source", async () => {
    const site = await fakeSite((h) => h.replace("<td>2413</td>", "<td>2413******</td>"));
    await expect(zfbih.generate(ctxWith(site.fetchText))).rejects.toThrow(/footnote \*{6} does not name this train/);
  });

  it("a changed table header fails the source", async () => {
    const site = await fakeSite((h) => h.replace("<th>Train type</th>", "<th>Category</th>"));
    await expect(zfbih.generate(ctxWith(site.fetchText))).rejects.toThrow(/table header changed/);
  });

  it("an unreadable row, train type or station fails the source", async () => {
    let site = await fakeSite((h) => h.replace("<td>06:03</td>", "<td>6.03 h</td>"));
    await expect(zfbih.generate(ctxWith(site.fetchText))).rejects.toThrow(/unreadable times/);
    site = await fakeSite((h) => h.replace("<td>Čapljina - Sarajevo</td>", "<td>Čapljina / Sarajevo</td>"));
    await expect(zfbih.generate(ctxWith(site.fetchText))).rejects.toThrow(/unreadable relation/);
    site = await fakeSite((h) => h.replace("<td>720</td><td>Fast train</td>", "<td>720</td><td>Night train</td>"));
    await expect(zfbih.generate(ctxWith(site.fetchText))).rejects.toThrow(/unknown train type/);
    site = await fakeSite((h) => h.replace("<td>Čapljina - Sarajevo</td>", "<td>Neum - Sarajevo</td>"));
    await expect(zfbih.generate(ctxWith(site.fetchText))).rejects.toThrow(/unknown station "Neum"/);
  });

  it("an outdated page (another timetable year) fails the source", async () => {
    const site = await fakeSite();
    await expect(zfbih.generate(ctxWith(site.fetchText, "2027-01-10"))).rejects.toThrow(/timetable 2025\/2026, the current one is 2026\/2027/);
  });

  it("a station form answer that disagrees with the table keeps only the end stations", async () => {
    const site = await fakeSite();
    const warnings: string[] = [];
    const fetchText: GeneratorContext["fetchText"] = async (url, opts) => {
      const html = await site.fetchText(url, opts);
      // Konjic answer: 721 leaves Sarajevo at 16:47 instead of 16:46
      return opts?.form?.redvoznje_dol === "Konjic" ? html.replace("<td>16:46</td><td>17:55</td>", "<td>16:47</td><td>17:55</td>") : html;
    };
    const ctx = generatorContext({ id: "t", userAgent: "t", startDate: START, days: DAYS, warnings, fetchText, log: () => {}, warn: () => {} });
    const feed = await zfbih.generate(ctx);
    expect(stopsOf(feed, "721")).toEqual(["Sarajevo", "Čapljina"]);
    expect(stopsOf(feed, "723")).toEqual(["Sarajevo", "Hadžići", "Konjic", "Mostar", "Čapljina"]);
    expect(warnings.join("\n")).toMatch(/train 721 .*leaves Sarajevo at 16:47 in the station form, 16:46 in the table/);
  });
});

describe("generator registry and build integration", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "etbm-gen-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const def = (id: string, sources: FeedDef["sources"]): FeedDef => ({ id, country: "XX", name: id, tier: "core", keep: ["rail"], sources });
  const set = (...gens: FeedGenerator[]): GeneratorSet => ({ generators: new Map(gens.map((g) => [g.id, g])), fingerprint: 1 });
  const gen = (id: string): FeedGenerator => ({ id, description: "", sourceUrl: `https://example.org/${id}`, generate: async () => fail() });
  const fail = (): never => {
    throw new GeneratorError("page changed");
  };

  it("feeds.json and the generators refer to each other", () => {
    const feeds = [def("xx-a", [{ generated: "xx-a" }])];
    applyGenerators(feeds, set(gen("xx-a")));
    expect(feeds[0]!.timetableUrl).toBe("https://example.org/xx-a");
    expect(() => applyGenerators([def("xx-a", [{ generated: "xx-b" }])], set(gen("xx-a")))).toThrow(/no generator "xx-b"/);
    expect(() => applyGenerators([def("xx-a", [{ generated: "xx-a" }, { url: "https://x" }])], set(gen("xx-a")))).toThrow(/exactly one source/);
    expect(() => applyGenerators([], set(gen("xx-a")))).toThrow(/not used by any feed/);
  });

  it("the repository's generators load, and ba-zfbih replaces the Transitous ŽFBiH feed", async () => {
    const gens = await loadGeneratorFiles(GENERATORS_DIR);
    expect([...gens.generators.keys()]).toContain("ba-zfbih");
    const cfg = await loadFeedsConfig(join(here, "../feeds.json"));
    const ba = cfg.feeds.find((f) => f.id === "ba-zfbih")!;
    expect(ba.sources).toEqual([{ generated: "ba-zfbih" }]);
    expect(ba.timetableUrl).toBe("https://www.zfbh.ba/en/time-table/");
    // the community feed ba_ZFBiH (ŽFBiH and ŽRS, ended 2025-12-13) is out of date: no feed reads it any more
    expect(cfg.feeds.some((f) => f.sources.some((s) => "transitous" in s && s.transitous === "ba_ZFBiH.gtfs.zip"))).toBe(false);
    const rf = await resolveFeeds(cfg, { only: ["ba-zfbih"], tiers: ["core"], cacheDir: dir });
    expect(rf).toEqual([expect.objectContaining({ key: "ba-zfbih", urls: [], generator: "ba-zfbih" })]);
  });

  it("a failing generator is skipped and its old zip removed", async () => {
    const dest = join(dir, "xx-a.zip");
    await writeFile(dest, "old");
    const msgs: string[] = [];
    const { report } = await runGenerator(gen("xx-a"), "xx-a", { userAgent: "t", startDate: START, days: DAYS, dest, tmpDir: dir, log: () => {}, warn: (m) => msgs.push(m) });
    expect(report.ok).toBe(false);
    expect(report.error).toBe("page changed");
    expect(existsSync(dest)).toBe(false);
    expect(msgs.join()).toMatch(/generator xx-a FAILED, feed xx-a skipped: page changed/);
  });

  it("the generated ŽFBiH feed loads through the feed loader", async () => {
    const site = await fakeSite();
    const g: FeedGenerator = { ...zfbih, generate: (ctx) => zfbih.generate({ ...ctx, fetchText: site.fetchText }) };
    const dest = join(dir, "ba-zfbih.zip");
    const { report } = await runGenerator(g, "ba-zfbih", { userAgent: "t", startDate: START, days: DAYS, dest, tmpDir: dir, log: () => {}, warn: () => {} });
    expect(report.ok).toBe(true);
    expect(report.counts).toMatchObject({ trips: 32, firstDate: "2026-10-17", lastDate: "2026-12-12" });
    const cfg: FeedsConfig = await loadFeedsConfig(join(here, "../feeds.json"));
    const [rf] = await resolveFeeds(cfg, { only: ["ba-zfbih"], tiers: ["core"], cacheDir: dir });
    const db = await Db.open(":memory:");
    try {
      await initSchema(db);
      const st = await loadFeed({ db, cfg, startDate: START, days: DAYS, tmpDir: dir, presentFeedIds: new Set(["ba-zfbih"]), dropBus: false }, 0, rf!, dest);
      expect(st.trips).toBe(32);
      expect(st.stops).toBe(10); // the stations of the fixtures' answers
      // fast trains long distance (Cat 1: 720–723, 710, 711), local trains regional (Cat 2)
      expect(st.byCat).toEqual({ "rail:1": 6, "rail:2": 26 });
    } finally {
      db.close();
    }
  });
});
