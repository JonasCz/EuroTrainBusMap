/**
 * ŽFBiH (Željeznice Federacije Bosne i Hercegovine): trains of the Federation of Bosnia and Herzegovina, generated from
 * the operator's HTML timetable (no GTFS is published; Transitous' community feed ba_ZFBiH ended on 2025-12-13).
 *
 * SOURCE
 *   https://www.zfbh.ba/en/time-table/ (GET: the table and the footnotes; POST with a station pair: the trains between
 *   them with their times there). Published by the operator for travellers; no licence stated.
 *
 * SHAPE OF THE SOURCE (live, checked 2026-10-19)
 *   - Heading `<h2 class="relacije">ŽFBH Timetable for 2025/2026</h2>`.
 *   - One `<table class="red_voz">`, header "Train number | Train type | Relation | Departure | Arrival", 39 rows:
 *       <tr><td>720</td><td>Fast train</td><td>Čapljina - Sarajevo</td><td>06:03</td><td>08:35</td></tr>
 *       <tr><td>392*</td><td>Fast train</td><td>Ploče - Sarajevo</td><td>05:05</td><td>08:35</td></tr>
 *       <tr><td>710******</td><td>Fast train</td><td>Sarajevo - Maglaj</td><td>16:28</td><td>19:01</td></tr>
 *       <tr><td>2150***</td><td>Local train</td><td>Sarajevo - Zenica</td><td>04:44</td><td>06:28</td></tr>
 *       <tr><td>2402***</td><td>Local train</td><td>Pazarić - Sarajevo</td><td>06:37</td><td>07:11</td></tr>
 *     (Sarajevo – Mostar – Čapljina (– Ploče): 720–723, 390–393, 1390/1391; Sarajevo – Zenica – Maglaj: 710/711,
 *     2101/2102, 2150/2151, 2156–2158; Sarajevo – Visoko: 2160–2171; Sarajevo – Pazarić: 2402–2413.)
 *   - Right after it `<div class="alert alert-warning mt-3"><strong>Note:</strong><br><br><a>* Trains 390 and …</a>…`,
 *     the footnotes, exactly (whitespace collapsed):
 *       *       Trains 390 and 391 operate on Sundays until 25.06.2025. Train 392 operates on Saturdays until 25.06.2026.
 *               Train 393 operates on Fridays until 25.06.2026.
 *       **      Trains operate from 26.06. to 27.09.2026. on Fridays, Saturdays and Sundays.            (1390, 1391)
 *       ***     Trains do not operate on weekends and public holidays.
 *       ****    Train number 2158 operates from 26.06.2026. to 27.09.2026. on Fridays, Saturdays and Sundays.
 *       *****   Trains 2170 and 2171 operate every day, except from 26.06.2026. until 27.09.2026., when they do not
 *               operate on Friday, Saturday and Sunday.
 *       ******  Train 710 does not operate on Saturdays.
 *       ******* Train 711 does not operate on Sundays.
 *   - The station form `<select name="redvoznje_pol">` / `redvoznje_dol` (54 stations, "Choose a station" first, some
 *     names with a trailing space: "Begov Han "). A POST of two stations answers with up to two tables:
 *       <h2 class='relacije'><strong>Sarajevo</strong> - <strong>Konjic</strong> (Departure)</h2>
 *       <table class='red_voz'><tr><th>Train number</th><th colspan='2'>Relation</th><th>Departure</th><th>Arrival</th></tr>
 *       <tr class='relacija'><td><i class='fa fa-train'></i>721</td><td>Sarajevo</td><td>Konjic</td><td>16:46</td><td>17:55</td>…
 *     and "(Arrival)" for the other direction, or "There is an arror! … no trains for this trip at all." – the only
 *     place the intermediate stops are published.
 *
 * WHAT THIS SCRIPT DOES
 *   Reads the table generically (any number of rows; the relation separator may be "-" or "–"), maps each footnote
 *   text to a hard-coded calendar rule (FOOTNOTES below: the texts must match exactly) and asks the station form for
 *   the stops: for a few anchor stations (the trains' end stations; Sarajevo and Maglaj cover all) it queries the anchor
 *   with every other station (≈ 106 requests, ~4 s each, two at a time), so each train gets its time at every station
 *   it calls at. Coordinates from STATIONS below. Service for the build window up to the end of the current annual
 *   timetable (the December timetable change: the page says nothing about the next one); weekday trains skip the FBiH
 *   public holidays (HOLIDAYS_MD).
 *
 * KNOWN QUIRKS
 *   - Ploče footnote dates: the page says 390 / 391 run on Sundays "until 25.06.2025" (a year before the others, probably
 *     meant 2026) and 392 / 393 until 25.06.2026, and 1390 / 1391 only 26.06. – 27.09.2026 – so as published no train to
 *     Ploče runs between October and December. HŽPP's own feed (hr-hz) has 390 – 393 between Ploče and Metković on
 *     Fridays to Sundays until the December 2026 timetable change. The rules follow the page as printed; the Croatian
 *     part stays on the map from hr-hz.
 *   - The station form lists two old train numbers not in the table (2172, 2173 of the 2025 timetable; ignored) and
 *     does not know the Ploče trains.
 *   - The site sometimes cuts an answer off half-way with HTTP 200: only a page ending in </html> counts (retried).
 *   - A train whose station-form stops disagree with the table (other times at its end stations, impossible speeds)
 *     keeps only its two end stations (warning).
 *   - Briješće (a halt in Sarajevo, Novi Grad) has no point in any source: placed on the track by its running times.
 *
 * FAILS ON PURPOSE (the build skips the feed and keeps going) when
 *   the heading does not name the current annual timetable (from 13 Dec 2026 the page must say "2026/2027"; while it
 *   still shows 2025/2026 the source is skipped), the table header or a row cannot be read, a
 *   train type or station is unknown, a footnote text differs from FOOTNOTES or a new footnote appears, a train has an
 *   asterisk count without a footnote or a footnote that does not name it, the footnotes' dates all lie before the
 *   current annual timetable (outdated page), or a station-form answer has an unexpected heading / header / row.
 *
 * HOW TO RE-CHECK / UPDATE
 *   - `pnpm --filter @etbm/etl run generate -- ba-zfbih` runs it against the live page and prints one line per train;
 *     the error names what changed.
 *   - `curl -s https://www.zfbh.ba/en/time-table/ | grep -A30 "Note:"` shows the footnotes: when one changed, update its
 *     text and rule in FOOTNOTES together (and the copy in this header); after the December timetable change expect a
 *     new heading, new train numbers and new footnotes – re-check every rule, and the Ploče trains against hr-hz.
 *   - A new station: add it to STATIONS (OSM / GeoNames, checked against the rail graph).
 *   - Tests: test/generators.test.ts with the page copies in test/fixtures/zfbih/ (refresh them with the live page).
 */
