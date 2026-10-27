import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateGtfs, type GtfsFeed } from "../src/generators/gtfs.ts";
import { generatorContext, loadGeneratorFiles, serviceWindow } from "../src/generators/registry.ts";
import { GeocodeStore, NeedsGeocodingError, geoKey, type GeocodeFile } from "../src/generators/geocodes.ts";
import { GeneratorState } from "../src/generators/state.ts";
import { GeneratorError, type GeneratorContext } from "../src/generators/types.ts";
import { GENERATORS_DIR, loadFeedsConfig } from "../src/feeds.ts";
import busbam, { CALENDARS, buildFeed, contentOf, isHoliday, pageUrl, parseIndex, parsePage, routeTypeOf } from "../generators/es-busbam.ts";

const here = import.meta.dirname;
const FIX = join(here, "fixtures", "busbam");
const START = "2026-10-26";
const DAYS = 60;

const read = (name: string) => readFile(join(FIX, `${name}.html`), "utf8");
const SLUGS = ["almeria-cartagena-alicante", "almeria-jaen", "almeria-madrid", "murcia-torrevieja"];
const STORE_FILE = join(here, "..", "data", "geocodes", "es-busbam.json");
const realStore = async (edit: (f: GeocodeFile) => void = () => {}) => {
  const file = JSON.parse(await readFile(STORE_FILE, "utf8")) as GeocodeFile;
  edit(file);
  return new GeocodeStore("es-busbam", file);
};

/** A fake site: the index and the line pages of the fixtures (plus `extra` pages), optionally edited per page. */
async function fakeSite(edit: (slug: string, html: string) => string = (_, h) => h, extra: Record<string, string> = {}) {
  const pages = new Map<string, string>();
  for (const slug of SLUGS) pages.set(slug, await read(slug));
  for (const [slug, html] of Object.entries(extra)) pages.set(slug, html);
  let index = await read("index");
  for (const slug of Object.keys(extra)) index = index.replace("</main>", `<a href="https://www.busbam.com/horarios/${slug}/">x</a></main>`);
  const fetchText: GeneratorContext["fetchText"] = async (url) => {
    if (url === "https://www.busbam.com/horarios/") return edit("index", index);
    const slug = [...pages.keys()].find((k) => pageUrl(k) === url);
    if (!slug) throw new Error(`unexpected request ${url}`);
    return edit(slug, pages.get(slug)!);
  };
  return { fetchText };
}
function ctxWith(fetchText: GeneratorContext["fetchText"], startDate = START, warnings: string[] = [], state?: GeneratorState): GeneratorContext {
  return generatorContext({ id: "es-busbam", userAgent: "t", startDate, days: DAYS, warnings, fetchText, log: () => {}, warn: (m) => warnings.push(m), ...(state ? { state } : {}) });
}
const stopsOf = (feed: GtfsFeed, trip: string) => {
  const name = new Map(feed.stops.map((s) => [s.stop_id, s.stop_name]));
  return feed.stopTimes.filter((s) => s.trip_id === trip).sort((a, b) => a.stop_sequence - b.stop_sequence).map((s) => name.get(s.stop_id));
};
const timesOf = (feed: GtfsFeed, trip: string) => feed.stopTimes.filter((s) => s.trip_id === trip).sort((a, b) => a.stop_sequence - b.stop_sequence).map((s) => s.dep);
const datesOf = (feed: GtfsFeed, trip: string) => feed.services.get(feed.trips.find((t) => t.trip_id === trip)!.service_id)!;
const tripFrom = (feed: GtfsFeed, route: string, first: string, dep: number) =>
  feed.trips.find((t) => t.route_id === route && stopsOf(feed, t.trip_id)[0] === first && timesOf(feed, t.trip_id)[0] === dep)!.trip_id;

