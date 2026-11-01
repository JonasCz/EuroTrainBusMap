import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateGtfs } from "../src/generators/gtfs.ts";
import { generatorContext, loadGeneratorFiles, serviceWindow } from "../src/generators/registry.ts";
import { GeocodeStore, NeedsGeocodingError, geoKey, type GeocodeFile, type MissingStop } from "../src/generators/geocodes.ts";
import { GeneratorState } from "../src/generators/state.ts";
import { GeneratorError, type GeneratorContext } from "../src/generators/types.ts";
import { GENERATORS_DIR, loadFeedsConfig } from "../src/feeds.ts";
import nejme, {
  FORM_URL,
  MAX_CLIQUES,
  MIN_BUSES,
  MIN_CITIES,
  buildFeed,
  busLabel,
  contentOf,
  generateFrom,
  hm,
  pairUrl,
  parseCities,
  parseResults,
  rebuildBuses,
  scanPairs,
  type Bus,
  type City,
  type Scan,
} from "../generators/ma-nejmechamal.ts";

const here = import.meta.dirname;
const FIX = join(here, "fixtures", "nejmechamal");
const START = "2026-11-02";
const DAYS = 60;
const STORE_FILE = join(here, "..", "data", "geocodes", "ma-nejmechamal.json");

const read = (name: string) => readFile(join(FIX, name), "utf8");
const HORAIRE = await read("horaire.html");
const REAL_RESULT = await read("tanger-casablanca.html");
const NO_RESULT = await read("no-result.html");
const CITIES = parseCities(HORAIRE);
const city = (name: string) => CITIES.find((c) => c.name === name) ?? ({ id: "x", name } as City);
type Cards = Record<string, Record<string, [number, number][]>>;
const REAL_SCAN = (JSON.parse(await read("scan.json")) as { pairs: Cards }).pairs;

// ------------------------------------------------------------------------------------------------ a fake site

/** One card, in the markup of the live pages (taken from the real result page). */
const CARD = '<div class="card">' + REAL_RESULT.split('<div class="card">')[1]!;
const cardHtml = (dep: string, arr: string, from: string, to: string) =>
  CARD.replace(/(<h2>\s*)\d\d:\d\d(\s*<\/h2>)/, `$1${dep}$2`)
    .replace(/(<h2>\s*)\d\d:\d\d(\s*<\/h2>)(?![\s\S]*<h2>)/, `$1${arr}$2`)
    .replace("Tanger", "@FROM@")
    .replace("Casablanca", "@TO@")
    .replace("@FROM@", from)
    .replace("@TO@", to);
const clock = (t: number) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;

/** The page the site answers for a city pair: the search form echoing the choice, and the cards (or the no-result heading). */
function pageFor(from: City, to: City, cards: [number, number][], base = HORAIRE): string {
  const mark = (html: string, field: string, c: City, placeholder: string) =>
    html.replace(new RegExp(`<select id="${field}"[\\s\\S]*?</select>`), (s) => s.replace(` selected="selected">${placeholder}`, `>${placeholder}`).replace(`<option value="${c.id}">`, `<option value="${c.id}" selected="selected">`));
  let html = mark(mark(base, "villeDepart", from, "Ville de départ"), "villeArrive", to, "Votre destination");
  if (cards.length) {
    const noResult = /<h2>\s*Aucun résultat pour cette recherche\s*<\/h2>/;
    html = html.replace(noResult, cards.map(([d, a]) => cardHtml(clock(d), clock(a), from.name, to.name)).join("\n"));
  }
  return html;
}

interface Site {
  fetchText: GeneratorContext["fetchText"];
  urls: string[];
}
/** The whole site: `cards` = origin id → destination id → [dep, arr]; `edit` may change any page. */
function fakeSite(cards: Cards = REAL_SCAN, edit: (url: string, html: string) => string = (_, h) => h, form = HORAIRE): Site {
  const urls: string[] = [];
  const byId = new Map(parseCities(form).map((c) => [c.id, c]));
  const fetchText: GeneratorContext["fetchText"] = async (url) => {
    urls.push(url);
    if (url === FORM_URL) return edit(url, form);
    const q = new URL(url).searchParams;
    const a = byId.get(q.get("villeDepart")!), b = byId.get(q.get("villeArrive")!);
    if (!a || !b) throw new Error(`HTTP 500 for ${url}`);
    return edit(url, pageFor(a, b, cards[a.id]?.[b.id] ?? [], form));
  };
  return { fetchText, urls };
}
function ctxWith(fetchText: GeneratorContext["fetchText"], o: { warnings?: string[]; logs?: string[]; state?: GeneratorState; needs?: { stops: MissingStop[]; dropped: string[] } } = {}): GeneratorContext {
  const warnings = o.warnings ?? [];
  return generatorContext({ id: "ma-nejmechamal", userAgent: "t", startDate: START, days: DAYS, warnings, fetchText, log: (m) => o.logs?.push(m), warn: (m) => warnings.push(m), ...(o.state ? { state: o.state } : {}), ...(o.needs ? { needs: o.needs } : {}) });
}
const run = (site: Site, o: Parameters<typeof ctxWith>[1] = {}) => generateFrom(ctxWith(site.fetchText, o), { delayMs: 0 });