import { defineGenerator, GeneratorError, type GeneratorContext } from "../src/generators/types.ts";
import { dateRange, haversineKm, isoWeekday, parseHm, timetablePeriod, type GtfsFeed, type GtfsStopTime } from "../src/generators/gtfs.ts";
import { serviceWindow } from "../src/generators/registry.ts";

export const SOURCE_URL = "https://www.zfbh.ba/en/time-table/";
export const MAIN_HEADER = ["Train number", "Train type", "Relation", "Departure", "Arrival"];
/** Header of the station form's tables ("Relation" spans the from / to columns). */
export const PAIR_HEADER = ["Train number", "Relation", "Departure", "Arrival"];

/** Train types of the table → route name and GTFS route type (103 interregional → long distance, 106 regional). */
export const TRAIN_TYPES: Record<string, { name: string; routeType: number }> = {
  "Fast train": { name: "Fast train", routeType: 103 },
  "Local train": { name: "Local train", routeType: 106 },
};

/**
 * Stations (names as the site writes them) → [lat, lon]. From the stops of the earlier community GTFS feed (ba_ZFBiH,
 * 2025), checked against GeoNames railway stations (≤ 1.5 km, mostly ≤ 0.3 km: GeoNames rounds) and the rail graph
 * of the build (every point ≤ 25 m from the track); Ploče as in the HŽPP feed (Croatia), so the two
 * feeds' stations merge. Briješće (a halt in Sarajevo, Novi Grad, between Alipašin Most and Rajlovac) has no point in
 * either source: placed on the track by its running times (3 min after Alipašin Most, 2 min before Rajlovac) at the
 * Briješće neighbourhood, ±500 m.
 */