describe("es-busbam (BusBam timetable pages)", () => {
  it("reads the index and the tables of the line pages", async () => {
    expect(parseIndex(await read("index"))).toEqual([...SLUGS].sort());
    const counts: Record<string, number> = {};
    for (const slug of SLUGS) counts[slug] = parsePage(await read(slug), pageUrl(slug)).tables.length;
    expect(counts).toEqual({ "almeria-cartagena-alicante": 4, "almeria-jaen": 13, "almeria-madrid": 2, "murcia-torrevieja": 2 });
    const page = parsePage(await read("almeria-cartagena-alicante"), "x");
    expect(page.line).toBe("VAC-228/250");
    expect(page.tables[1]).toMatchObject({ title: "Cartagena - Almería", head: [["ITINERARIO", "DE LUNES A SÁBADOS", "DOMINGOS Y FESTIVOS", "DIARIO (TODOS LOS DÍAS)"]] });
    expect(page.tables[1]!.body[0]).toEqual(["CARTAGENA", "10:15", "12:15", "15:30"]);
    expect(parsePage(await read("almeria-jaen"), "x").line).toBe("VJA-157 / VJA-158 / VJA-174");
    expect(parsePage(await read("almeria-madrid"), "x").tables[0]!.after).toMatch(/Válido del 02\/11\/2026 al 31\/03\/2027/);
    expect(() => parsePage("<main><h2>x</h2></main>", "https://x")).toThrow(/no "LÍNEA/);
  });

  it("the geocode file: every entry is reviewed, in Spain, and covers the pages", async () => {
    const store = await realStore();
    for (const [k, e] of Object.entries(store.file.entries)) {
      expect(e.checked, k).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.lat, k).toBeGreaterThan(36.5);
      expect(e.lat, k).toBeLessThan(40.6);
      expect(e.lon, k).toBeGreaterThan(-4);
      expect(e.lon, k).toBeLessThan(-0.4);
    }
    expect(store.lookup("Río de Baza")).toBe(store.lookup("RIO DE BAZA"));
    expect(store.lookup("PUERTO DE MAZARRÓN")).toBe(store.lookup("PUERTO MAZARRÓN"));
    expect(routeTypeOf("VAC-216")).toBe(200);
    expect(routeTypeOf("VJA-157 / VJA-158")).toBe(3);
  });

  it("calendar labels: exact rules, holidays are the national ones", () => {
    expect(CALENDARS.length).toBeGreaterThan(10);
    expect(isHoliday("2026-12-08")).toBe(true);
    expect(isHoliday("2027-03-26")).toBe(true); // Good Friday
    expect(isHoliday("2026-12-09")).toBe(false);
  });

  it("happy path: a valid feed with the trips, calendars and stops of the pages", async () => {
    const site = await fakeSite();
    const warnings: string[] = [];
    const feed = await busbam.generate(ctxWith(site.fetchText, START, warnings));
    validateGtfs(feed, serviceWindow(START, DAYS));
    expect(feed.agency[0]).toMatchObject({ agency_name: "BusBam", agency_timezone: "Europe/Madrid" });
    expect(feed.routes.every((r) => r.route_url?.startsWith("https://www.busbam.com/horarios/"))).toBe(true);
    expect(feed.routes.find((r) => r.route_id.startsWith("almeria-madrid"))).toMatchObject({ route_short_name: "VAC-216", route_type: 200 });
    expect(feed.routes.find((r) => r.route_id.startsWith("almeria-jaen"))).toMatchObject({ route_short_name: "VJA-157 / VJA-158 / VJA-174", route_type: 3 });

    // Cartagena → Alicante Mon–Sat 07:00: 17 stops, no Sunday, no 8 December
    const r = feed.routes.find((x) => x.route_long_name === "Cartagena – Alicante")!;
    const morning = tripFrom(feed, r.route_id, "Cartagena", 7 * 60);
    expect(stopsOf(feed, morning)).toHaveLength(17);
    expect(timesOf(feed, morning).slice(-1)).toEqual([10 * 60 + 5]);
    const d = datesOf(feed, morning);
    expect(d).toContain("2026-10-26");
    expect(d).not.toContain("2026-11-01"); // Sunday
    expect(d).not.toContain("2026-12-08"); // holiday
    // the other 13:30 column only lists Cartagena, La Palma, Torre-Pacheco
    expect(feed.trips.map((t) => stopsOf(feed, t.trip_id)).some((s) => s.join() === "Cartagena,La Palma,Torre-Pacheco")).toBe(true);

    // "NUEVO · DIRECTO": every day, but only from 2 November
    const direct = tripFrom(feed, feed.routes.find((x) => x.route_long_name === "Madrid – Almería")!.route_id, "Madrid Estación Sur", 8 * 60);
    expect(stopsOf(feed, direct)).toEqual(["Madrid Estación Sur", "Almería"]);
    expect(datesOf(feed, direct)[0]).toBe("2026-11-02");

    // past midnight: Madrid 23:59 → Guadix 5:15 → Almería 6:30 → El Ejido 7:15 the next day
    const night = feed.trips.find((t) => stopsOf(feed, t.trip_id).join() === "Madrid Estación Sur,Guadix,Almería,El Ejido" && timesOf(feed, t.trip_id)[0] === 23 * 60 + 59)!;
    expect(timesOf(feed, night.trip_id)).toEqual([23 * 60 + 59, 1440 + 5 * 60 + 15, 1440 + 6 * 60 + 30, 1440 + 7 * 60 + 15]);

    // "(Solo Viernes)": Escúllar is called on Fridays only; two variants of the 19:30 trip
    const finana = feed.routes.find((x) => x.route_long_name === "Almería – Escúllar" || x.route_id === "almeria-jaen-11")!;
    const variants = feed.trips.filter((t) => t.route_id === finana.route_id);
    expect(variants.map((t) => stopsOf(feed, t.trip_id).slice(-1)[0]).sort()).toEqual(["Escúllar", "Fiñana"]);
    expect(datesOf(feed, variants.find((t) => stopsOf(feed, t.trip_id).slice(-1)[0] === "Escúllar")!.trip_id).every((x) => new Date(x).getUTCDay() === 5)).toBe(true);

    // side by side: Mojácar → Granada runs up the table
    const up = feed.trips.find((t) => stopsOf(feed, t.trip_id).join().startsWith("Mojácar,Vera,Huércal-Overa"))!;
    expect(stopsOf(feed, up.trip_id).slice(-1)).toEqual(["Granada"]);
    expect(timesOf(feed, up.trip_id)[0]).toBe(15 * 60 + 30);

    // warnings: the Roquetas call, the request stop, the Granada notes and the Úbeda typo
    const w = warnings.join("\n");
    expect(w).toMatch(/Roquetas de Mar \*16:15 of "DIARIO 4" runs only on Easter Sunday/);
    expect(w).toMatch(/Huéscar is a request stop/);
    expect(w).toMatch(/note \*\*: the 17:00 weekday trip starts in Granada/);
    expect(w).toMatch(/times go backwards at Iznalloz/);
    expect(feed.trips.find((t) => stopsOf(feed, t.trip_id).join().startsWith("Granada,Iznalloz,Píñar"))).toBeUndefined();
    const d4 = feed.trips.find((t) => stopsOf(feed, t.trip_id).join() === "Almería,Guadix,Madrid Estación Sur")!;
    expect(timesOf(feed, d4.trip_id)[0]).toBe(17 * 60);
  });

  it("a page that no longer fits fails the source", async () => {
    const run = async (edit: (slug: string, html: string) => string) => busbam.generate(ctxWith((await fakeSite(edit)).fetchText));
    const onPage = (slug: string, f: (h: string) => string) => (s: string, h: string) => (s === slug ? f(h) : h);
    await expect(run(onPage("index", (h) => h.replace(/<a [^>]*>[^<]*<\/a>/g, "")))).rejects.toThrow(/links no line pages any more/);
    await expect(run(onPage("murcia-torrevieja", (h) => h.replace(/>DIARIO</g, ">TODOS LOS DÍAS<")))).rejects.toThrow(/unknown calendar label "TODOS LOS DÍAS"/);
    await expect(run(onPage("murcia-torrevieja", (h) => h.replace(">9:30<", ">9.30<")))).rejects.toThrow(/unreadable time "9.30"/);
    await expect(run(onPage("murcia-torrevieja", (h) => h.replace(">ITINERARIO<", ">RUTA<")))).rejects.toThrow(/unknown table layout/);
    await expect(run(onPage("almeria-madrid", (h) => h.replace(/<table\b[\s\S]*?<\/table>/g, "<table></table>")))).rejects.toThrow(/no timetable tables|expected/);
    await expect(run(onPage("almeria-madrid", (h) => h.replace(/Válido del [^.<]*\./g, "")))).rejects.toThrow(/without its "Válido del … al …" note/);
    await expect(run(onPage("almeria-madrid", (h) => h.replace(/\*Excepción:[^<]*/, "")))).rejects.toThrow(/unexplained "\*" at ROQUETAS DE MAR/);
    await expect(run(onPage("almeria-jaen", (h) => h.replace(">**<", ">***<")))).rejects.toThrow(/unknown marker "\*\*\*"/);
    await expect(run(onPage("almeria-cartagena-alicante", (h) => h.replace(/LÍNEA VAC - 228\/250/, "")))).rejects.toThrow(/no "LÍNEA/);
  });

  it("many trips with backwards times mean the tables were misread", async () => {
    // mirror every time (t → 23:59 − t) so that all trips run backwards
    const mirror = (h: string) =>
      h.replace(/>(\d{1,2}):(\d\d)</g, (_, a: string, b: string) => {
        const m = 1439 - (Number(a) * 60 + Number(b));
        return `>${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}<`;
      });
    const site = await fakeSite((slug, h) => (slug === "index" ? h : mirror(h)));
    await expect(busbam.generate(ctxWith(site.fetchText))).rejects.toThrow(/trips have times that go backwards/);
  });

  it("a new stop is an error that asks for geocoding, naming all new stops at once", async () => {
    const site = await fakeSite((slug, h) => (slug === "murcia-torrevieja" ? h.replace("SANTOMERA", "SANTOMERÍA").replace(">BIGASTRO<", ">NUEVA VILLA<") : h));
    const err = await busbam.generate(ctxWith(site.fetchText)).catch((e) => e);
    expect(err).toBeInstanceOf(NeedsGeocodingError);
    expect(err.missing.map((m: { name: string }) => m.name).sort()).toEqual(["NUEVA VILLA", "SANTOMERÍA"].sort());
    expect(err.message).toMatch(/2 stop\(s\) need geocoding.*"SANTOMERÍA" \(table .*"NUEVA VILLA".*run geocode -- es-busbam|run `pnpm --filter @etbm\/etl run geocode -- es-busbam`/s);
  });

  it("a stop looked up automatically but not reviewed yet fails the same way; removed stops do not matter", async () => {
    const site = await fakeSite();
    const pages = await Promise.all(SLUGS.map(async (slug) => ({ slug, page: parsePage(await read(slug), pageUrl(slug)) })));
    const unreviewed = await realStore((f) => {
      f.entries[geoKey("Baza")]!.checked = null;
      f.entries[geoKey("Baza")]!.source = "osm-auto";
    });
    expect(() => buildFeed(pages, START, DAYS, () => {}, unreviewed)).toThrow(/looked up but not reviewed yet.*"BAZA"/s);
    // an entry for a stop that is not in the timetable (any more) is unused, not an error
    const extra = await realStore((f) => {
      f.entries.GONEVILLAGE = { name: "Gone Village", lat: 37.5, lon: -2.5, source: "osm", checked: "2026-10-26" };
    });
    expect(buildFeed(pages, START, DAYS, () => {}, extra).trips.length).toBeGreaterThan(80);
    void site;
  });

  it("a new line page linked from the index is parsed like the others", async () => {
    const warnings: string[] = [];
    const copy = (await read("murcia-torrevieja")).replace("LÍNEA VAC 250", "LÍNEA VAC 999");
    const site = await fakeSite(undefined, { "nueva-linea": copy });
    const feed = await busbam.generate(ctxWith(site.fetchText, START, warnings));
    expect(feed.routes.filter((r) => r.route_url === pageUrl("nueva-linea")).map((r) => r.route_short_name)).toEqual(["VAC-999", "VAC-999"]);
    // …and if it has a stop nobody geocoded, the source fails asking for it
    const odd = await fakeSite(undefined, { "otra-linea": copy.replace("LA APARECIDA", "VILLA NUEVA") });
    await expect(busbam.generate(ctxWith(odd.fetchText))).rejects.toThrow(/1 stop\(s\) need geocoding.*"VILLA NUEVA"/s);
  });

  it("keeps the hash of every page's timetable between builds and notices changes and removed pages", async () => {
    const state = new GeneratorState();
    const warnings: string[] = [];
    const site = await fakeSite();
    await busbam.generate(ctxWith(site.fetchText, START, warnings, state));
    expect(state.knownPages("es-busbam").sort()).toEqual([...SLUGS].sort());
    const again = generatorContext({ id: "es-busbam", userAgent: "t", startDate: START, days: DAYS, warnings, fetchText: site.fetchText, log: () => {}, warn: () => {}, state, observed: [] });
    expect(again.observe("almeria-madrid", contentOf(parsePage(await read("almeria-madrid"), "x"))).changed).toBe(false);
    // a changed time: same page, new hash
    const changed = await fakeSite((slug, h) => (slug === "murcia-torrevieja" ? h.replace(">9:30<", ">9:35<") : h));
    const seen: string[] = [];
    const ctx = generatorContext({ id: "es-busbam", userAgent: "t", startDate: START, days: DAYS, warnings, fetchText: changed.fetchText, log: (m) => seen.push(m), warn: () => {}, state, observed: [] });
    await busbam.generate(ctx);
    expect(seen.join("\n")).toMatch(/murcia-torrevieja: .*timetable changed/);
    // a page that disappears from the index: its lines are gone, with a warning, the rest is built
    warnings.length = 0;
    const fewer = await fakeSite((slug, h) => (slug === "index" ? h.replace(/<a [^>]*murcia-torrevieja[^>]*>[^<]*<\/a>/, "") : h));
    const feed = await busbam.generate(ctxWith(fewer.fetchText, START, warnings, state));
    expect(warnings.join()).toMatch(/page \/horarios\/murcia-torrevieja\/ is not linked any more/);
    expect(feed.routes.some((r) => r.route_id.startsWith("murcia-torrevieja"))).toBe(false);
  });

  it("is registered: the generator loads and feeds.json uses it", async () => {
    const gens = await loadGeneratorFiles(GENERATORS_DIR);
    expect([...gens.generators.keys()]).toContain("es-busbam");
    const cfg = await loadFeedsConfig(join(here, "../feeds.json"));
    const f = cfg.feeds.find((x) => x.id === "es-busbam")!;
    expect(f.sources).toEqual([{ generated: "es-busbam" }]);
    expect(f.timetableUrl).toBe("https://www.busbam.com/horarios/");
    expect(new GeneratorError("x").name).toBe("GeneratorError");
  });
});