const realStore = async (edit: (f: GeocodeFile) => void = () => {}) => {
  const file = JSON.parse(await readFile(STORE_FILE, "utf8")) as GeocodeFile;
  edit(file);
  return new GeocodeStore("ma-nejmechamal", file);
};
const scanOf = (cards: Cards): Scan => new Map(Object.entries(cards).map(([o, m]) => [o, new Map(Object.entries(m).map(([d, l]) => [d, l.map(([dep, arr]) => ({ dep, arr }))]))]));

// ------------------------------------------------------------------------------------------------ cards of imagined buses

const C = (n: string): City => city(n);
/**
 * Cards of buses written as "Tanger 01:00 > Souk El Arbaa 04:00 > …" (a time past midnight simply follows): the site
 * prints a card for every later stop of a stop. A stop written with a trailing "*" is one the site only lets people get
 * off at (its rank is last): it has no cards of its own, the stops after it have cards TO it.
 */
function cardsOf(...buses: string[]): Scan {
  const scan: Scan = new Map();
  const add = (a: City, dep: number, b: City, arr: number) => {
    const m = scan.get(a.id) ?? scan.set(a.id, new Map()).get(a.id)!;
    const l = m.get(b.id) ?? m.set(b.id, []).get(b.id)!;
    l.push({ dep, arr });
  };
  for (const bus of buses) {
    const stops = bus.split(">").map((s) => {
      const m = /^\s*(.+?)\s+(\d\d):(\d\d)(\*?)\s*$/.exec(s)!;
      return { c: C(m[1]!), t: (Number(m[2]) * 60 + Number(m[3])) % 1440, last: m[4] === "*" };
    });
    stops.forEach((a, i) =>
      stops.forEach((b, j) => {
        if (i === j) return;
        if (i < j && !a.last) add(a.c, a.t, b.c, b.t);
        if (i > j && b.last) add(a.c, a.t, b.c, b.t); // the "backward" card to a stop that can only be got off at
      }),
    );
  }
  return scan;
}
const text = (b: Bus) => b.calls.map((c) => `${c.city.name} ${hm(c.t)}`).join(" > ");

