import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineGenerator, GeneratorError, type GeneratorContext } from "../src/generators/types.ts";
import { addDays, dateRange, haversineKm, isoWeekday, parseHm, type GtfsFeed, type GtfsRoute, type GtfsStop, type GtfsStopTime, type GtfsTrip } from "../src/generators/gtfs.ts";
import { serviceWindow } from "../src/generators/registry.ts";
import { GeocodeStore, geoKey, type GeocodeEntry } from "../src/generators/geocodes.ts";
import { mapLimit } from "../src/generators/pool.ts";

/**
 * Nejme Chamal (Tanger), the private coach company of northern and eastern Morocco: buses between Tanger, Tétouan,
 * Chefchaouen, Al Hoceima, Nador, Oujda, Fès, Meknès, Rabat, Casablanca, Marrakech, Errachidia, Ouarzazate and the
 * towns on the way. The company publishes no GTFS and no list of lines, only a search form; the buses are rebuilt from
 * what the form answers for every pair of cities.
 *
 * SOURCE
 *   https://www.nejmechamal.ma/horaire – the search form ("Lignes & Horaires") of the operator's own site, public GET,
 *   server-rendered. Checked 2026-11-01 whether the routes are already in our data: no GTFS exists – Transitous has only
 *   `ma_oncf` for Morocco (ONCF trains + 34 Supratours coach routes), the Mobility Database has none, Nejme Chamal is not
 *   sold on the Markoub portal. Terms: `/robots.txt`, `/mentions-legales`, `/cgu`, `/conditions`, `/cgv`, `/terms` and
 *   `/politique-de-confidentialite` answer 404; the only legal text is the footer "© 2020 Nejme Chamal. All rights
 *   reserved | Design by Digital Bang", which says nothing about reuse or automated reading. The script asks for
 *   3,422 pages once per build, two at a time with a pause (≈ 17 min), a few thousand requests a week.
 *
 * SHAPE OF THE SOURCE (live, checked 2026-11-01)
 *   GET /horaire?villeDepart=<id>&villeArrive=<id>&dateDepart=dd/mm/yyyy. The form (the same page answers without the
 *   query) lists the cities twice, as the departure and as the arrival select:
 *     <form method="get"> … <select id="villeDepart" name="villeDepart" required="required" class="form-control">
 *       <option value="" selected="selected">Ville de départ</option><option value="68">Ahfir</option>
 *       <option value="41">Al hoceima</option> … <option value="14">Tanger</option> … <option value="66">Zaio</option></select>
 *     <select id="villeArrive" name="villeArrive" …><option value="" selected="selected">Votre destination</option> …same options…
 *     <input type="text" id="dateDepart" name="dateDepart" required="required" readonly="readonly" class="date-picker form-control" />
 *   59 cities today (Ahfir … Zaio, alphabetical, ids 10 – 70 with gaps; Tanger 14, Casablanca 10, Fes 11).
 *   The answer repeats the form with the chosen options `selected="selected"` and, in the results container
 *   `<div class="container mt-2 mb-2">`, one card per bus that serves the pair, or the explicit no-result heading:
 *     <div class="card"> … <table><tr><td><h2>00:30</h2></td><td class="col-sm-4"><div class="foo rectangle"></div>…arrow…</td>
 *       <td><h2>05:30</h2></td></tr><tr><td><h6>Tanger</h6></td><td></td><td><h6>Casablanca</h6></td></tr></table> … </div>
 *     <div class="container mt-2 mb-2"><h2>Aucun résultat pour cette recherche</h2></div>
 *   Tanger → Casablanca: 10 cards 00:30→05:30, 02:00→06:30, 03:30→08:30, 04:00→09:15 … 22:30→03:30 (an arrival earlier
 *   than the departure is the next day). A card has no bus number, no stops, no price, no date: only the two times and
 *   the two city names. `villeArrive` empty or missing, or an unknown id, is an HTTP 500; the same city twice is "no result".
 *   Other pages (`/NotreReseau`, `/explorerNotreCarte`, `/preparerVotreVoyage`, `/quality`, sitemap.xml – dated 2020, for
 *   the old domain nejmchamal.ma) list no lines. `/explorerNotreCarte` lists the agencies ("Tanger (Gare Routière)",
 *   "Casablanca Ouled Ziane", "Nador Taouima", "Oujda Al Omrane", "Meknes Zitoune", "Al Hoceima Gare Routière", "Imzouren Gare
 *   Routière" …) without coordinates. `/quality` promises "plus de 50 villes … chaque jour parmi 70 trajets".
 *
 * WHAT THIS SCRIPT DOES
 *   1. Reads the cities from the two selects of /horaire (they must be identical, ≥ 40, unique).
 *   2. Asks the form for every ordered pair of cities (59 × 58 = 3,422 GETs; no cheaper enumeration exists: there is no
 *      "all destinations" query, no JSON endpoint, no line list – an origin can only be asked destination by destination,
 *      and whether a city starts buses can only be told by asking it; two requests at a time, 100 ms pause each). Every
 *      page is parsed strictly (see FAILS ON PURPOSE). 841 pairs have buses (1,978 cards), the other 2,581 are the
 *      explicit "no result". The date is sent as the form does, and three more requests check that the answer really is
 *      the same for the next Saturday, Sunday and a month later.
 *   3. Rebuilds the buses. The site prints ONE time per bus and stop (the arrival at an intermediate city is also its
 *      departure: of 291 runs read from intermediate cities, every one started in the minute the longer run arrived there),
 *      so a call is a node "city at HH:MM" and a card "Tanger 01:00 → Fes 07:45" an edge between two nodes. All cards of one
 *      bus exist between all pairs of its stops, so a bus is a MAXIMAL CLIQUE of that graph (Bron–Kerbosch): the cards
 *      of an intermediate city (a suffix of the bus) form a smaller clique inside the bus and vanish; buses that leave one
 *      city in the same minute (three buses at Casablanca 15:00) stay apart because their later calls are not linked. The
 *      order of a bus is the order of the card durations from its first stop (the one node no other leads to). 104 buses
 *      with 2 – 13 calls today, 528 distinct calls. Every call has arrival = departure.
 *   4. Stops: each city is one stop, placed by data/geocodes/ma-nejmechamal.json (src/generators/geocodes.ts) at its bus
 *      station (gare routière) where one could be identified, else at the town centre. The bus calling at a city without a
 *      reviewed entry is left out and named (`geo.finish`); a leg faster than MAX_KMH on the straight line leaves its bus out
 *      with a warning (> 10 % of the buses: the source fails).
 *   5. One trip per bus on every day of the build's service window, route_type 200, agency "Nejme Chamal" (Africa/Casablanca,
 *      lang fr), one route per ordered terminus pair (first – last city: "Tanger – Missour").
 *   6. `ctx.observe("from-<city>", cards)` per origin city: the departures and arrivals of that city's cards, nothing else of
 *      the pages. A city that had cards in the last build and has none now is a warning.
 *
 * KNOWN QUIRKS
 *   - The date is ignored: identical cards for each of the seven days 2 – 8 Nov 2026, for 20 Dec 2026, 10 Feb 2027, a date
 *     in 2020 and for "junk" (the date only comes back in the form's input), checked 2026-11-01. So the source STATES one timetable valid on every day it is asked about, and that is what is generated (every day
 *     of the window, no holidays, no seasons, no Fridays off). It gives no validity dates anywhere (no "valid from",
 *     no year), so no staleness rule exists and the feed is never flagged stale; `/quality` itself says "chaque jour".
 *     If the answer ever depends on the date, the date check fails the source instead of reading one day only.
 *   - Only places that are in the form exist: the buses stop at more villages than the 59 cities, which the form cannot show.
 *     Enjil, Khemisset and Salé are in the form but no card mentions them (no bus today).
 *   - "Only alighting" stops: on 24 of the 104 buses one stop (Imzouren, Oued amlil, Arfoud, Azrou, and on some buses Midar,
 *     Driouch, Outat el Haj, Targuist) has no cards of its own (nothing can be booked from there on that bus) but every
 *     other stop of the bus, also the ones AFTER it, has a card TO it – "Tanger 05:15 → Imzouren 20:00" on the Oujda 13:30 →
 *     Tanger 05:15 bus, 14 h 45 "later" – as if the site ordered its stops by a rank that puts it last while its time is in
 *     the middle (116 such backward cards, 12.3 – 23.5 h long). The bus is ordered by the durations from its first stop,
 *     which puts the stop where its time says (Midar 18:00, Imzouren 20:00, Al hoceima 20:30). It is a normal call here; that
 *     one cannot board there is not known to the feed. Cards re-derived from the 104 buses and the 1,975 distinct cards of the
 *     site differ in exactly these: 115 backward cards only on the site, 114 forward cards from those stops only in the feed.
 *   - Buses that meet: "Casablanca 00:15 → Tanger 05:30" and "Tanger 05:30 → Nador 18:45" share the call Tanger 05:30 but no
 *     card links Casablanca with Nador; they stay two trips (the site sells them as two). Several buses also arrive at one
 *     city in the same minute from different origins (Tanger 18:45 four times).
 *   - Oddities in the site's times, taken as printed: the Tanger 14:10 → Oujda 06:30 bus has Targuist 20:00 before Issaguen
 *     20:30 (the road passes Issaguen first) and 3 h 30 from Issaguen to Al hoceima; Tétouan → Chefchaouen takes 2 h 15 to
 *     4 h 40 (45 km straight line); Imzouren → Al hoceima 60 min for 11 km. The slowest legs run at 10 – 20 km/h on the
 *     straight line (Rif mountain roads, unlisted villages), the fastest at 87 km/h (median 40): none is impossible.
 *   - Stops are not at the agencies: one point per city (the main gare routière), although Tanger has three Nejme Chamal
 *     agencies and Casablanca two (Ouled Ziane, Ain Borja); the cards cannot say which one a bus uses.
 *   - Morocco shifts its clock to UTC+0 during Ramadan (Feb – Mar 2027); the card times are local clock times, the GTFS
 *     time zone Africa/Casablanca does the rest (the site does not say whether its times move with the clock).
 *   - Stop names are the city names of the form with proper accents/spelling (the geocode file's `name`), the source
 *     spellings ("Fes", "Meknes", "Al hoceima", "Berkan", "Taourirte", "Errissani" = Rissani, "Anif" = Alnif) are matched
 *     without case and accents; 'Erriche' = Er-Rich, 'Boulmane' = Boulemane, 'Taourirte' = Taourirt are the form's spellings.
 *   - Coordinates: 37 of the 56 cities are placed on a bus station that OSM maps (some unnamed), 16 on the town centre and
 *     2 on a village node where none is mapped (the real boarding point can be a few hundred metres to 1.5 km away), Ksar El
 *     Kébir on the café "de la gare routière". Tanger is the active station south-west of the city (35.728, -5.860), not the
 *     closed one in the centre. The geocode tool's own OSM lookup was useless for Morocco (Tanger → Stendal, Casablanca →
 *     Chile): positions come from bounded OSM searches by hand, see the `note` of each entry.
 *
 * FAILS ON PURPOSE (the build skips the feed and keeps going) when
 *   - /horaire is not the form above: not `<form method="get">` with the three fields, a select missing or holding anything
 *     but options, a placeholder missing, a non-numeric id, the two lists differing, duplicates, fewer than MIN_CITIES (40);
 *   - a result page is not exactly the form above: the page echoes another origin / destination than asked, the results
 *     container is missing, it holds neither "Aucun résultat pour cette recherche" nor cards, a card has other tags than
 *     the known ones or text besides the four headings (a price, a bus type…), a time that is not HH:MM, or city names that
 *     are not the ones asked for; any HTTP error after the retries (fetchPage: 3 retries);
 *   - the same pair answers differently for another date (the timetable now depends on the date);
 *   - nothing at all or fewer than MIN_BUSES (40) buses come out of the cards; more than MAX_CLIQUES (5,000) cliques;
 *   - more than 10 % of the buses have an impossible leg (MAX_KMH 130 on the straight line);
 *   - (not a failure) a city without reviewed coordinates: the buses calling there are left out, named in the build report
 *     (`needsGeocoding`) with the command to run; only when no bus is left the source fails (NeedsGeocodingError).
 *   - There is no "out of date" state: the page has no validity information (see KNOWN QUIRKS).
 *
 * HOW TO RE-CHECK / UPDATE
 *   - `pnpm --filter @etbm/etl run generate -- ma-nejmechamal [--start YYYY-MM-DD]` runs it live (≈ 17 min, 3,426 requests).
 *     With `ETBM_NEJMECHAMAL_CACHE=<dir>` every page read is kept in that directory and reused by the next run (no pause, no
 *     requests; delete the directory for a fresh read) – use it for `geocode` and test runs.
 *   - By hand: `curl -A Mozilla/5.0 'https://www.nejmechamal.ma/horaire?villeDepart=14&villeArrive=10&dateDepart=03/11/2026'`
 *     and compare with the markup above. A new city in the form is picked up by itself; its stop needs
 *     `pnpm --filter @etbm/etl run geocode -- ma-nejmechamal` (the OSM lookup is poor for Morocco: look at every entry, put the
 *     stop on the gare routière, `"source": "manual"` for corrections), review, `--accept`.
 *   - tests: test/nejmechamal.test.ts with the form, a real result page, the no-result page and the cards of the whole
 *     network (test/fixtures/nejmechamal/scan.json, checked 2026-11-01).
 */