export const STATIONS: Record<string, [number, number]> = {
  "Alići": [44.46778, 18.167068],
  "Alipašin Most": [43.85142, 18.346546],
  "Begov Han": [44.354626, 17.995022],
  "Binježevo": [43.844437, 18.22217],
  "Bistričak": [44.34684, 17.921623],
  "Blažuj": [43.838463, 18.2587],
  "Bradići": [44.518475, 18.16545],
  "Briješće": [43.85302, 18.33073],
  "Buča Potok": [43.853905, 18.36656],
  "Buzići": [44.040356, 18.133495],
  "Čapljina": [43.109848, 17.6978],
  "Ćatići": [44.0968, 18.111866],
  "Dobrinje": [44.05196, 18.109575],
  "Dolina": [44.473923, 18.151958],
  "Drežnica Stara": [43.520557, 17.73838],
  "Drivuša": [44.170414, 17.969341],
  "Fojnica": [44.5098, 18.13102],
  "Globarica": [44.489136, 18.154583],
  "Gora": [44.132755, 17.993217],
  "Hadžići": [43.820793, 18.200556],
  "Ilidža": [43.836174, 18.300598],
  "Ilijaš": [43.947056, 18.264523],
  "Ilijaš Grad": [43.956524, 18.264095],
  "Jablanica Grad": [43.65278, 17.763765],
  "Janjići": [44.154842, 17.962831],
  "Jelina": [44.266514, 17.879307],
  "Kakanj": [44.120625, 18.10575],
  "Konjic": [43.65715, 17.961355],
  "Lašva": [44.128765, 17.94226],
  "Lješevo": [43.989983, 18.229057],
  "Maglaj": [44.546635, 18.093096],
  "Modrinje": [44.131588, 18.019814],
  "Mostar": [43.348995, 17.813885],
  "Mračaj": [44.359657, 18.004604],
  "Natron": [44.529697, 18.093517],
  "Nemila": [44.32577, 17.908302],
  "Pazarić": [43.7897, 18.151978],
  "Ploče": [43.04859, 17.433409],
  "Podlugovi": [43.969913, 18.254982],
  "Porječani": [44.026733, 18.14979],
  "Rajlovac": [43.858585, 18.316427],
  "Reljevo": [43.888752, 18.32878],
  "Roščevina": [44.133904, 18.072638],
  "Sarajevo": [43.86046, 18.39895],
  "Semizovac": [43.916164, 18.318779],
  "Tomići": [44.51294, 18.144222],
  "Vinište": [44.42484, 18.105402],
  "Visoko": [43.996506, 18.183006],
  "Vogošća": [43.933483, 18.301575],
  "Zavidovići": [44.445137, 18.145735],
  "Želeće": [44.397484, 17.994123],
  "Zenica": [44.210186, 17.912622],
  "Zenica Teretna": [44.220573, 17.911793],
  "Žepče": [44.426224, 18.02951],
  "Žitomislići": [43.20409, 17.784626],
};
/** Stations outside Bosnia and Herzegovina (stop_timezone). */
const STATION_TZ: Record<string, string> = { "Ploče": "Europe/Zagreb" };

/**
 * Public holidays of the Federation of BiH (Zakon o praznicima FBiH; the days the earlier community feed also left
 * out): New Year 1–2 January, Independence Day 1 March, Labour Day 1–2 May, Statehood Day 25 November. Religious
 * holidays are days off only for the believers of each faith and are not counted.
 */
export const HOLIDAYS_MD = ["01-01", "01-02", "03-01", "05-01", "05-02", "11-25"];
export const isHoliday = (iso: string) => HOLIDAYS_MD.includes(iso.slice(5));

type DayRule = (iso: string) => boolean;
const FRI = 4, SAT = 5, SUN = 6;
const on = (...wd: number[]): DayRule => (d) => wd.includes(isoWeekday(d));
const between = (from: string, to: string): DayRule => (d) => d >= from && d <= to;
const and = (...r: DayRule[]): DayRule => (d) => r.every((f) => f(d));
const not = (r: DayRule): DayRule => (d) => !r(d);

export interface KnownFootnote {
  /** "*", "**", … */
  marker: string;
  /** The exact text after the marker (whitespace collapsed). */
  text: string;
  /** Train number → days it runs; for a footnote about all its trains, `all`. A train it does not name fails the source. */
  trains?: Record<string, DayRule>;
  all?: DayRule;
}

/**
 * The footnotes of the page, exactly as published (October 2026), with what they mean. A changed text means the
 * calendar changed: update the text and the rule together.
 */