describe("ma-nejmechamal (Nejme Chamal timetable search)", () => {
  // ---------------------------------------------------------------------------------------------- the pages

  it("reads the cities of the search form", () => {
    expect(CITIES).toHaveLength(59);
    expect(CITIES[0]).toEqual({ id: "68", name: "Ahfir" });
    expect(CITIES.find((c) => c.name === "Fes")).toEqual({ id: "11", name: "Fes" });
    expect(CITIES.find((c) => c.name === "Al hoceima")).toEqual({ id: "41", name: "Al hoceima" });
    expect(new Set(CITIES.map((c) => c.id)).size).toBe(59);
    expect(pairUrl(city("Tanger"), city("Casablanca"), "2026-11-03")).toBe("https://www.nejmechamal.ma/horaire?villeDepart=14&villeArrive=10&dateDepart=03%2F11%2F2026");
  });

  it("reads the cards of a real result page and the explicit 'no result' page", () => {
    const trips = parseResults(REAL_RESULT, city("Tanger"), city("Casablanca"));
    expect(trips).toHaveLength(10);
    expect(trips[0]).toEqual({ dep: 30, arr: 330 }); // 00:30 → 05:30
    expect(trips[1]).toEqual({ dep: 120, arr: 390 }); // 02:00 → 06:30
    expect(trips[9]).toEqual({ dep: 22 * 60 + 30, arr: 3 * 60 + 30 }); // 22:30 → 03:30 (next day)
    expect(parseResults(NO_RESULT, city("Fnideq"), city("Ahfir"))).toEqual([]);
    // the helper builds the same page as the site
    expect(parseResults(pageFor(city("Tanger"), city("Casablanca"), trips.map((t) => [t.dep, t.arr])), city("Tanger"), city("Casablanca"))).toEqual(trips);
  });

  it("a result page that does not look as expected fails the source", () => {
    const T = city("Tanger"), K = city("Casablanca");
    const bad = (html: string, re: RegExp, a = T, b = K) => expect(() => parseResults(html, a, b)).toThrow(re);
    bad(REAL_RESULT.replace(">\n                        00:30\n", ">\n                        0.30\n"), /unreadable time "0.30"/);
    bad(REAL_RESULT.replace("05:30", "25:30"), /unreadable time "00:30" \/ "25:30"/);
    bad(REAL_RESULT.replace("<h6>\n                        Casablanca", "<h6>\n                        Rabat"), /the card runs Tanger → Rabat, asked Tanger → Casablanca/);
    bad(REAL_RESULT.replace("</h6>\n                    </td>\n                    <td></td>", "</h6><span>120 DH</span>\n                    </td>\n                    <td></td>"), /unexpected <span>/);
    bad(REAL_RESULT.replace("<h6>", "<p>120 DH</p><h6>"), /unexpected <p>/);
    bad(REAL_RESULT.replace("<h6>", "<h6>VIP "), /the card runs VIP Tanger/);
    bad(REAL_RESULT.replace(/<h2>\s*00:30\s*<\/h2>/, ""), /expected <h2>dep<\/h2>/);
    bad(REAL_RESULT.replace(/<div class="container mt-2 mb-2">/, '<div class="container">'), /no results container/);
    bad(NO_RESULT.replace("Aucun résultat pour cette recherche", "Service indisponible"), /neither "Aucun résultat pour cette recherche" nor result cards/, city("Fnideq"), city("Ahfir"));
    // the page answers for another pair than the one asked
    bad(pageFor(city("Rabat"), K, [[60, 120]]), /answers for another villeDepart than asked \(\d+ "Rabat", asked 14 "Tanger"\)/);
    bad(pageFor(T, city("Rabat"), [[60, 120]]), /another villeArrive than asked/);
    bad(NO_RESULT, /another villeDepart than asked/, T, K);
    bad(REAL_RESULT.replace(/ selected="selected">Tanger/, ">Tanger"), /no selected option/);
  });

  it("a form that changed fails the source", () => {
    expect(() => parseCities(HORAIRE.replace('<form method="get">', '<form method="post">'))).toThrow(/search form changed/);
    expect(() => parseCities(HORAIRE.replace(/name="dateDepart"/, 'name="date"'))).toThrow(/search form changed/);
    expect(() => parseCities(HORAIRE.replace(/<select id="villeArrive" name="villeArrive"/, '<select id="arrivee" name="arrivee"'))).toThrow(/no <select name="villeArrive">/);
    expect(() => parseCities(HORAIRE.replace('<option value="" selected="selected">Ville de départ</option>', ""))).toThrow(/does not start with the placeholder/);
    expect(() => parseCities(HORAIRE.replace(/<option value="68">Ahfir<\/option>/, '<option value="68">Ahfir</option><optgroup label="x"></optgroup>'))).toThrow(/holds more than <option>s/);
    expect(() => parseCities(HORAIRE.replace('value="68">Ahfir', 'value="ahfir">Ahfir'))).toThrow(/not "<number>" \+ a name/);
    expect(() => parseCities(HORAIRE.replace(/<option value="41">Al hoceima<\/option>/, ""))).toThrow(/departure and arrival lists of the form differ/);
    expect(() => parseCities(HORAIRE.replace(/>Fes</g, ">Ahfir<"))).toThrow(/duplicate city ids or names/);
    // fewer than MIN_CITIES options (both selects cut the same way)
    const few = HORAIRE.replace(/<option value="(?!68|41|10|14|11)\d+">[^<]*<\/option>/g, "");
    expect(parseCities(HORAIRE)).toHaveLength(59);
    expect(() => parseCities(few)).toThrow(new RegExp(`only 5 cities in the form \\(expected at least ${MIN_CITIES}`));
  });

  // ---------------------------------------------------------------------------------------------- the buses

  it("scans every ordered pair of cities once", async () => {
    const site = fakeSite();
    const logs: string[] = [];
    const scan = await scanPairs(CITIES, START, (u) => site.fetchText(u), (m) => logs.push(m));
    expect(site.urls).toHaveLength(59 * 58);
    expect(new Set(site.urls).size).toBe(59 * 58);
    expect(logs[0]).toMatch(/^500 of 3422 city pairs read/);
    expect([...scan.keys()]).toHaveLength(56);
    expect(scan.get("14")!.get("10")).toHaveLength(10);
    const lines = contentOf(city("Tanger"), scan, CITIES).split("\n");
    expect(lines.slice(0, 3)).toEqual(["from Tanger", "Ahfir: 14:10>05:30 20:30>10:30", expect.stringMatching(/^Al hoceima: 05:30>14:45 10:30>19:30 /)]);
    expect(lines).toContain("Casablanca: 00:30>05:30 02:00>06:30 03:30>08:30 04:00>09:15 05:45>10:30 06:45>12:00 13:15>18:30 14:30>19:30 17:00>22:00 22:30>03:30");
  });

  it("rebuilds a bus from the cards of its stops: the cards of later stops are the same bus (suffix)", () => {
    const scan = cardsOf("Tanger 01:00 > Souk El Arbaa 04:00 > Sidi kacem 05:20 > Meknes 06:30 > Fes 07:45");
    // Tanger lists 4 destinations, Souk El Arbaa 3, Sidi kacem 2, Meknes 1: five "runs" in the cards, one bus
    expect([...scan.keys()]).toHaveLength(4);
    const { buses, stats } = rebuildBuses(scan, CITIES);
    expect(buses.map(text)).toEqual(["Tanger 01:00 > Souk El Arbaa 04:00 > Sidi kacem 05:20 > Meknes 06:30 > Fes 07:45"]);
    expect(stats).toMatchObject({ cards: 10, nodes: 5, buses: 1, withBackwardCards: 0, ambiguousStart: 0, ties: 0 });
    expect(busLabel(buses[0]!)).toBe("Tanger 01:00 → Fes 07:45");
  });

  it("a bus past midnight keeps counting; buses leaving a city at the same minute stay apart", () => {
    const scan = cardsOf(
      "Tanger 23:00 > Tetouan 00:00 > Targuist 06:30 > Al hoceima 08:30",
      "Casablanca 15:00 > Rabat 16:15 > Meknes 19:15 > Fes 20:30", // three buses leave Casablanca at 15:00
      "Casablanca 15:00 > Rabat 16:30 > Kenitra 17:30 > Larache 20:00",
      "Kelaa Sraghna 11:30 > Settat 13:45 > Casablanca 15:00 > Rabat 16:45 > Tanger 20:00", // …and one arrives there at 15:00
    );
    const { buses } = rebuildBuses(scan, CITIES);
    expect(buses.map(text)).toEqual([
      "Casablanca 15:00 > Rabat 16:15 > Meknes 19:15 > Fes 20:30",
      "Casablanca 15:00 > Rabat 16:30 > Kenitra 17:30 > Larache 20:00",
      "Kelaa Sraghna 11:30 > Settat 13:45 > Casablanca 15:00 > Rabat 16:45 > Tanger 20:00",
      "Tanger 23:00 > Tetouan 00:00 > Targuist 06:30 > Al hoceima 08:30",
    ]);
    const night = buses[3]!;
    expect(night.calls.map((c) => c.t)).toEqual([23 * 60, 24 * 60, 30 * 60 + 30, 32 * 60 + 30]); // 23:00, 00:00 +1 day, 06:30 +1 day, 08:30 +1 day
  });

  it("a stop the site only lets people get off at (cards TO it from later stops) is put where its time says", () => {
    const scan = cardsOf("Oujda 13:30 > Berkan 14:15 > Midar 18:00 > Imzouren 20:00* > Al hoceima 20:30 > Tanger 05:15");
    // Imzouren has cards from every stop, also from Al hoceima and Tanger (23 h 30 and 14 h 45 "later"), none of its own
    expect(scan.get(city("Tanger").id)!.get(city("Imzouren").id)).toEqual([{ dep: 5 * 60 + 15, arr: 20 * 60 }]);
    expect(scan.has(city("Imzouren").id)).toBe(false);
    const { buses, stats } = rebuildBuses(scan, CITIES);
    expect(buses.map(text)).toEqual(["Oujda 13:30 > Berkan 14:15 > Midar 18:00 > Imzouren 20:00 > Al hoceima 20:30 > Tanger 05:15"]);
    expect(stats).toMatchObject({ buses: 1, withBackwardCards: 1, backwardCards: 2 });
    expect(buses[0]!.calls.at(-1)!.t).toBe(24 * 60 + 5 * 60 + 15);
  });

  it("a pair of stops with cards both ways and nothing else is ambiguous and left out; the same card twice counts once", () => {
    const warnings: string[] = [];
    const scan = cardsOf("Arfoud 04:00 > Errissani 16:00");
    scan.set(city("Errissani").id, new Map([[city("Arfoud").id, [{ dep: 16 * 60, arr: 4 * 60 }]]])); // 12 h each way
    const r = rebuildBuses(scan, CITIES, (m) => warnings.push(m));
    expect(r.buses).toEqual([]);
    expect(r.stats.ties).toBe(1);
    expect(warnings[0]).toMatch(/do not say which stop comes first: left out/);
    // …but when one direction is shorter that one is the ride
    const scan2 = cardsOf("Arfoud 04:00 > Errissani 04:30");
    scan2.set(city("Errissani").id, new Map([[city("Arfoud").id, [{ dep: 4 * 60 + 30, arr: 4 * 60 }]]]));
    const r2 = rebuildBuses(scan2, CITIES);
    expect(r2.buses.map(text)).toEqual(["Arfoud 04:00 > Errissani 04:30"]);
    expect(r2.stats.ambiguousStart).toBe(1);
    const twice = cardsOf("Tanger 01:00 > Fes 07:45");
    twice.get(city("Tanger").id)!.get(city("Fes").id)!.push({ dep: 60, arr: 465 });
    expect(rebuildBuses(twice, CITIES).stats).toMatchObject({ cards: 2, duplicateCards: 1, buses: 1 });
  });

  it("two stops at the same minute on one bus are left out with a warning", () => {
    const warnings: string[] = [];
    const { buses, stats } = rebuildBuses(cardsOf("Tanger 01:00 > Larache 03:00 > Ksar El Kebir 03:00"), CITIES, (m) => warnings.push(m));
    expect(buses).toEqual([]);
    expect(stats.ties).toBe(1);
    expect(warnings[0]).toMatch(/two stops at the same minute on the bus from Tanger 01:00/);
  });

  it("the real network of 1 Nov 2026: 104 buses, none misordered", () => {
    const { buses, stats } = rebuildBuses(scanOf(REAL_SCAN), CITIES);
    expect(stats).toMatchObject({ cards: 1978, duplicateCards: 3, nodes: 528, buses: 104, withBackwardCards: 24, backwardCards: 116, ambiguousStart: 0, ties: 0 });
    const have = (s: string) => expect(buses.map(text)).toContain(s);
    have("Tanger 01:00 > Souk El Arbaa 04:00 > Sidi kacem 05:20 > Meknes 06:30 > Fes 07:45 > Sefrou 08:30 > Guigou 09:30 > Boulmane 10:00 > Missour 12:00");
    // Imzouren / Oued amlil / Arfoud / Azrou: only alighting, put in order by their time
    have("Oujda 13:30 > Ahfir 14:45 > Berkan 15:00 > Zaio 15:45 > Nador 16:30 > Driouch 17:45 > Midar 18:00 > Imzouren 20:00 > Al hoceima 20:30 > Targuist 22:30 > Issaguen 00:00 > Tetouan 04:00 > Tanger 05:15");
    have("Casablanca 15:00 > Rabat 16:15 > Meknes 19:15 > Fes 20:30 > Oued amlil 21:30 > Taza 22:15 > Guercif 23:15 > Taourirte 00:15 > Oujda 02:00");
    // three buses leave Casablanca at 15:00
    expect(buses.filter((b) => text(b).startsWith("Casablanca 15:00"))).toHaveLength(2);
    expect(buses.filter((b) => b.calls.some((c) => c.city.name === "Casablanca" && c.t === 15 * 60))).toHaveLength(3);
    // every bus is increasing in time, runs less than a day and calls at no city twice
    for (const b of buses) {
      expect(b.calls.length).toBeGreaterThanOrEqual(2);
      b.calls.forEach((c, i) => i && expect(c.t).toBeGreaterThan(b.calls[i - 1]!.t));
      expect(b.calls.at(-1)!.t - b.calls[0]!.t).toBeLessThan(1440);
      expect(new Set(b.calls.map((c) => c.city.id)).size).toBe(b.calls.length);
    }
  });

  it("the buses give back the cards of the site, except those of the alight-only stops", () => {
    const { buses } = rebuildBuses(scanOf(REAL_SCAN), CITIES);
    const site = new Set<string>(), fromBuses = new Set<string>();
    for (const [a, m] of Object.entries(REAL_SCAN)) for (const [b, l] of Object.entries(m)) for (const [dep, arr] of l) site.add(`${a}|${dep}|${b}|${arr}`);
    for (const bus of buses)
      bus.calls.forEach((x, i) => bus.calls.slice(i + 1).forEach((y) => fromBuses.add(`${x.city.id}|${x.t % 1440}|${y.city.id}|${y.t % 1440}`)));
    const onlySite = [...site].filter((c) => !fromBuses.has(c)), onlyBuses = [...fromBuses].filter((c) => !site.has(c));
    expect([site.size, fromBuses.size, onlySite.length, onlyBuses.length]).toEqual([1975, 1974, 115, 114]);
    // the cards only on the site go BACK to a stop (12 – 24 h "later"); the others start at such a stop
    for (const c of onlySite) {
      const [, dep, , arr] = c.split("|").map(Number);
      expect(((arr! - dep! + 1440) % 1440) / 60).toBeGreaterThan(12);
    }
    const alightOnly = new Set(onlySite.map((c) => CITIES.find((x) => x.id === c.split("|")[2])!.name));
    expect([...alightOnly].sort()).toEqual(["Arfoud", "Azrou", "Driouch", "Imzouren", "Midar", "Oued amlil", "Outat el Haj", "Targuist"]);
    expect(new Set(onlyBuses.map((c) => CITIES.find((x) => x.id === c.split("|")[0])!.name))).toEqual(alightOnly);
  });

  it("too many cliques mean the cards no longer describe a few dozen buses", () => {
    expect(MAX_CLIQUES).toBeGreaterThan(1000);
  });

  // ---------------------------------------------------------------------------------------------- the feed

  /** A store with a position for each name given as "Name lat lon". */
  const storeOf = (rows: string[], edit: (f: GeocodeFile) => void = () => {}) => {
    const file: GeocodeFile = { version: 1, country: "ma", entries: {} };
    for (const r of rows) {
      const m = /^(.+) (-?[\d.]+) (-?[\d.]+)$/.exec(r)!;
      file.entries[geoKey(m[1]!)] = { name: m[1]!, lat: Number(m[2]), lon: Number(m[3]), source: "manual", checked: "2026-11-01" };
    }
    edit(file);
    return new GeocodeStore("ma-nejmechamal", file);
  };
  const MINI = ["Tanger 35.77 -5.80", "Souk El Arbaa 34.68 -5.99", "Sidi kacem 34.22 -5.70", "Meknes 33.89 -5.54", "Fes 34.04 -5.0"];
  const MINI_BUS = "Tanger 01:00 > Souk El Arbaa 04:00 > Sidi kacem 05:20 > Meknes 06:30 > Fes 07:45";

  it("builds one trip per bus, a route per terminus pair, service on every day of the window", () => {
    const { buses } = rebuildBuses(cardsOf(MINI_BUS, "Fes 12:30 > Meknes 13:45 > Tanger 18:00"), CITIES);
    const warnings: string[] = [], dropped: string[] = [];
    const feed = buildFeed(buses, storeOf(MINI), START, DAYS, (m) => warnings.push(m), dropped);
    validateGtfs(feed, serviceWindow(START, DAYS));
    expect(warnings).toEqual([]);
    expect(dropped).toEqual([]);
    expect(feed.agency).toEqual([{ agency_id: "nejme-chamal", agency_name: "Nejme Chamal", agency_url: "https://www.nejmechamal.ma/", agency_timezone: "Africa/Casablanca", agency_lang: "fr" }]);
    expect(feed.routes.map((r) => [r.route_id, r.route_long_name, r.route_type]).sort()).toEqual([
      ["fes-tanger", "Fes – Tanger", 200],
      ["tanger-fes", "Tanger – Fes", 200],
    ]);
    expect(feed.trips.map((t) => [t.trip_id, t.trip_headsign]).sort()).toEqual([["fes-tanger-1230", "Tanger"], ["tanger-fes-0100", "Fes"]]);
    expect(feed.stops.map((s) => s.stop_id).sort()).toEqual(["fes", "meknes", "sidikacem", "soukelarbaa", "tanger"]);
    const times = feed.stopTimes.filter((s) => s.trip_id === "tanger-fes-0100").map((s) => [s.stop_id, s.arr, s.dep]);
    expect(times).toEqual([["tanger", 60, 60], ["soukelarbaa", 240, 240], ["sidikacem", 320, 320], ["meknes", 390, 390], ["fes", 465, 465]]);
    // every day of the build's window (the day before the start … start + days), nothing else
    const w = serviceWindow(START, DAYS);
    const days = feed.services.get("daily")!;
    expect(days[0]).toBe(w.from);
    expect(days.at(-1)).toBe(w.to);
    expect(days).toHaveLength(DAYS + 2);
  });

  it("a bus calling at a city without reviewed coordinates is left out and named; the rest is built; unused entries do no harm", () => {
    const { buses } = rebuildBuses(cardsOf(MINI_BUS, "Fes 12:30 > Meknes 13:45 > Tanger 18:00"), CITIES);
    // Souk El Arbaa not reviewed yet, Fes missing: both buses call at one of them
    const unreviewed = storeOf(MINI.slice(1).concat("Gone Village 35 -5"), (f) => {
      f.entries[geoKey("Souk El Arbaa")]!.checked = null;
    });
    const dropped: string[] = [];
    expect(() => buildFeed(buses, unreviewed, START, DAYS, () => {}, dropped)).not.toThrow();
    expect(dropped.sort()).toEqual(["Fes 12:30 → Tanger 18:00", "Tanger 01:00 → Fes 07:45"]);
    expect(unreviewed.missing.map((m) => [m.name, !!m.unchecked]).sort()).toEqual([["Souk El Arbaa", true], ["Tanger", false]]);
    // a place with no certain position (skip) is left out of the buses
    const skip = storeOf(MINI, (f) => {
      f.entries[geoKey("Sidi kacem")] = { name: "Sidi Kacem", lat: 0, lon: 0, source: "none", checked: "2026-11-01", skip: true };
    });
    const feed = buildFeed(buses, skip, START, DAYS, () => {});
    expect(feed.stopTimes.filter((s) => s.trip_id === "tanger-fes-0100").map((s) => s.stop_id)).toEqual(["tanger", "soukelarbaa", "meknes", "fes"]);
    // the stop names are the store's names (accents), the ids the source spelling
    const named = storeOf(MINI.map((r) => r.replace(/^Fes/, "Fès")));
    expect(buildFeed(buses, named, START, DAYS, () => {}).stops.find((s) => s.stop_id === "fes")!.stop_name).toBe("Fès");
  });

  it("a bus with an impossible leg is left out with a warning; many of them mean the source is misread", () => {
    const { buses } = rebuildBuses(cardsOf(MINI_BUS, "Fes 12:30 > Meknes 13:45 > Tanger 18:00", "Tanger 02:00 > Fes 08:00", "Tanger 03:00 > Fes 09:00", "Tanger 04:00 > Fes 10:00", "Tanger 05:00 > Fes 11:00", "Tanger 06:00 > Fes 12:00", "Tanger 07:00 > Fes 13:00", "Tanger 08:00 > Fes 14:00", "Tanger 09:00 > Fes 15:00", "Tanger 10:00 > Fes 16:00"), CITIES);
    expect(buses).toHaveLength(11);
    const warnings: string[] = [];
    // Meknes put 400 km away: the legs to / from it are 1000+ km/h
    const wrong = storeOf(MINI.map((r) => (r.startsWith("Meknes") ? "Meknes 30.0 -8.0" : r)));
    expect(() => buildFeed(buses, wrong, START, DAYS, (m) => warnings.push(m))).toThrow(/2 of 11 buses have impossible legs/);
    const few = buses.slice(0, 2).concat(buses.slice(2).filter((b) => !b.calls.some((c) => c.city.name === "Meknes")));
    const feed = buildFeed(few.slice(1), wrong, START, DAYS, (m) => warnings.push(m)); // 1 of 10 only
    expect(feed.trips).toHaveLength(9);
    expect(warnings.join()).toMatch(/bus Tanger 01:00 → Fes 07:45: impossible leg Souk El Arbaa 04:00 → Sidi kacem 05:20|bus Fes 12:30 → Tanger 18:00: impossible leg/);
  });

  // ---------------------------------------------------------------------------------------------- the geocode file

  it("the geocode file: every entry reviewed, in Morocco, covering all cities with a bus; source spellings resolve", async () => {
    const store = await realStore();
    expect(store.file.country).toBe("ma");
    for (const [k, e] of Object.entries(store.file.entries)) {
      expect(e.checked, k).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.lat, k).toBeGreaterThan(30);
      expect(e.lat, k).toBeLessThan(36);
      expect(e.lon, k).toBeGreaterThan(-9);
      expect(e.lon, k).toBeLessThan(-1);
    }
    const served = new Set(Object.entries(REAL_SCAN).flatMap(([o, m]) => [o, ...Object.keys(m)]));
    for (const c of CITIES) if (served.has(c.id)) expect(store.lookup(c.name), c.name).toBeDefined();
    expect(CITIES.filter((c) => !served.has(c.id)).map((c) => c.name)).toEqual(["Enjil", "Khemisset", "Sale"]);
  });

  it("the real network with the real coordinates: 104 trips, no impossible leg, nothing left out", async () => {
    const { buses } = rebuildBuses(scanOf(REAL_SCAN), CITIES);
    const warnings: string[] = [], dropped: string[] = [];
    const store = await realStore();
    const feed = buildFeed(buses, store, START, DAYS, (m) => warnings.push(m), dropped);
    validateGtfs(feed, serviceWindow(START, DAYS));
    expect(warnings).toEqual([]);
    expect(dropped).toEqual([]);
    expect(store.missing).toEqual([]);
    expect(feed.trips).toHaveLength(104);
    expect(feed.stops).toHaveLength(56);
    expect(feed.routes).toHaveLength(51); // one per ordered terminus pair
    // the trip Tanger 01:00 → Missour 12:00 with 9 stops, 11 h
    const t = feed.trips.find((x) => x.trip_id === "tanger-missour-0100")!;
    const st = feed.stopTimes.filter((s) => s.trip_id === t.trip_id);
    expect(st).toHaveLength(9);
    expect(st.at(-1)!.arr - st[0]!.dep).toBe(11 * 60);
  });

  // ---------------------------------------------------------------------------------------------- the generator

  it("happy path: asks every pair once (plus the date check), builds the feed of the real network", async () => {
    const site = fakeSite();
    const logs: string[] = [], warnings: string[] = [];
    const feed = await run(site, { logs, warnings });
    validateGtfs(feed, serviceWindow(START, DAYS));
    expect(warnings).toEqual([]);
    expect(site.urls.filter((u) => u === FORM_URL)).toHaveLength(1);
    expect(site.urls.filter((u) => u.includes("villeDepart"))).toHaveLength(59 * 58 + 3);
    expect(feed.trips).toHaveLength(104);
    expect(logs.join("\n")).toMatch(/3426 requests in \d+ s/);
    expect(logs.join("\n")).toMatch(/1978 cards \(3 twice\) → 528 calls → 104 buses; 24 buses have a stop that can only be alighted at \(116 backward cards\)/);
    expect(feed.info).toMatchObject({ lang: "fr", sourceUrl: FORM_URL });
    expect(nejme.sourceUrl).toBe(FORM_URL);
  }, 60_000);

  it("fails when the site depends on the date after all", async () => {
    // the pair with most buses is asked again for other dates
    let best = { a: CITIES[0]!, b: CITIES[1]!, n: 0 };
    for (const a of CITIES) for (const b of CITIES) if ((REAL_SCAN[a.id]?.[b.id]?.length ?? 0) > best.n) best = { a, b, n: REAL_SCAN[a.id]![b.id]!.length };
    expect(best.n).toBeGreaterThan(5);
    const site = fakeSite(REAL_SCAN, (url, html) => {
      // the Saturday after START (2026-11-07) shows one bus less
      if (url.includes(`villeDepart=${best.a.id}&villeArrive=${best.b.id}`) && url.includes("dateDepart=07%2F11%2F2026")) return pageFor(best.a, best.b, REAL_SCAN[best.a.id]![best.b.id]!.slice(1));
      return html;
    });
    await expect(run(site)).rejects.toThrow(new RegExp(`${best.a.name} → ${best.b.name} answers differently for 2026-11-07 than for 2026-11-02: the timetable depends on the date now`));
    expect(site.urls.filter((u) => u.includes(`villeDepart=${best.a.id}&villeArrive=${best.b.id}`))).toHaveLength(2); // the scan, then the first other date
    // the same date for every day (the site as it is today) passes the check: see the happy path
  }, 60_000);

  it("fails on an empty site and on a site with too few buses", async () => {
    await expect(run(fakeSite({}))).rejects.toThrow(/no bus at all in the scan/);
    const few: Cards = { "14": { "10": REAL_SCAN["14"]!["10"]!, "11": REAL_SCAN["14"]!["11"]! } };
    await expect(run(fakeSite(few))).rejects.toThrow(new RegExp(`only \\d+ buses rebuilt from \\d+ cards \\(expected at least ${MIN_BUSES}\\)`));
  }, 60_000);

  it("a failing request or a changed page fails the source", async () => {
    const site = fakeSite(REAL_SCAN, (url, html) => {
      if (url.includes("villeDepart=11&villeArrive=13")) throw new Error("HTTP 500 for " + url);
      return html;
    });
    await expect(run(site)).rejects.toThrow(/HTTP 500/);
    // Fes → Ahfir has no bus: its explicit "no result" heading is replaced
    const odd = fakeSite(REAL_SCAN, (url, html) => (url.includes("villeDepart=11&villeArrive=68") ? html.replace("Aucun résultat pour cette recherche", "Erreur") : html));
    await expect(run(odd)).rejects.toThrow(/Fes → Ahfir: neither "Aucun résultat pour cette recherche" nor result cards/);
    const noForm = fakeSite(REAL_SCAN, (url, html) => (url === FORM_URL ? html.replace(/<option value="\d+">[^<]*<\/option>/g, "") : html));
    await expect(run(noForm)).rejects.toThrow(/only 0 cities|differ|cities in the form/);
  }, 60_000);

  it("a new city in the form is scanned like the others; its stop needs geocoding and only its buses are left out", async () => {
    const nova = { id: "71", name: "Nouvelleville" };
    const form = HORAIRE.replace(/(<select id="villeDepart"[\s\S]*?)(<\/select>)/, `$1<option value="71">Nouvelleville</option>$2`).replace(/(<select id="villeArrive"[\s\S]*?)(<\/select>)/, `$1<option value="71">Nouvelleville</option>$2`);
    expect(parseCities(form)).toHaveLength(60);
    const cards: Cards = { ...REAL_SCAN, "14": { ...REAL_SCAN["14"]!, "71": [[10 * 60, 12 * 60]] }, "71": { "14": [[13 * 60, 15 * 60]] } };
    const site = fakeSite(cards, (_, h) => h, form);
    const needs = { stops: [] as MissingStop[], dropped: [] as string[] };
    const warnings: string[] = [];
    const feed = await run(site, { needs, warnings });
    expect(site.urls.filter((u) => u.includes("villeDepart"))).toHaveLength(60 * 59 + 3);
    expect(needs.stops.map((m) => m.name)).toEqual([nova.name]);
    expect(needs.dropped.sort()).toEqual(["Nouvelleville 13:00 → Tanger 15:00", "Tanger 10:00 → Nouvelleville 12:00"]);
    expect(feed.trips).toHaveLength(104); // the real buses are all there
    expect(warnings.join("\n")).toMatch(/1 stop\(s\) need geocoding/);
  }, 60_000);

  it("nothing but unknown stops: the source fails with the instructions to geocode", async () => {
    const only: Cards = Object.fromEntries(Object.entries(REAL_SCAN).slice(0, 56));
    const empty = new GeocodeStore("ma-nejmechamal", { version: 1, country: "ma", entries: {} });
    const { buses } = rebuildBuses(scanOf(only), CITIES);
    const needs = { stops: [] as MissingStop[], dropped: [] as string[] };
    const dropped: string[] = [];
    const feed = buildFeed(buses, empty, START, DAYS, () => {}, dropped);
    expect(feed.trips).toEqual([]);
    expect(dropped).toHaveLength(104);
    let err: unknown;
    try {
      empty.finish({ needsGeocoding: (s, d) => Object.assign(needs, { stops: s, dropped: d }) }, dropped, feed.trips.length);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NeedsGeocodingError);
    expect((err as NeedsGeocodingError).message).toMatch(/56 stop\(s\) need geocoding.*"Tanger" \(bus .*run `pnpm --filter @etbm\/etl run geocode -- ma-nejmechamal`/s);
    expect(needs.stops).toHaveLength(56);
  });

  it("keeps the hash of every origin city's cards between builds and notices changes and cities that lost their buses", async () => {
    const state = new GeneratorState();
    const warnings: string[] = [];
    await run(fakeSite(), { state, warnings });
    expect(state.knownPages("ma-nejmechamal")).toHaveLength(56);
    expect(state.knownPages("ma-nejmechamal")).toContain("from-tanger");
    // same site again: nothing changed
    const same: string[] = [];
    await run(fakeSite(), { state, logs: same });
    expect(same.join("\n")).not.toMatch(/timetable changed/);
    // Tanger → Casablanca 00:30 leaves at 00:35 now
    const moved = JSON.parse(JSON.stringify(REAL_SCAN)) as Cards;
    moved["14"]!["10"]![0] = [35, 330];
    const seen: string[] = [];
    await run(fakeSite(moved), { state, logs: seen, warnings });
    expect(seen.join("\n")).toMatch(/Tanger: timetable changed \(previous version since /);
    expect(seen.join("\n")).not.toMatch(/Rabat: timetable changed/);
    // Missour no longer has any bus leaving it
    const gone = JSON.parse(JSON.stringify(REAL_SCAN)) as Cards;
    delete gone[city("Missour").id];
    warnings.length = 0;
    await run(fakeSite(gone), { state, warnings });
    expect(warnings.join("\n")).toMatch(/from-missour: no bus leaves that city any more/);
  }, 120_000);

  it("is registered: the generator loads and feeds.json uses it", async () => {
    const gens = await loadGeneratorFiles(GENERATORS_DIR);
    expect([...gens.generators.keys()]).toContain("ma-nejmechamal");
    const cfg = await loadFeedsConfig(join(here, "../feeds.json"));
    const f = cfg.feeds.find((x) => x.id === "ma-nejmechamal")!;
    expect(f.sources).toEqual([{ generated: "ma-nejmechamal" }]);
    expect(f.timetableUrl).toBe("https://www.nejmechamal.ma/horaire");
    expect(f.country).toBe("MA");
    expect(f.options).toMatchObject({ allCoach: true, priority: -1 });
    // at the end, behind it only other generated feeds: processing is in feeds.json order, a slow generator
    // must not hold up the downloaded feeds
    const behind = cfg.feeds.slice(cfg.feeds.findIndex((x) => x.id === "ma-nejmechamal") + 1);
    expect(behind.filter((x) => !x.sources.some((s) => "generated" in s)).map((x) => x.id)).toEqual([]);
    expect(new GeneratorError("x").name).toBe("GeneratorError");
  });
});