export const SITE_URL = "https://www.nejmechamal.ma/";
export const FORM_URL = "https://www.nejmechamal.ma/horaire";

// ---------------------------------------------------------------------------------------------------- the form

export interface City {
  /** value of the <option> (the site's city id) */
  id: string;
  /** the <option> text ("Al hoceima", "Fes") */
  name: string;
}

const fail = (m: string): never => {
  throw new GeneratorError(m);
};

/** &amp; &#039; … in a text of the page. */
export function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[n]!);
}
const clean = (s: string) => decode(s).replace(/\s+/g, " ").trim();

/** Minimum number of cities in the form's selects: fewer means the page is not the form we know. */
export const MIN_CITIES = 40;

/** The `<option>`s of one `<select>`: the placeholder (value "") first, then `value="<id>">name`. */
function selectOptions(html: string, name: string): City[] {
  const m = new RegExp(`<select id="${name}" name="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
  if (!m) return fail(`/horaire: no <select name="${name}"> (the form changed)`);
  const opts = [...m[1]!.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)];
  const rest = m[1]!.replace(/<option value="[^"]*"[^>]*>[^<]*<\/option>/g, "");
  if (rest.trim()) fail(`/horaire: <select name="${name}"> holds more than <option>s: ${rest.trim().slice(0, 80)}`);
  if (!opts.length || opts[0]![1] !== "") fail(`/horaire: <select name="${name}"> does not start with the placeholder option (value="")`);
  const cities: City[] = [];
  for (const o of opts.slice(1)) {
    const id = o[1]!, nm = clean(o[3]!);
    if (!/^\d{1,4}$/.test(id) || !nm) fail(`/horaire: <select name="${name}"> option value="${id}" "${nm}" is not "<number>" + a name`);
    cities.push({ id, name: nm });
  }
  return cities;
}

/**
 * The cities of the search form (`/horaire`): the options of `villeDepart` and `villeArrive` (identical lists).
 * Strict: the form must be the GET form with the three fields, ≥ MIN_CITIES cities, unique ids and names.
 */
export function parseCities(html: string): City[] {
  if (!/<form method="get">/.test(html) || !/<input type="text" id="dateDepart" name="dateDepart"/.test(html)) fail("/horaire: the search form changed (expected <form method=\"get\"> with villeDepart, villeArrive and dateDepart)");
  const from = selectOptions(html, "villeDepart"), to = selectOptions(html, "villeArrive");
  if (JSON.stringify(from) !== JSON.stringify(to)) fail("/horaire: the departure and arrival lists of the form differ");
  if (from.length < MIN_CITIES) fail(`/horaire: only ${from.length} cities in the form (expected at least ${MIN_CITIES}; the form changed?)`);
  const ids = new Set(from.map((c) => c.id)), keys = new Set(from.map((c) => geoKey(c.name)));
  if (ids.size !== from.length || keys.size !== from.length) fail("/horaire: duplicate city ids or names in the form");
  return from;
}

// ---------------------------------------------------------------------------------------------------- result pages

/** One bus that serves a city pair, as the card prints it: departure at the origin, arrival at the destination (HH:MM → minutes of the day). */
export interface PairTrip {
  dep: number;
  /** minutes of the day; smaller than `dep` = the next day */
  arr: number;
}

/** The URL the search form builds: GET /horaire?villeDepart=<id>&villeArrive=<id>&dateDepart=dd/mm/yyyy (the date is ignored by the site, see KNOWN QUIRKS). */
export function pairUrl(from: City, to: City, date: string): string {
  const [y, m, d] = date.split("-");
  return `${FORM_URL}?villeDepart=${from.id}&villeArrive=${to.id}&dateDepart=${encodeURIComponent(`${d}/${m}/${y}`)}`;
}

/** The selected options the page echoes back must be the cities asked for. */
function checkEcho(html: string, from: City, to: City, where: string): void {
  for (const [field, c] of [["villeDepart", from], ["villeArrive", to]] as const) {
    const sel = new RegExp(`<select id="${field}" name="${field}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
    const m = sel ? /<option value="(\d+)" selected="selected">([^<]*)<\/option>/.exec(sel[1]!) : null;
    if (!m || m[1] !== c.id || clean(m[2]!) !== c.name) fail(`${where}: the page answers for another ${field} than asked (${m ? `${m[1]} "${clean(m[2]!)}"` : "no selected option"}, asked ${c.id} "${c.name}")`);
  }
}