export const FOOTNOTES: KnownFootnote[] = [
  {
    marker: "*",
    // "25.06.2025" for 390 / 391 as printed (probably meant 2026; either way in the past now).
    text: "Trains 390 and 391 operate on Sundays until 25.06.2025. Train 392 operates on Saturdays until 25.06.2026. Train 393 operates on Fridays until 25.06.2026.",
    trains: {
      "390": and(on(SUN), (d) => d <= "2025-06-25"),
      "391": and(on(SUN), (d) => d <= "2025-06-25"),
      "392": and(on(SAT), (d) => d <= "2026-06-25"),
      "393": and(on(FRI), (d) => d <= "2026-06-25"),
    },
  },
  { marker: "**", text: "Trains operate from 26.06. to 27.09.2026. on Fridays, Saturdays and Sundays.", all: and(between("2026-06-26", "2026-09-27"), on(FRI, SAT, SUN)) },
  { marker: "***", text: "Trains do not operate on weekends and public holidays.", all: (d) => isoWeekday(d) < SAT && !isHoliday(d) },
  {
    marker: "****",
    text: "Train number 2158 operates from 26.06.2026. to 27.09.2026. on Fridays, Saturdays and Sundays.",
    trains: { "2158": and(between("2026-06-26", "2026-09-27"), on(FRI, SAT, SUN)) },
  },
  {
    marker: "*****",
    text: "Trains 2170 and 2171 operate every day, except from 26.06.2026. until 27.09.2026., when they do not operate on Friday, Saturday and Sunday.",
    trains: Object.fromEntries(["2170", "2171"].map((n) => [n, not(and(between("2026-06-26", "2026-09-27"), on(FRI, SAT, SUN)))])),
  },
  { marker: "******", text: "Train 710 does not operate on Saturdays.", trains: { "710": not(on(SAT)) } },
  { marker: "*******", text: "Train 711 does not operate on Sundays.", trains: { "711": not(on(SUN)) } },
];

// ---------------------------------------------------------------- HTML parsing

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—" };
/** Text of an HTML fragment: tags removed, entities decoded, whitespace collapsed. */
export function text(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
    )
    .replace(/[\s ]+/g, " ")
    .trim();
}