const NO_RESULT = /^\s*<h2>\s*Aucun résultat pour cette recherche\s*<\/h2>\s*$/;
const CARD_TAGS = new Set(["div", "img", "table", "tr", "td", "h2", "h6"]);

/**
 * The cards of a result page. Strict: after the form comes the results container, holding either exactly the
 * "Aucun résultat pour cette recherche" heading (→ []) or cards of exactly this form (anything else throws):
 *   <h2>00:30</h2> … <h2>05:30</h2> … <h6>Tanger</h6> … <h6>Casablanca</h6>
 * with HH:MM times and the two city names equal to the ones asked for.
 */
export function parseResults(html: string, from: City, to: City): PairTrip[] {
  const where = `${from.name} → ${to.name}`;
  checkEcho(html, from, to, where);
  const end = html.indexOf("</form>");
  // after the form: the results container; comments (the arrow markup has some) and everything from the first <script> (or the end of the body) on do not count
  const tail = end < 0 ? "" : html.slice(end).replace(/<!--[\s\S]*?-->/g, "").split(/<script|<\/body>/i)[0]!;
  const m = /^<\/form>\s*<\/div>\s*<div class="container mt-2 mb-2">([\s\S]*?)((?:\s*<\/div>)+)\s*$/.exec(tail);
  if (!m) return fail(`${where}: no results container after the search form (the page changed)`);
  const body = m[1]!;
  if (NO_RESULT.test(body)) return [];
  const chunks = body.split('<div class="card">');
  if (chunks[0]!.trim() || chunks.length < 2) fail(`${where}: neither "Aucun résultat pour cette recherche" nor result cards (${clean(body.replace(/<[^>]*>/g, " ")).slice(0, 100)})`);
  const out: PairTrip[] = [];
  chunks.slice(1).forEach((c, i) => {
    const card = `${where}, card ${i + 1}`;
    const tags = [...c.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((t) => t[1]!.toLowerCase());
    const bad = tags.find((t) => !CARD_TAGS.has(t));
    if (bad) fail(`${card}: unexpected <${bad}> in a result card`);
    const heads = tags.filter((t) => t === "h2" || t === "h6");
    if (heads.join() !== "h2,h2,h2,h2,h6,h6,h6,h6") fail(`${card}: expected <h2>dep</h2> <h2>arr</h2> <h6>origin</h6> <h6>destination</h6>, got ${heads.length / 2} headings`);
    // all text of the card is those four headings and nothing else (no price, no bus type…)
    const texts = c.replace(/<[^>]*>/g, "|").split("|").map(clean).filter(Boolean);
    if (texts.length !== 4) fail(`${card}: text outside the four headings: ${JSON.stringify(texts)}`);
    const [dep, arr, o, d] = texts as [string, string, string, string];
    const dm = /^\d{2}:\d{2}$/.test(dep) ? parseHm(dep) : null, am = /^\d{2}:\d{2}$/.test(arr) ? parseHm(arr) : null;
    if (dm === null || am === null) fail(`${card}: unreadable time "${dep}" / "${arr}" (expected HH:MM)`);
    if (o !== from.name || d !== to.name) fail(`${card}: the card runs ${o} → ${d}, asked ${from.name} → ${to.name}`);
    out.push({ dep: dm!, arr: am! });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------- the scan

/** Parallel requests to the site and the pause each worker makes between two requests. */
export const CONCURRENCY = 2;
export const DELAY_MS = 100;

/** origin city id → destination city id → the buses of that pair (only pairs with at least one bus). */
export type Scan = Map<string, Map<string, PairTrip[]>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask the form for every ordered pair of cities (n × (n − 1) GETs, `CONCURRENCY` at a time). The site has no list of
 * the lines and no "all destinations" query (an empty `villeArrive` is an HTTP 500), so the pairs are the only way
 * to learn which buses exist.
 */
export async function scanPairs(cities: City[], date: string, get: (url: string) => Promise<string>, log: (m: string) => void = () => {}, delayMs = 0): Promise<Scan> {
  const jobs: [City, City][] = cities.flatMap((a) => cities.filter((b) => b !== a).map((b): [City, City] => [a, b]));
  const scan: Scan = new Map();
  let done = 0;
  const t0 = Date.now();
  let failed = false; // the first failure ends the scan: the other worker must not go on asking for thousands of pages
  await mapLimit(jobs, CONCURRENCY, async ([a, b]) => {
    if (failed) return;
    try {
      const trips = parseResults(await get(pairUrl(a, b, date)), a, b);
      if (trips.length) {
        let m = scan.get(a.id);
        if (!m) scan.set(a.id, (m = new Map()));
        m.set(b.id, trips);
      }
    } catch (e) {
      failed = true;
      throw e;
    }
    if (delayMs) await sleep(delayMs);
    if (++done % 500 === 0) log(`${done} of ${jobs.length} city pairs read (${Math.round((Date.now() - t0) / 1000)} s)`);
  });
  return scan;
}

// ---------------------------------------------------------------------------------------------------- the buses

/** Minutes of the day as HH:MM (a time past midnight of the first day shows its clock time). */
export const hm = (t: number) => `${String(Math.floor((t % 1440) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;

/** One call of a bus. Times are minutes after midnight of the day the bus leaves its first city (≥ 1440: the next day). */
export interface Call {
  city: City;
  t: number;
}
/** A bus: its calls in order (one time per call: the site prints the same time as arrival and as departure). */
export interface Bus {
  calls: Call[];
}
export const busLabel = (b: Bus) => `${b.calls[0]!.city.name} ${hm(b.calls[0]!.t)} → ${b.calls[b.calls.length - 1]!.city.name} ${hm(b.calls[b.calls.length - 1]!.t)}`;

export interface RebuildStats {
  /** cards (city pair × departure) read */
  cards: number;
  /** cards seen twice (same pair, same departure and arrival) */
  duplicateCards: number;
  /** distinct (city, time) calls */
  nodes: number;
  buses: number;
  /** buses with a stop that only has cards TO it, also from the stops after it (see KNOWN QUIRKS: "Only alighting" stops) */
  withBackwardCards: number;
  backwardCards: number;
  /** cliques in which not exactly one node was the first one (resolved by the shortest rides, or left out when equal) */
  ambiguousStart: number;
  /** buses left out: first stop not decidable, or two stops at the same minute */
  ties: number;
}

/** Upper bound for the maximal cliques of the card graph: more means the cards no longer describe a few dozen buses. */
export const MAX_CLIQUES = 5000;

/**
 * Rebuild the buses from the cards. A card says "a bus is in A at time a and in B at time b". The site prints ONE
 * time per bus and stop (arrival = departure; checked 2026-11-01: each of the 291 runs of an intermediate city that
 * continued a longer run started in the very minute that run arrived there), so a call is a node (city, time of day) and a bus is a set of nodes between which all cards exist:
 * the MAXIMAL CLIQUES of the card graph. Smaller cliques are the same bus seen from a later stop (the card list of
 * an intermediate city is a suffix of the bus), buses leaving a city at the same minute stay apart because their
 * later nodes are not connected. The order of a bus is the order of the card durations from its first node, the one
 * node no other node of the clique leads to.
 */
export function rebuildBuses(scan: Scan, cities: City[], warn: (m: string) => void = () => {}): { buses: Bus[]; stats: RebuildStats } {
  const stats: RebuildStats = { cards: 0, duplicateCards: 0, nodes: 0, buses: 0, withBackwardCards: 0, backwardCards: 0, ambiguousStart: 0, ties: 0 };
  const byId = new Map(cities.map((c) => [c.id, c]));
  const keyOf = (c: City, t: number) => `${c.id}@${t}`;
  const out = new Map<string, Map<string, number>>(); // node → node → minutes from the first to the second
  const nodes: string[] = [];
  const seen = new Set<string>();
  const addNode = (k: string) => {
    if (!seen.has(k)) (seen.add(k), nodes.push(k));
  };
  for (const a of cities)
    for (const b of cities) {
      for (const t of scan.get(a.id)?.get(b.id) ?? []) {
        stats.cards++;
        const u = keyOf(a, t.dep), v = keyOf(b, t.arr);
        addNode(u);
        addNode(v);
        let m = out.get(u);
        if (!m) out.set(u, (m = new Map()));
        if (m.has(v)) stats.duplicateCards++;
        m.set(v, after(t.dep, t.arr));
      }
    }
  stats.nodes = nodes.length;
  const adj = new Map<string, Set<string>>(nodes.map((n) => [n, new Set<string>()]));
  for (const [u, m] of out)
    for (const v of m.keys()) {
      adj.get(u)!.add(v);
      adj.get(v)!.add(u);
    }

  // maximal cliques (Bron–Kerbosch with pivot)
  const cliques: string[][] = [];
  const bk = (r: string[], p: string[], x: string[]): void => {
    if (!p.length && !x.length) {
      cliques.push(r);
      if (cliques.length > MAX_CLIQUES) fail(`the cards form more than ${MAX_CLIQUES} buses – the site's data changed shape`);
      return;
    }
    let pivot = "", best = -1;
    for (const u of [...p, ...x]) {
      const n = p.filter((q) => adj.get(u)!.has(q)).length;
      if (n > best) (best = n), (pivot = u);
    }
    for (const v of p.filter((q) => !adj.get(pivot)!.has(q))) {
      const nv = adj.get(v)!;
      bk([...r, v], p.filter((q) => nv.has(q)), x.filter((q) => nv.has(q)));
      p = p.filter((q) => q !== v);
      x = [...x, v];
    }
  };
  bk([], nodes, []);

  const buses: Bus[] = [];
  for (const c of cliques) {
    // the first node: nothing else of the clique leads to it. Several or none (a pair whose cards exist both ways:
    // the "backward" cards below): the node whose rides to all the others are shortest
    const fwd = (u: string, v: string) => out.get(u)?.get(v);
    let firsts = c.filter((u) => !c.some((w) => w !== u && fwd(w, u) !== undefined));
    if (firsts.length !== 1) {
      stats.ambiguousStart++;
      const total = (u: string) => c.reduce((s, v) => s + (v === u ? 0 : (fwd(u, v) ?? Infinity)), 0);
      const ranked = c.filter((u) => Number.isFinite(total(u))).sort((p, q) => total(p) - total(q));
      if (!ranked.length || (ranked.length > 1 && total(ranked[0]!) === total(ranked[1]!))) {
        warn(`cards of ${c.map((n) => `${byId.get(n.split("@")[0]!)!.name} ${hm(Number(n.split("@")[1]))}`).join(", ")} do not say which stop comes first: left out`);
        stats.ties++;
        continue;
      }
      firsts = [ranked[0]!];
    }
    const first = firsts[0]!;
    const t0 = Number(first.split("@")[1]);
    const calls = c
      .map((n): { n: string; off: number } => ({ n, off: n === first ? 0 : fwd(first, n)! }))
      .sort((p, q) => p.off - q.off);
    if (calls.some((x, i) => i > 0 && x.off === calls[i - 1]!.off)) {
      warn(`two stops at the same minute on the bus from ${byId.get(first.split("@")[0]!)!.name} ${hm(t0)}: left out`);
      stats.ties++;
      continue;
    }
    // cards whose second stop comes earlier on the bus than the first
    let backward = 0;
    const offOf = new Map(calls.map((x) => [x.n, x.off]));
    for (const u of c) for (const v of c) if (u !== v && fwd(u, v) !== undefined && offOf.get(v)! < offOf.get(u)!) backward++;
    if (backward) (stats.withBackwardCards++, (stats.backwardCards += backward));
    buses.push({ calls: calls.map((x) => ({ city: byId.get(x.n.split("@")[0]!)!, t: t0 + x.off })) });
  }
  buses.sort((a, b) => a.calls[0]!.city.name.localeCompare(b.calls[0]!.city.name) || a.calls[0]!.t - b.calls[0]!.t || b.calls.length - a.calls.length);
  stats.buses = buses.length;
  return { buses, stats };
}

/** minutes `b` is after `a` on the 24 h clock (1 … 1439; 0 only for the same minute) */
export const after = (a: number, b: number) => (((b - a) % 1440) + 1440) % 1440;

/** What identifies the timetable read from one origin: its cards per destination, nothing else of the pages. */
export function contentOf(origin: City, scan: Scan, cities: City[]): string {
  const m = scan.get(origin.id);
  return [
    `from ${origin.name}`,
    ...cities.filter((c) => m?.has(c.id)).map((c) => `${c.name}: ${m!.get(c.id)!.map((t) => `${hm(t.dep)}>${hm(t.arr)}`).sort().join(" ")}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------- feed

/** Fewer buses than this: the scan came back (nearly) empty (104 in Nov 2026; the site advertises "70 trajets" a day). */
export const MIN_BUSES = 40;
/**
 * Straight-line speed (km/h) between two calls above which a bus is left out: wrong coordinates or a wrong time in the
 * source. One minute is added to the minutes for the rounding of the times.
 */
export const MAX_KMH = 130;
/** More than this share of the buses implausible: the buses were misread, the source fails. */
export const MAX_IMPLAUSIBLE_SHARE = 0.1;
const GEOCODE_ID = "ma-nejmechamal";

/**
 * The feed of the buses. A bus calling at a city without reviewed coordinates is left out as a whole and named in
 * `dropped`; a city marked `skip` in the geocode file is left out of the buses; a bus with an impossible leg
 * (> MAX_KMH on the straight line) is left out with a warning.
 */
export function buildFeed(buses: Bus[], geo: GeocodeStore, startDate: string, days: number, warn: (m: string) => void, dropped: string[] = []): GtfsFeed {
  const { from, to } = serviceWindow(startDate, days);
  const dates = dateRange(from, to);
  const stops = new Map<string, GtfsStop>();
  const routes = new Map<string, GtfsRoute>();
  const trips: GtfsTrip[] = [];
  const stopTimes: GtfsStopTime[] = [];
  let implausible = 0;
  for (const bus of buses) {
    const label = busLabel(bus);
    const calls: { city: City; t: number; e: GeocodeEntry }[] = [];
    let missing = false;
    for (const c of bus.calls) {
      const e = geo.resolve(c.city.name, `bus ${label}`);
      if (!e) missing = true;
      else if (!e.skip) calls.push({ ...c, e });
    }
    if (missing) {
      dropped.push(label);
      continue;
    }
    if (calls.length < 2) continue;
    let bad = "";
    for (let i = 1; i < calls.length && !bad; i++) {
      const a = calls[i - 1]!, b = calls[i]!;
      const km = haversineKm(a.e.lat, a.e.lon, b.e.lat, b.e.lon), min = b.t - a.t;
      if ((km / (min + 1)) * 60 > MAX_KMH) bad = `${a.city.name} ${hm(a.t)} → ${b.city.name} ${hm(b.t)}: ${km.toFixed(0)} km in ${min} min`;
    }
    if (bad) {
      implausible++;
      warn(`bus ${label}: impossible leg ${bad}, left out`);
      continue;
    }
    const first = calls[0]!, last = calls[calls.length - 1]!;
    const routeId = `${geoKey(first.city.name)}-${geoKey(last.city.name)}`.toLowerCase();
    if (!routes.has(routeId))
      routes.set(routeId, { route_id: routeId, agency_id: AGENCY_ID, route_short_name: "", route_long_name: `${first.e.name} – ${last.e.name}`, route_type: 200, route_url: FORM_URL });
    const base = `${routeId}-${hm(first.t).replace(":", "")}`;
    let tripId = base;
    for (let n = 2; trips.some((t) => t.trip_id === tripId); n++) tripId = `${base}-${n}`;
    trips.push({ route_id: routeId, service_id: SERVICE_ID, trip_id: tripId, trip_headsign: last.e.name });
    calls.forEach((c, i) => {
      const id = geoKey(c.city.name).toLowerCase();
      if (!stops.has(id)) stops.set(id, { stop_id: id, stop_name: c.e.name, stop_lat: c.e.lat, stop_lon: c.e.lon, stop_timezone: TIMEZONE });
      stopTimes.push({ trip_id: tripId, stop_sequence: i + 1, stop_id: id, arr: c.t, dep: c.t });
    });
  }
  if (implausible > Math.max(1, buses.length * MAX_IMPLAUSIBLE_SHARE)) fail(`${implausible} of ${buses.length} buses have impossible legs – the buses were misread or the coordinates are wrong`);
  return {
    agency: [{ agency_id: AGENCY_ID, agency_name: "Nejme Chamal", agency_url: SITE_URL, agency_timezone: TIMEZONE, agency_lang: "fr" }],
    stops: [...stops.values()],
    routes: [...routes.values()],
    trips,
    stopTimes,
    services: new Map([[SERVICE_ID, dates]]),
    info: { publisher: "EuroTrainBusMap (generated from the operator's timetable search)", publisherUrl: FORM_URL, lang: "fr", sourceUrl: FORM_URL },
  };
}

const AGENCY_ID = "nejme-chamal";
const SERVICE_ID = "daily";
const TIMEZONE = "Africa/Casablanca";

// ---------------------------------------------------------------------------------------------------- run

/** Setting this to a directory keeps every page read there and reuses it on the next run (geocode reruns, development). */
export const CACHE_ENV = "ETBM_NEJMECHAMAL_CACHE";

/** `ctx.fetchText`, or with the cache directory set a disk copy of every page (named after the cities, not the date). */
function pageSource(ctx: GeneratorContext): (url: string) => Promise<string> {
  const dir = process.env[CACHE_ENV];
  return async (url) => {
    if (!dir) return ctx.fetchText(url, { expect: /<\/html>/i });
    const q = new URL(url).searchParams;
    const file = join(dir, q.has("villeDepart") ? `p-${q.get("villeDepart")}-${q.get("villeArrive")}.html` : "horaire.html");
    try {
      return await readFile(file, "utf8");
    } catch {
      const text = await ctx.fetchText(url, { expect: /<\/html>/i });
      await mkdir(dir, { recursive: true });
      await writeFile(file, text);
      return text;
    }
  };
}

/**
 * The site ignores the date of the search (every date gives the same cards). That is the assumption "the buses run
 * every day": ask for the busiest pair again with other dates (the next Saturday and Sunday, and a month on) and fail
 * if the answer differs, because then the timetable depends on the date and this script reads only one day of it.
 */
async function checkDateIndependence(ctx: GeneratorContext, cities: City[], scan: Scan): Promise<number> {
  let best: { a: City; b: City; n: number } | null = null;
  for (const a of cities) for (const b of cities) if ((scan.get(a.id)?.get(b.id)?.length ?? 0) > (best?.n ?? 0)) best = { a, b, n: scan.get(a.id)!.get(b.id)!.length };
  if (!best) return fail("no bus at all in the scan");
  const sat = addDays(ctx.startDate, (5 - isoWeekday(ctx.startDate) + 7) % 7 || 7);
  const dates = [sat, addDays(sat, 1), addDays(ctx.startDate, 31)];
  const key = (l: PairTrip[]) => JSON.stringify(l.map((t) => [t.dep, t.arr]).sort());
  const base = key(scan.get(best.a.id)!.get(best.b.id)!);
  for (const d of dates) {
    const got = parseResults(await ctx.fetchText(pairUrl(best.a, best.b, d), { expect: /<\/html>/i }), best.a, best.b);
    if (key(got) !== base) fail(`${best.a.name} → ${best.b.name} answers differently for ${d} than for ${ctx.startDate}: the timetable depends on the date now (this script reads one day and assumes it runs every day)`);
  }
  return dates.length;
}

export default defineGenerator({
  id: "ma-nejmechamal",
  description:
    "Nejme Chamal (private coach company of northern and eastern Morocco): the timetable search of nejmechamal.ma/horaire is asked for every pair of the 59 cities of its form; the buses are rebuilt from the cards (maximal sets of calls that are all linked by cards) and run every day.",
  sourceUrl: FORM_URL,
  generate: (ctx: GeneratorContext) => generateFrom(ctx),
});

/** The generator's run (tests: no pause between requests). */
export async function generateFrom(ctx: GeneratorContext, o: { delayMs?: number } = {}): Promise<GtfsFeed> {
  const geo = await GeocodeStore.load(GEOCODE_ID);
  const get = pageSource(ctx);
  const cities = parseCities(await get(FORM_URL));
  const t0 = Date.now();
  ctx.log(`${cities.length} cities in the form: scanning ${cities.length * (cities.length - 1)} city pairs, ${CONCURRENCY} at a time`);
  const scan = await scanPairs(cities, ctx.startDate, get, ctx.log, o.delayMs ?? (process.env[CACHE_ENV] ? 0 : DELAY_MS));
  const extra = await checkDateIndependence(ctx, cities, scan);
  const requests = cities.length * (cities.length - 1) + 1 + extra;
  ctx.log(`${requests} requests in ${Math.round((Date.now() - t0) / 1000)} s`);

  // the content of each origin city's cards, for the "timetable changed" report
  const seen = new Set<string>();
  for (const c of cities) {
    if (!scan.has(c.id)) continue;
    const key = `from-${geoKey(c.name).toLowerCase()}`;
    seen.add(key);
    const ob = ctx.observe(key, contentOf(c, scan, cities));
    if (ob.changed) ctx.log(`${c.name}: timetable changed (previous version since ${ob.lastChanged})`);
  }
  for (const gone of ctx.knownPages().filter((k) => !seen.has(k))) ctx.warn(`${gone}: no bus leaves that city any more (or the city is gone from the form)`);

  const { buses, stats } = rebuildBuses(scan, cities, ctx.warn);
  if (buses.length < MIN_BUSES) fail(`only ${buses.length} buses rebuilt from ${stats.cards} cards (expected at least ${MIN_BUSES}): the site answered with much less than usual`);
  ctx.log(
    `${stats.cards} cards (${stats.duplicateCards} twice) → ${stats.nodes} calls → ${stats.buses} buses; ${stats.withBackwardCards} buses have a stop that can only be alighted at (${stats.backwardCards} backward cards), ${stats.ambiguousStart} with an ambiguous first stop, ${stats.ties} left out`,
  );
  const dropped: string[] = [];
  const feed = buildFeed(buses, geo, ctx.startDate, ctx.days, ctx.warn, dropped);
  geo.finish(ctx, dropped, feed.trips.length); // names the stops to geocode; fails only when no bus is left
  ctx.log(`${feed.trips.length} trips on ${feed.routes.length} routes, ${feed.stops.length} stops`);
  return feed;
}