/** Rows of a <table> fragment as cell texts (th and td), header row included. */
function tableRows(table: string): { cells: string[]; th: boolean }[] {
  // rows are not always closed (<tr>…<tr>…</table>): split at every <tr
  return table
    .split(/<tr\b[^>]*>/i)
    .slice(1)
    .map((r) => {
      const cells = [...r.matchAll(/<(t[dh])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => text(m[2]!));
      return { cells, th: /<th\b/i.test(r) };
    })
    .filter((r) => r.cells.length);
}

export interface TableRow {
  number: string;
  /** asterisks after the number ("" = runs daily) */
  marker: string;
  type: string;
  from: string;
  to: string;
  dep: number;
  arr: number;
}
export interface MainPage {
  /** "ŽFBH Timetable for 2025/2026" → [2025, 2026] */
  years: [number, number];
  rows: TableRow[];
  /** marker → footnote text, in page order */
  footnotes: Map<string, string>;
  /** names of the station form ("Choose a station"), trimmed */
  stations: string[];
}

const fail = (m: string): never => {
  throw new GeneratorError(m);
};

/** Parse the timetable page; throws a GeneratorError on anything not in the expected shape. */
export function parseMainPage(html: string): MainPage {
  const yh = /Timetable for (\d{4})\s*\/\s*(\d{4})/.exec(text(html.match(/<h2 class=["']relacije["']>(?:(?!<\/h2>)[\s\S])*<\/h2>/gi)?.join(" ") ?? ""));
  if (!yh) fail('no "ŽFBH Timetable for YYYY/YYYY" heading on the page');
  const years: [number, number] = [Number(yh![1]), Number(yh![2])];
  const tables = [...html.matchAll(/<table\b[^>]*class=["']red_voz["'][^>]*>([\s\S]*?)<\/table>/gi)];
  if (!tables.length) fail("no timetable table (table.red_voz) on the page");
  const main = tables[0]!;
  const rows = tableRows(main[1]!);
  const head = rows[0];
  if (!head?.th || JSON.stringify(head.cells) !== JSON.stringify(MAIN_HEADER)) fail(`table header changed: ${JSON.stringify(head?.cells)} (expected ${JSON.stringify(MAIN_HEADER)})`);
  const out: TableRow[] = [];
  const seen = new Set<string>();
  for (const r of rows.slice(1)) {
    const line = r.cells.join(" | ");
    if (r.th || r.cells.length !== 5) fail(`unreadable row: ${line}`);
    const [num, type, rel, dep, arr] = r.cells as [string, string, string, string, string];
    const nm = /^(\d{2,5})(\**)$/.exec(num);
    if (!nm) fail(`unreadable train number in row: ${line}`);
    if (!TRAIN_TYPES[type]) fail(`unknown train type "${type}" in row: ${line}`);
    const parts = rel.split(/\s*[-–—]\s*/);
    if (parts.length !== 2 || !parts[0] || !parts[1]) fail(`unreadable relation "${rel}" in row: ${line}`);
    const d = parseHm(dep), a = parseHm(arr);
    if (d === null || a === null) fail(`unreadable times in row: ${line}`);
    if (seen.has(nm![1]!)) fail(`train ${nm![1]} listed twice`);
    seen.add(nm![1]!);
    out.push({ number: nm![1]!, marker: nm![2]!, type, from: parts[0]!, to: parts[1]!, dep: d!, arr: a! });
  }
  if (out.length < 10) fail(`only ${out.length} trains in the table (page truncated?)`);

  // the footnotes: <strong>Note:</strong> … </div> right after the table
  const after = html.slice(main.index! + main[0].length);
  const nb = /<strong>\s*Note:\s*<\/strong>([\s\S]*?)<\/div>/i.exec(after);
  const footnotes = new Map<string, string>();
  if (nb) {
    const t = text(nb[1]!);
    const parts = t.split(/(?:^|\s)(\*+)\s/);
    if (parts[0]!.trim()) fail(`footnote text without asterisks: "${parts[0]!.trim()}"`);
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const m = parts[i]!, body = parts[i + 1]!.trim();
      if (footnotes.has(m)) fail(`footnote ${m} appears twice`);
      footnotes.set(m, body);
    }
  } else if (out.some((r) => r.marker)) fail("no Note: block although trains carry asterisks");

  const sel = /<select\b[^>]*name=["']redvoznje_pol["'][^>]*>([\s\S]*?)<\/select>/i.exec(html);
  const stations = sel ? [...sel[1]!.matchAll(/<option(?![^>]*disabled)[^>]*>([\s\S]*?)<\/option>/gi)].map((m) => text(m[1]!)).filter(Boolean) : [];
  return { years, rows: out, footnotes, stations };
}

export interface PairRow {
  number: string;
  from: string;
  to: string;
  dep: number;
  arr: number;
}

/**
 * Parse the answer of the station form for (a, b): the trains a → b ("(Departure)") and b → a ("(Arrival)"), or
 * none ("There is an arror! … no trains for this trip at all."). Throws on anything else.
 */
export function parsePairPage(html: string, a: string, b: string): PairRow[] {
  const out: PairRow[] = [];
  // the pair tables: a heading "<strong>A</strong> - <strong>B</strong> (Departure)" right before each (the page's own
  // "ŽFBH Timetable for …" table has a heading without <strong>)
  const blocks = [...html.matchAll(/<h2 class=["']relacije["']>((?:(?!<\/h2>)[\s\S])*)<\/h2>\s*<table\b[^>]*class=["']red_voz["'][^>]*>([\s\S]*?)<\/table>/gi)].filter((m) =>
    /<strong>/i.test(m[1]!),
  );
  if (!blocks.length) {
    if (/no trains for this trip/i.test(html)) return out;
    fail(`station form ${a} – ${b}: neither trains nor "no trains" in the answer`);
  }
  for (const blk of blocks) {
    const h = [...blk[1]!.matchAll(/<strong>([\s\S]*?)<\/strong>/gi)].map((m) => text(m[1]!));
    if (h.length !== 2 || !((h[0] === a && h[1] === b) || (h[0] === b && h[1] === a))) fail(`station form ${a} – ${b}: unexpected heading "${text(blk[1]!)}"`);
    const rows = tableRows(blk[2]!);
    if (!rows[0]?.th || JSON.stringify(rows[0].cells) !== JSON.stringify(PAIR_HEADER)) fail(`station form ${a} – ${b}: table header changed: ${JSON.stringify(rows[0]?.cells)}`);
    for (const r of rows.slice(1)) {
      const [num, from, to, dep, arr] = r.cells;
      const d = parseHm(dep ?? ""), ar = parseHm(arr ?? "");
      if (r.cells.length !== 5 || !/^\d{2,5}$/.test(num ?? "") || from !== h[0] || to !== h[1] || d === null || ar === null)
        fail(`station form ${a} – ${b}: unreadable row ${r.cells.join(" | ")}`);
      out.push({ number: num!, from: from!, to: to!, dep: d!, arr: ar! });
    }
  }
  return out;
}

// ---------------------------------------------------------------- calendar

/** Dates (dd.mm.yyyy) a footnote text mentions. */
function footnoteDates(t: string): string[] {
  return [...t.matchAll(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g)].map((m) => `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`);
}

/**
 * The service rule of every train: footnotes matched against FOOTNOTES (exact text), every marker used by a train
 * known, every train named by its footnote. Throws on any mismatch.
 */
export function trainRules(page: MainPage, startDate: string): Map<string, DayRule | null> {
  for (const [m, t] of page.footnotes) {
    const k = FOOTNOTES.find((f) => f.marker === m);
    if (!k) fail(`unknown footnote ${m} "${t}"`);
    if (k!.text !== t) fail(`footnote ${m} changed: "${t}" (known: "${k!.text}")`);
  }
  // outdated page: the heading names another timetable year, or every date of the footnotes lies before it
  const period = timetablePeriod(startDate);
  const want = [Number(period.start.slice(0, 4)), Number(period.end.slice(0, 4))];
  if (page.years[0] !== want[0] || page.years[1] !== want[1])
    fail(`the page shows the timetable ${page.years.join("/")}, the current one is ${want.join("/")} (${period.start} – ${period.end})`);
  const dates = [...page.footnotes.values()].flatMap(footnoteDates).sort();
  if (dates.length && dates[dates.length - 1]! < period.start)
    fail(`timetable looks outdated: the latest date in its footnotes (${dates[dates.length - 1]}) is before the current timetable (from ${period.start})`);
  const out = new Map<string, DayRule | null>();
  for (const r of page.rows) {
    if (!r.marker) {
      out.set(r.number, null);
      continue;
    }
    if (!page.footnotes.has(r.marker)) fail(`train ${r.number}${r.marker}: no footnote ${r.marker} on the page`);
    const k = FOOTNOTES.find((f) => f.marker === r.marker)!;
    const rule = k.all ?? k.trains?.[r.number];
    if (!rule) fail(`train ${r.number}${r.marker}: footnote ${r.marker} does not name this train`);
    out.set(r.number, rule!);
  }
  return out;
}

// ---------------------------------------------------------------- stops from the station form

/** Anchor stations to query: end stations of the trains, the most used first, until every train has one. */
export function chooseAnchors(rows: TableRow[], formStations: string[]): string[] {
  const known = new Set(formStations);
  const left = new Set(rows.filter((r) => known.has(r.from) || known.has(r.to)));
  const anchors: string[] = [];
  while (left.size) {
    const count = new Map<string, number>();
    for (const r of left) for (const s of [r.from, r.to]) if (known.has(s)) count.set(s, (count.get(s) ?? 0) + 1);
    const best = [...count].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0]![0];
    anchors.push(best);
    for (const r of [...left]) if (r.from === best || r.to === best) left.delete(r);
  }
  return anchors;
}

interface Call {
  station: string;
  arr: number;
  dep: number;
}

/**
 * The calls of one train from the station form's rows (anchored at one or both of its end stations), checked
 * against the table; null when they disagree (the caller keeps the two end stations). `why` gets the reason.
 */
export function trainCalls(r: TableRow, pairs: PairRow[], anchors: Set<string>, why: (m: string) => void): Call[] | null {
  const hm = (t: number) => `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  const day = (t: number) => (t < r.dep - 60 ? t + 1440 : t); // past midnight
  const arrD = day(r.arr);
  const at = new Map<string, { arr?: number; dep?: number }>();
  const put = (s: string, k: "arr" | "dep", t: number) => {
    const e = at.get(s) ?? {};
    if (e[k] !== undefined && e[k] !== t) return why(`${s} has two ${k === "arr" ? "arrival" : "departure"} times`), false;
    e[k] = t;
    at.set(s, e);
    return true;
  };
  for (const p of pairs) {
    if (p.number !== r.number) continue;
    // a row from the start: the time at its other station is an arrival; a row to the end: a departure (a row from
    // start to end is both)
    if (anchors.has(r.from) && p.from === r.from) {
      if (p.dep !== r.dep) return why(`leaves ${r.from} at ${hm(p.dep)} in the station form, ${hm(r.dep)} in the table`), null;
      if (!put(p.to, "arr", day(p.arr))) return null;
    }
    if (anchors.has(r.to) && p.to === r.to) {
      if (p.arr !== r.arr) return why(`reaches ${r.to} at ${hm(p.arr)} in the station form, ${hm(r.arr)} in the table`), null;
      if (!put(p.from, "dep", day(p.dep))) return null;
    }
  }
  if (!at.size) return why("not in the station form"), null;
  const end = at.get(r.to), start = at.get(r.from);
  if (anchors.has(r.from) && end?.arr !== arrD) return why(`the station form does not reach ${r.to} at the table's time`), null;
  if (anchors.has(r.to) && start?.dep !== r.dep) return why(`the station form does not leave ${r.from} at the table's time`), null;
  at.delete(r.from);
  at.delete(r.to);
  const mid: Call[] = [];
  for (const [s, e] of at) {
    const arr = e.arr ?? e.dep!, dep = e.dep ?? e.arr!;
    if (dep < arr || arr < r.dep || dep > arrD) return why(`time at ${s} outside the run or before its arrival`), null;
    mid.push({ station: s, arr, dep });
  }
  const pos = (s: string) => STATIONS[s];
  for (const c of mid) if (!pos(c.station)) fail(`train ${r.number} calls at "${c.station}", which has no coordinates in STATIONS`);
  const o = pos(r.from)!;
  mid.sort((x, y) => x.arr - y.arr || x.dep - y.dep || haversineKm(o[0], o[1], ...pos(x.station)!) - haversineKm(o[0], o[1], ...pos(y.station)!));
  const calls: Call[] = [{ station: r.from, arr: r.dep, dep: r.dep }, ...mid, { station: r.to, arr: arrD, dep: arrD }];
  for (let i = 1; i < calls.length; i++) {
    const a = pos(calls[i - 1]!.station)!, b = pos(calls[i]!.station)!;
    const km = haversineKm(a[0], a[1], b[0], b[1]);
    const min = calls[i]!.arr - calls[i - 1]!.dep;
    if (min < 0 || (min === 0 ? km > 3 : (km / min) * 60 > 160)) return why(`impossible hop ${calls[i - 1]!.station} → ${calls[i]!.station} (${km.toFixed(1)} km in ${min} min)`), null;
  }
  return calls;
}

// ---------------------------------------------------------------- feed

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

export interface BuildInput {
  page: MainPage;
  /** rows of the station form (empty: end stations only) */
  pairs: PairRow[];
  anchors: string[];
  startDate: string;
  days: number;
  warn(m: string): void;
  log?(m: string): void;
}

/** The GTFS feed from the parsed page (and station form). */
export function buildFeed(o: BuildInput): GtfsFeed {
  const rules = trainRules(o.page, o.startDate);
  const win = serviceWindow(o.startDate, o.days);
  const period = timetablePeriod(o.startDate);
  const last = win.to < period.end ? win.to : period.end;
  const days = win.from <= last ? dateRange(win.from, last) : [];
  const anchors = new Set(o.anchors);
  const feed: GtfsFeed = {
    agency: [{ agency_id: "zfbih", agency_name: "Željeznice Federacije BiH", agency_url: "https://www.zfbh.ba/", agency_timezone: "Europe/Sarajevo", agency_lang: "bs" }],
    stops: [],
    routes: [],
    trips: [],
    stopTimes: [],
    services: new Map(),
    info: { publisher: "EuroTrainBusMap (generated from the ŽFBiH timetable page)", publisherUrl: SOURCE_URL, lang: "bs", sourceUrl: SOURCE_URL },
  };
  const stopIds = new Map<string, string>();
  const stop = (name: string) => {
    let id = stopIds.get(name);
    if (id) return id;
    const p = STATIONS[name];
    if (!p) fail(`unknown station "${name}" (add its coordinates to STATIONS)`);
    id = slug(name);
    stopIds.set(name, id);
    feed.stops.push({ stop_id: id, stop_name: name, stop_lat: p![0], stop_lon: p![1], ...(STATION_TZ[name] ? { stop_timezone: STATION_TZ[name] } : {}) });
    return id;
  };
  const services = new Map<string, string>(); // date list → service id
  let endsOnly = 0, idle = 0;
  for (const r of o.page.rows) {
    for (const s of [r.from, r.to]) if (!STATIONS[s]) fail(`unknown station "${s}" in the relation of train ${r.number} (add its coordinates to STATIONS)`);
    const rule = rules.get(r.number);
    const dates = rule ? days.filter(rule) : days;
    if (!dates.length) {
      idle++;
      o.log?.(`train ${r.number}${r.marker} (${r.from} – ${r.to}) does not run between ${win.from} and ${last}`);
      continue;
    }
    const key = dates.join(",");
    let sid = services.get(key);
    if (!sid) services.set(key, (sid = `s${services.size + 1}`));
    feed.services.set(sid, dates);
    const t = TRAIN_TYPES[r.type]!;
    const rid = `${slug(r.type)}-${slug(r.from)}-${slug(r.to)}`;
    if (!feed.routes.some((x) => x.route_id === rid))
      feed.routes.push({ route_id: rid, agency_id: "zfbih", route_short_name: t.name, route_long_name: `${r.from} – ${r.to}`, route_type: t.routeType, route_url: SOURCE_URL });
    feed.trips.push({ route_id: rid, service_id: sid, trip_id: r.number, trip_headsign: r.to, trip_short_name: r.number });
    let calls = o.pairs.length ? trainCalls(r, o.pairs, anchors, (m) => o.warn(`train ${r.number} (${r.from} – ${r.to}): ${m}; only its end stations are used`)) : null;
    if (!calls) {
      endsOnly++;
      const arr = r.arr < r.dep ? r.arr + 1440 : r.arr;
      calls = [
        { station: r.from, arr: r.dep, dep: r.dep },
        { station: r.to, arr, dep: arr },
      ];
    }
    calls.forEach((c, i) => feed.stopTimes.push({ trip_id: r.number, stop_sequence: i + 1, stop_id: stop(c.station), arr: c.arr, dep: c.dep } satisfies GtfsStopTime));
  }
  o.log?.(`${feed.trips.length} trains run (${idle} not in the window), ${feed.trips.length - endsOnly} with their stops from the station form, ${endsOnly} with end stations only; service ${days[0] ?? "-"} … ${last} (timetable ends ${period.end})`);
  return feed;
}

/** Run async tasks, `limit` at a time. */
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export default defineGenerator({
  id: "ba-zfbih",
  description: "ŽFBiH trains (Federation of Bosnia and Herzegovina) from the HTML timetable of zfbh.ba: table rows + hard-coded footnote rules, stops from the station form.",
  sourceUrl: SOURCE_URL,
  async generate(ctx: GeneratorContext) {
    // the site sometimes cuts an answer off half-way (HTTP 200): only a complete page counts
    const expect = /<\/html>/i;
    const page = parseMainPage(await ctx.fetchText(SOURCE_URL, { expect }));
    ctx.log(`${page.rows.length} trains in the table, footnotes ${[...page.footnotes.keys()].join(" ")}, ${page.stations.length} stations in the form`);
    // fail early on footnotes / stations, before the slow station queries
    trainRules(page, ctx.startDate);
    for (const r of page.rows) for (const s of [r.from, r.to]) if (!STATIONS[s]) fail(`unknown station "${s}" in the relation of train ${r.number} (add its coordinates to STATIONS)`);
    const anchors = chooseAnchors(page.rows, page.stations);
    const queries = anchors.flatMap((a) => page.stations.filter((s) => s !== a).map((s) => [a, s] as const));
    ctx.log(`station form: ${queries.length} queries (anchors ${anchors.join(", ")})`);
    // two at a time: the site takes ~4 s per answer
    const answers = await pool(queries, 2, async ([a, b]) => parsePairPage(await ctx.fetchText(SOURCE_URL, { form: { redvoznje_pol: a, redvoznje_dol: b }, expect }), a, b));
    const pairs = answers.flat();
    const inTable = new Set(page.rows.map((r) => r.number));
    const extra = [...new Set(pairs.map((p) => p.number).filter((n) => !inTable.has(n)))];
    if (extra.length) ctx.log(`station form lists trains not in the table (ignored): ${extra.join(", ")}`);
    return buildFeed({ page, pairs, anchors, startDate: ctx.startDate, days: ctx.days, warn: ctx.warn, log: ctx.log });
  },
});
