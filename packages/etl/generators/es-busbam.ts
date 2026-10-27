import { defineGenerator, GeneratorError } from "../src/generators/types.ts";
import { dateRange, isoWeekday, parseHm, type GtfsFeed, type GtfsRoute, type GtfsStop, type GtfsStopTime, type GtfsTrip } from "../src/generators/gtfs.ts";
import { serviceWindow } from "../src/generators/registry.ts";
import { GeocodeStore, geoKey, type GeocodeEntry } from "../src/generators/geocodes.ts";
import { mapLimit } from "../src/generators/pool.ts";

const INDEX_URL = "https://www.busbam.com/horarios/";

/**
 * BusBam (Autobuses Bam, Almería): the operator's regular coach and bus lines between Almería, Cartagena, Alicante,
 * Murcia, Madrid, Granada, Jaén and the villages in between, generated from the HTML timetables on its website (no
 * GTFS is published).
 *
 * SOURCE
 *   https://www.busbam.com/horarios/ – the index linking one page per line group, published by the operator for
 *   travellers (tickets via movelia.es); no licence stated. `robots.txt` answered 403 to curl on 2026-10-26 (no rules
 *   readable); the pages answer 200 to the build's User-Agent; the script makes 5 requests per build. Pages:
 *   (pages seen on the index today – the script follows whatever the index links:)
 *     /horarios/almeria-cartagena-alicante/  line VAC-228/250   (4 tables)
 *     /horarios/almeria-jaen/                lines VJA-157/158/174 (13 tables: Almería–Fiñana, Almería–Jaén, Mojácar–
 *                                            Granada, Baza–Guadix–Granada, Guadix–Granada, Úbeda–Granada, Castril–Baza,
 *                                            Puebla de Don Fadrique–Baza, Campo Cámara–Baza)
 *     /horarios/almeria-madrid/              line VAC-216       (2 tables)
 *     /horarios/murcia-torrevieja/           line VAC-250       (2 tables)
 *
 * SHAPE OF THE SOURCE (live, checked 2026-10-26)
 *   Every page is a WordPress / Elementor page whose timetables are TablePress tables (`<table id="tablepress-N">`),
 *   each below an `<h2>` with its name; the page has a paragraph `LÍNEA VAC - 228/250` with the line code. Three table
 *   layouts occur, told apart by the header:
 *   (A) stops down, one column per trip – header `ITINERARIO | <calendar label> …`, a cell is a time or `---`:
 *         <h2>Cartagena - Almería</h2>
 *         ITINERARIO          | DE LUNES A SÁBADOS | DOMINGOS Y FESTIVOS | DIARIO (TODOS LOS DÍAS)
 *         CARTAGENA           | 10:15              | 12:15               | 15:30
 *         PUERTO DE MAZARRÓN  | 10:55              | 12:55               | 16:10
 *       Madrid – Almería adds a trip column `NUEVO · DIRECTO`; Almería–Fiñana has `ESCÚLLAR (Solo Viernes)` and
 *       Fiñana–Almería `ESCÚLLAR (Solo Lunes)` as stop names. Trips past midnight simply continue (`23:59`, `5:15`).
 *   (B) both directions side by side – left columns `IDA (Granada → Mojácar) laborables|diario`, a middle column
 *       `ITINERARIO` between two arrow columns (`↓` / `↑`), right columns `VUELTA (Mojácar → Granada) …`; in Puebla de
 *       Don Fadrique and Campo Cámara the calendar words are a second header row (`LABORABLES | FESTIVOS`):
 *         IDA (Úbeda → Granada ) Lunes a Viernes Laborables | | ITINERARIO | | VUELTA (Granada → Úbeda ) Lunes a …
 *         ---   | ↓ | ÚBEDA | ↑ | 16:45
 *         6:15  | ↓ | JÓDAR | ↑ | 16:30
 *       The left (IDA) times run down the table, the right (VUELTA) times run up it (the last row is the origin).
 *   (C) one row per trip – header rows `| → | → | →` and `| BAZA | GUADIX | GRANADA`, then
 *         LUNES A VIERNES LABORALES | 6:00 | 6:45 | 7:35
 *         DIARIO EXCEPTO FESTIVOS   | 15:30 | 16:20 | 17:00
 *   Notes below tables (exact texts the script knows, see NOTES / EXCEPTION below):
 *         NUEVO servicio directo diario Madrid – Almería (salida 08:00). Válido del 02/11/2026 al 31/03/2027.
 *         *Excepción: El horario diario 4 de Roquetas de Mar (16:15) se realiza únicamente el Domingo de Resurrección
 *           y los domingos de la temporada de verano.                      (cell `*16:15` in Almería–Madrid)
 *         * El servicio de las 16:30 Puebla de Don Fabrique de los Domingos y Festivos llega hasta Granada
 *         ** El servicio de las 17:00 Baza-Puebla de Don Fadrique sale desde Granada a las 15:30 de Lunes a Viernes Laborables
 *         * HUESCAR Sólo para si lleva gente                               (Castril – Baza; a request stop)
 *       (all of them also in the NOTES / EXCEPTION / REQUEST_STOP constants below; texts are compared normalised)
 *
 * WHAT THIS SCRIPT DOES
 *   1. Fetches the index and follows EVERY `/horarios/<line>/` link on it (the four pages above today; two requests at a
 *      time) – a new line page is parsed like the others, a page that disappeared is just gone (warning if the
 *      last build had it, from the content state). Each page's tables + notes are handed to `ctx.observe`, which keeps
 *      their hash between builds (src/generators/state.ts), so the build knows which timetables changed.
 *   2. Reads every table (A, B or C), maps each trip column's calendar label to an exact rule (CALENDARS), each stop
 *      name to a reviewed coordinate in data/geocodes/es-busbam.json (src/generators/geocodes.ts) and builds one trip
 *      per column / row with explicit service dates in the build window. Stops named `(Solo Lunes|Viernes)` are called on that weekday only: the trip splits in two variants.
 *   3. One GTFS route per table and direction, route_short_name = the line code, route_url = the page; vans of the
 *      VAC lines are coaches (route_type 200), those of the VJA lines (rural Granada / Jaén / Almería) buses (3).
 *
 * KNOWN QUIRKS
 *   - Calendar words are not defined by the operator. Used here: DIARIO / LABORABLES Y FESTIVOS = every day;
 *     DE LUNES A SÁBADOS, DIARIO EXCEPTO FESTIVOS = Monday–Saturday except public holidays; bare LABORABLES / LABORALES
 *     = Monday–Friday except public holidays; DOMINGOS Y FESTIVOS / FESTIVOS = Sundays and public holidays. "Public
 *     holidays" are the national ones (1 Jan, 6 Jan, Good Friday, 1 May, 15 Aug, 12 Oct, 1 Nov, 6 Dec, 8 Dec, 25 Dec);
 *     regional and local holidays (28 Feb Andalucía, Holy Thursday, 9 Jun Murcia …) are NOT known, nor are shifts
 *     of a holiday that falls on a Sunday. Saturday service of Puebla de Don Fadrique (LABORABLES vs FESTIVOS only) is
 *     therefore not generated.
 *   - `NUEVO · DIRECTO` (Madrid ↔ Almería direct) runs every day but only in the "Válido del … al …" dates of the note
 *     under its table (02/11/2026–31/03/2027 now); trips are generated inside that range only.
 *   - Almería–Madrid "DIARIO 4": the first call `*16:15` Roquetas de Mar only runs on Easter Sunday and summer Sundays
 *     (no season dates given) – left out with a warning, the trip starts in Almería at 17:00.
 *   - Castril – Baza: `* HUESCAR Sólo para si lleva gente` – a request stop whose times (16:14 right before Santa Catalina
 *     16:15, 14 km away) cannot be right: left out with a warning.
 *   - Puebla de Don Fadrique – Baza: the footnotes (`*`, `**`) extend two trips to / from Granada without giving times –
 *     the trips are kept as printed (Puebla – Baza) with a warning.
 *   - Typos: a trip whose own times go backwards is left out with a warning (Úbeda – Granada, Granada 15:00 after
 *     Iznalloz 14:45 in the VUELTA column, 2026-10-26); more than 10 % of the trips (min. 3) failing this way means the
 *     layout was misread and fails the source.
 *   - Cartagena → Alicante, the second "DE LUNES A SÁBADOS" 13:30 column only lists Cartagena, La Palma and
 *     Torrepacheco (all other cells `---`): a 3-stop trip as printed.
 *   - Stop spellings differ between tables (RÍO / RIO DE BAZA, TORRE CARDELA / TORRECARDELA, PUERTO DE MAZARRÓN /
 *     PUERTO MAZARRÓN, ALMERÍA PUERTO / PUERTO ALMERÍA): the geocode file's keys ignore accents, case and punctuation,
 *     other spellings are `aliases` of an entry.
 *   - Coordinates: town centres from OSM (Nominatim), bus stations where one exists; entries with `approx` (source
 *     "estimate") are villages placed from the road order of the timetable (±3 km). Estaciones (E. DARRO …) are the
 *     old railway stations.
 *   - Timetable changes (times, added / removed trips and stops, whole new lines) need no change in this script; a
 *     removed stop just stays unused in the geocode file.
 *   - The pages carry no timetable year. Freshness is not checked beyond the validity dates of NUEVO · DIRECTO; the
 *     pages' `article:modified_time` is logged (2025-04-30 for almeria-jaen).
 *
 * FAILS ON PURPOSE (the build skips the feed) when
 *   - the index links no line page at all, or a linked page has no tables or no line code;
 *   - (not a failure) a stop in the timetable has no reviewed entry in data/geocodes/es-busbam.json (an entry looked up
 *     automatically but not yet reviewed counts as missing): the routes calling there are left out, the other routes
 *     are built, and the build report lists the stops (`needsGeocoding`) with the command to geocode them. Only when
 *     no route is left the source fails (NeedsGeocodingError). New stops are never guessed;
 *   - a table has an unknown layout / header, an unknown calendar label, a cell
 *     that is neither a time nor `---`, many trips with times that go backwards (other than past midnight), a `*` /
 *     marker without its known note, or `NUEVO · DIRECTO` without its validity note;
 *   - no trip runs in the build window (checked by the registry).
 *
 * HOW TO RE-CHECK / UPDATE
 *   - `pnpm --filter @etbm/etl run generate -- es-busbam` runs it against the live pages (one line per trip).
 *   - By hand: `curl -A Mozilla/5.0 https://www.busbam.com/horarios/almeria-madrid/`; diff the tables against the
 *     samples above. New stop → `pnpm --filter @etbm/etl run geocode -- es-busbam`, check, `--accept`; new calendar
 *     label → CALENDARS; new note → NOTES / EXCEPTION.
 *   - tests: test/busbam.test.ts with copies of the pages (their `<main>` part) in test/fixtures/busbam/.
 */

/** Line codes of the state concessions (VAC-…) are coach lines, the rest (VJA-… rural lines of Granada / Jaén) buses. */
export const routeTypeOf = (line: string) => (/^VAC\b/.test(line) ? 200 : 3);
export const pageUrl = (slug: string) => `${INDEX_URL}${slug}/`;

// ---------------------------------------------------------------------------------------------------- stops

export interface BusbamStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
}
const stopOfEntry = (e: GeocodeEntry): BusbamStop => ({ id: `bb-${geoKey(e.name).toLowerCase()}`, name: e.name, lat: e.lat, lon: e.lon });
/** Stands in for a stop without reviewed coordinates until the run ends (assertComplete then fails the source). */
const NO_STOP: BusbamStop = { id: "bb-unknown", name: "?", lat: 0, lon: 0 };

// ---------------------------------------------------------------------------------------------------- calendar

const HOLIDAYS_MD = ["01-01", "01-06", "05-01", "08-15", "10-12", "11-01", "12-06", "12-08", "12-25"];
function easter(year: number): string {
  // anonymous Gregorian algorithm
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
/** National public holidays of Spain (fixed dates + Good Friday); regional ones are not known (see KNOWN QUIRKS). */
export function isHoliday(iso: string): boolean {
  if (HOLIDAYS_MD.includes(iso.slice(5))) return true;
  return iso === shift(easter(Number(iso.slice(0, 4))), -2);
}
function shift(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

type DayTest = (iso: string) => boolean;
const ALL: DayTest = () => true;
const MON_SAT: DayTest = (d) => isoWeekday(d) < 6 && !isHoliday(d);
const MON_FRI: DayTest = (d) => isoWeekday(d) < 5 && !isHoliday(d);
const OFF: DayTest = (d) => isoWeekday(d) === 6 || isHoliday(d);

/** Calendar labels of the pages (normalised: no accents, upper case) → the days they stand for. */
export const CALENDARS: [RegExp, string, DayTest][] = [
  [/^DIARIO( \d)?$/, "every day", ALL],
  [/^DIARIO \(TODOS LOS DIAS\)$/, "every day", ALL],
  [/^LABORABLES Y FESTIVOS$/, "every day", ALL],
  [/^NUEVO\W*DIRECTO$/, "every day within the validity of the note", ALL],
  [/^DE LUNES A SABADOS$/, "Monday–Saturday, not holidays", MON_SAT],
  [/^LUNES A SABADOS LABORALES$/, "Monday–Saturday, not holidays", MON_SAT],
  [/^DIARIO EXCEPTO FESTIVOS$/, "Monday–Saturday, not holidays", MON_SAT],
  [/^LUNES A VIERNES LABORALES$/, "Monday–Friday, not holidays", MON_FRI],
  [/^LUNES A VIERNES LABORABLES$/, "Monday–Friday, not holidays", MON_FRI],
  [/^LABORALES$/, "Monday–Friday, not holidays", MON_FRI],
  [/^LABORABLES$/, "Monday–Friday, not holidays", MON_FRI],
  [/^DOMINGOS Y FESTIVOS$/, "Sundays and holidays", OFF],
  [/^FESTIVOS$/, "Sundays and holidays", OFF],
  [/^DIARIO EXCEPTO SABADOS$/, "every day except Saturday", (d) => isoWeekday(d) !== 5],
  [/^VIERNES$/, "Fridays", (d) => isoWeekday(d) === 4],
];

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();

interface Calendar {
  label: string;
  test: DayTest;
  /** validity (NUEVO · DIRECTO): service only inside */
  from?: string;
  to?: string;
}
function calendarOf(label: string, where: string): Calendar {
  const n = norm(label);
  for (const [re, , test] of CALENDARS) if (re.test(n)) return { label: n, test };
  throw new GeneratorError(`${where}: unknown calendar label "${label}" (add it to CALENDARS in es-busbam.ts)`);
}

/** Notes below the tables that the script knows (normalised texts); anything else with a marker fails. */
const NOTES: { marker: string; text: string; effect: string }[] = [
  { marker: "*", text: "* EL SERVICIO DE LAS 16:30 PUEBLA DE DON FABRIQUE DE LOS DOMINGOS Y FESTIVOS LLEGA HASTA GRANADA", effect: "the 16:30 Sunday / holiday trip continues to Granada without published times" },
  { marker: "**", text: "** EL SERVICIO DE LAS 17:00 BAZA-PUEBLA DE DON FADRIQUE SALE DESDE GRANADA A LAS 15:30 DE LUNES A VIERNES LABORABLES", effect: "the 17:00 weekday trip starts in Granada at 15:30 without published times" },
];
/** Castril – Baza: a stop served only on demand, its printed time contradicts its neighbours (14 km in 1 minute). */
const REQUEST_STOP = { id: "bb-huescar", text: "* HUESCAR SOLO PARA SI LLEVA GENTE" };
const EXCEPTION = "*EXCEPCION: EL HORARIO DIARIO 4 DE ROQUETAS DE MAR (16:15) SE REALIZA UNICAMENTE EL DOMINGO DE RESURRECCION Y LOS DOMINGOS DE LA TEMPORADA DE VERANO.";
const VALID_RE = /NUEVO SERVICIO DIRECTO DIARIO .*? VALIDO DEL (\d\d)\/(\d\d)\/(\d{4}) AL (\d\d)\/(\d\d)\/(\d{4})/;

// ---------------------------------------------------------------------------------------------------- HTML

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
const clean = (s: string) => decode(s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

export interface RawTable {
  id: string;
  title: string;
  head: string[][];
  body: string[][];
  /** Text below the table up to the next heading / table (table description, notes, PDF button). */
  after: string;
}
export interface Page {
  line: string;
  modified?: string;
  tables: RawTable[];
}

const rowsOf = (html: string) => [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => clean(c[1]!)));

/** Read the headings, the line code and the TablePress tables of a line page. */
export function parsePage(html: string, url: string): Page {
  const modified = /article:modified_time" content="([^"]+)"/.exec(html)?.[1];
  const main = /<main\b[\s\S]*<\/main>/.exec(html)?.[0] ?? html;
  const body = main.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "");
  let line = "";
  let title = "";
  const tables: RawTable[] = [];
  const re = /<h2\b[^>]*>([\s\S]*?)<\/h2>|<p\b[^>]*>([\s\S]*?)<\/p>|<table\b[^>]*\bid="tablepress-(\d+)"[^>]*>([\s\S]*?)<\/table>/g;
  let m: RegExpExecArray | null;
  let last: RawTable | undefined;
  let afterFrom = 0;
  const flushAfter = (to: number) => {
    if (last) last.after = clean(body.slice(afterFrom, to));
  };
  while ((m = re.exec(body))) {
    if (m[1] !== undefined) {
      flushAfter(m.index);
      last = undefined;
      title = clean(m[1]);
    } else if (m[2] !== undefined) {
      const t = clean(m[2]);
      const l = /^LÍNEA\s+(.+)$/.exec(t);
      if (l && !line) line = l[1]!.replace(/\b([A-Za-z]+)\s*[-–]?\s*(?=\d)/g, (_, a: string) => `${a.toUpperCase()}-`).replace(/\s+/g, " ");
    } else {
      flushAfter(m.index);
      const head = rowsOf(/<thead\b[^>]*>([\s\S]*?)<\/thead>/.exec(m[4]!)?.[1] ?? "");
      const bodyRows = rowsOf(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/.exec(m[4]!)?.[1] ?? "");
      last = { id: m[3]!, title, head, body: bodyRows, after: "" };
      tables.push(last);
      afterFrom = m.index + m[0].length;
    }
  }
  flushAfter(body.length);
  if (!line) throw new GeneratorError(`${url}: no "LÍNEA …" code on the page`);
  return { line, modified, tables };
}

/** The line pages the index links (slugs). */
export function parseIndex(html: string): string[] {
  return [...new Set([...html.matchAll(/href="https:\/\/www\.busbam\.com\/horarios\/([a-z0-9-]+)\/?"/g)].map((m) => m[1]!))];
}

// ---------------------------------------------------------------------------------------------------- trips

interface Call {
  stop: BusbamStop;
  t: number;
  /** stop is called on this weekday only (0 = Monday) */
  day?: number;
}
interface RawTrip {
  cal: Calendar;
  calls: Call[];
  /** where it comes from, for messages */
  where: string;
}
type Dir = { name: string; trips: RawTrip[] };

/** One trip whose own times do not add up (a typo in the source): that trip is left out with a warning. */
class BadTrip extends GeneratorError {}
interface Sink {
  geo: GeocodeStore;
  warn(m: string): void;
  /** trips left out so far; too many means the layout was misread, not a typo (buildFeed fails) */
  dropped: string[];
}
function addTrip(list: RawTrip[], entries: { stop: BusbamStop; day?: number; t: number }[], cal: Calendar, where: string, sink: Sink): void {
  if (!entries.length) return;
  try {
    list.push(makeTrip(entries, cal, where));
  } catch (e) {
    if (!(e instanceof BadTrip)) throw e;
    sink.dropped.push(e.message);
    sink.warn(`${e.message}: trip left out`);
  }
}

function stopOf(cell: string, where: string, sink: Sink): { stop: BusbamStop; day?: number } {
  const solo = /^(.*?)\s*\(Solo (Lunes|Viernes)\)$/i.exec(cell);
  const e = sink.geo.resolve(solo ? solo[1]! : cell, where);
  return { stop: e ? stopOfEntry(e) : NO_STOP, day: solo ? (/^lunes$/i.test(solo[2]!) ? 0 : 4) : undefined };
}

/** "6:15" → minutes, "---" / "--" / "" → null; anything else fails. A leading `*` is reported. */
function timeOf(cell: string, where: string): { t: number; star: boolean } | null {
  const c = cell.trim();
  if (c === "" || /^-{1,3}$/.test(c)) return null;
  const star = c.startsWith("*");
  const t = parseHm(star ? c.slice(1) : c);
  if (t === null) throw new GeneratorError(`${where}: unreadable time "${cell}"`);
  return { t, star };
}

/** Calls in travel order → trip, times past midnight continue (+24 h); other backward steps fail. */
function makeTrip(entries: { stop: BusbamStop; day?: number; t: number }[], cal: Calendar, where: string): RawTrip {
  const calls: Call[] = [];
  let prev = -1, add = 0;
  for (const e of entries) {
    let t = e.t + add;
    if (t < prev) {
      if (prev - t < 12 * 60) throw new BadTrip(`${where}: times go backwards at ${e.stop.name} (${[...entries].map((x) => x.stop.name).join(" → ")})`);
      add += 1440;
      t += 1440;
    }
    calls.push({ stop: e.stop, t, ...(e.day !== undefined ? { day: e.day } : {}) });
    prev = t;
  }
  return { cal, calls, where };
}

/** The validity range of "NUEVO · DIRECTO" columns from the note under the table. */
function validity(t: RawTable, where: string): { from: string; to: string } {
  const m = VALID_RE.exec(norm(t.after));
  if (!m) throw new GeneratorError(`${where}: "NUEVO · DIRECTO" column without its "Válido del … al …" note`);
  return { from: `${m[3]}-${m[2]}-${m[1]}`, to: `${m[6]}-${m[5]}-${m[4]}` };
}
function calendarFor(label: string, t: RawTable, where: string): Calendar {
  const cal = calendarOf(label, where);
  if (/^NUEVO/.test(cal.label)) Object.assign(cal, validity(t, where));
  return cal;
}

const isNo = (c: string) => c === "" || /^-{1,3}$/.test(c);

/** (A) stops down, a trip per column. */
function readStopsDown(t: RawTable, sink: Sink): Dir[] {
  const where0 = `table ${t.id} "${t.title}"`;
  const head = t.head[0]!;
  const trips: RawTrip[] = [];
  for (let c = 1; c < head.length; c++) {
    const where = `${where0}, column "${head[c]}"`;
    const cal = calendarFor(head[c]!, t, where);
    const entries: { stop: BusbamStop; day?: number; t: number }[] = [];
    for (const row of t.body) {
      if (row.length !== head.length) throw new GeneratorError(`${where0}: a row has ${row.length} cells, the header ${head.length}`);
      const tm = timeOf(row[c]!, where);
      if (!tm) continue;
      const { stop, day } = stopOf(row[0]!, where, sink);
      if (tm.star) {
        if (!norm(t.after).includes(EXCEPTION) || stop.id !== "bb-roquetasdemar" || cal.label !== "DIARIO 4") throw new GeneratorError(`${where}: unexplained "*" at ${row[0]}`);
        sink.warn(`${where0}: ${stop.name} ${row[c]} of "${head[c]}" runs only on Easter Sunday and summer Sundays (no dates published): call left out`);
        continue;
      }
      entries.push({ stop, day, t: tm.t });
    }
    addTrip(trips, entries, cal, where, sink);
  }
  return [{ name: t.title, trips }];
}

/** (B) both directions side by side; IDA runs down the table, VUELTA up. */
function readSideBySide(t: RawTable, k: number, sink: Sink): Dir[] {
  const where0 = `table ${t.id} "${t.title}"`;
  const head = t.head[0]!;
  const sub = t.head[1];
  for (const a of [k - 1, k + 1]) if (!/^[↓↑]?$/.test(head[a]!)) throw new GeneratorError(`${where0}: unexpected column next to ITINERARIO`);
  const labelOf = (c: number, dirRe: RegExp) => {
    const h = head[c]!;
    if (!dirRe.test(h)) throw new GeneratorError(`${where0}: column ${c} is "${h}", expected ${dirRe}`);
    const rest = h.replace(/^(IDA|VUELTA)\s*\([^)]*\)/i, "").trim();
    return rest || sub?.[c] || "";
  };
  const stopRows = t.body.filter((r) => r[k] !== "");
  // marker row: cells below the itinerary without a stop name
  for (const r of t.body.filter((r) => r[k] === "")) {
    r.forEach((cell, c) => {
      if (c === k - 1 || c === k + 1 || !cell) return;
      const note = NOTES.find((n) => n.marker === cell);
      if (!note || !norm(t.after).includes(note.text)) throw new GeneratorError(`${where0}: unknown marker "${cell}" or its note changed`);
      sink.warn(`${where0}: note ${cell}: ${note.effect} – kept as printed`);
    });
  }
  const dirs: Dir[] = [
    { name: "", trips: [] },
    { name: "", trips: [] },
  ];
  const itin = stopRows.map((r) => r[k]!);
  const nameOf = (i: number) => stopOf(itin[i]!, where0, sink).stop.name;
  dirs[0]!.name = `${nameOf(0)} – ${nameOf(itin.length - 1)}`;
  dirs[1]!.name = `${nameOf(itin.length - 1)} – ${nameOf(0)}`;
  let requestWarned = false;
  const cols = [
    { dir: 0, from: 0, to: k - 2, re: /^IDA\b/i, rows: stopRows },
    { dir: 1, from: k + 2, to: head.length - 1, re: /^VUELTA\b/i, rows: [...stopRows].reverse() },
  ];
  for (const g of cols) {
    for (let c = g.from; c <= g.to; c++) {
      const where = `${where0}, column ${c + 1} "${head[c]}"`;
      const cal = calendarFor(labelOf(c, g.re), t, where);
      const entries: { stop: BusbamStop; day?: number; t: number }[] = [];
      for (const row of g.rows) {
        const tm = timeOf(row[c]!, where);
        if (!tm) continue;
        if (tm.star) throw new GeneratorError(`${where}: unexplained "*" at ${row[k]}`);
        const { stop, day } = stopOf(row[k]!, where, sink);
        if (stop.id === REQUEST_STOP.id && norm(t.after).includes(REQUEST_STOP.text)) {
          if (!requestWarned) sink.warn(`${where0}: ${stop.name} is a request stop ("sólo si lleva gente") with times that contradict its neighbours: left out`);
          requestWarned = true;
          continue;
        }
        entries.push({ stop, day, t: tm.t });
      }
      addTrip(dirs[g.dir]!.trips, entries, cal, where, sink);
    }
  }
  return dirs;
}

/** (C) a trip per row, the stops across. */
function readTripRows(t: RawTable, sink: Sink): Dir[] {
  const where0 = `table ${t.id} "${t.title}"`;
  const stops = t.head[1]!.slice(1);
  if (!t.head[0]!.slice(1).every((c) => c === "→") || t.head[0]!.length !== t.head[1]!.length) throw new GeneratorError(`${where0}: header changed (expected → arrows over the stops)`);
  const trips: RawTrip[] = [];
  for (const row of t.body) {
    const where = `${where0}, row "${row[0]}"`;
    if (row.length !== stops.length + 1) throw new GeneratorError(`${where}: ${row.length} cells for ${stops.length + 1} columns`);
    const cal = calendarFor(row[0]!, t, where);
    const entries: { stop: BusbamStop; day?: number; t: number }[] = [];
    stops.forEach((s, i) => {
      const tm = timeOf(row[i + 1]!, where);
      if (!tm) return;
      if (tm.star) throw new GeneratorError(`${where}: unexplained "*"`);
      entries.push({ ...stopOf(s, where, sink), t: tm.t });
    });
    addTrip(trips, entries, cal, where, sink);
  }
  return [{ name: t.title, trips }];
}

/** Read one table into its direction(s) of trips. */
export function readTable(t: RawTable, sink: Sink): Dir[] {
  const where = `table ${t.id} "${t.title}"`;
  if (!t.head.length || !t.body.length) throw new GeneratorError(`${where}: no header or no rows`);
  const h0 = t.head[0]!;
  if (norm(h0[0]!) === "ITINERARIO") return readStopsDown(t, sink);
  const k = h0.findIndex((c) => norm(c) === "ITINERARIO");
  if (k > 0 && k < h0.length - 1) return readSideBySide(t, k, sink);
  if (h0[0] === "" && t.head.length === 2 && h0.length > 2 && h0.slice(1).every((c) => c === "→")) return readTripRows(t, sink);
  throw new GeneratorError(`${where}: unknown table layout (header ${JSON.stringify(h0)})`);
}

// ---------------------------------------------------------------------------------------------------- feed

export interface FetchedPage {
  slug: string;
  page: Page;
}

/**
 * The feed of the pages. A route (one direction of a table) that calls at a stop without reviewed coordinates is left
 * out as a whole and named in `dropped`; the other routes are built.
 */
export function buildFeed(pages: FetchedPage[], startDate: string, days: number, warn: (m: string) => void, geo: GeocodeStore, dropped: string[] = []): GtfsFeed {
  const sink: Sink = { geo, warn, dropped: [] };
  const { from, to } = serviceWindow(startDate, days);
  const window = dateRange(from, to);
  const stops = new Map<string, GtfsStop>();
  const routes: GtfsRoute[] = [];
  const trips: GtfsTrip[] = [];
  const stopTimes: GtfsStopTime[] = [];
  const services = new Map<string, string[]>();
  const usedRoutes = new Set<string>();

  for (const { slug, page } of pages) {
    if (!page.tables.length) throw new GeneratorError(`${pageUrl(slug)}: no timetable tables on a page the index links`);
    for (const table of page.tables) {
      const dirs = readTable(table, sink);
      dirs.forEach((dir, di) => {
        if (!dir.trips.length) return;
        if (dir.trips.some((t) => t.calls.some((c) => c.stop === NO_STOP))) {
          dropped.push(`${page.line} ${dir.name.replace(/\s+-\s+/g, " – ")} (${slug}, table ${table.id})`);
          return;
        }
        const baseId = `${slug}-${table.id}${dirs.length > 1 ? (di ? "-v" : "-i") : ""}`;
        let routeId = baseId;
        for (let n = 2; usedRoutes.has(routeId); n++) routeId = `${baseId}-${n}`;
        usedRoutes.add(routeId);
        routes.push({
          route_id: routeId,
          agency_id: "busbam",
          route_short_name: page.line,
          route_long_name: dir.name.replace(/\s+-\s+/g, " – "),
          route_type: routeTypeOf(page.line),
          route_url: pageUrl(slug),
        });
        dir.trips.forEach((trip, ti) => {
          const dates = window.filter((d) => trip.cal.test(d) && (!trip.cal.from || d >= trip.cal.from) && (!trip.cal.to || d <= trip.cal.to));
          if (!dates.length) return;
          // a stop with "(Solo <weekday>)" is called on that weekday only: one variant per combination
          const variants = new Map<string, { calls: Call[]; dates: string[] }>();
          for (const d of dates) {
            const calls = trip.calls.filter((c) => c.day === undefined || c.day === isoWeekday(d));
            const key = calls.map((c) => c.stop.id).join("|");
            const v = variants.get(key) ?? { calls, dates: [] };
            v.dates.push(d);
            variants.set(key, v);
          }
          let vi = 0;
          for (const v of variants.values()) {
            if (v.calls.length < 2) continue;
            const id = `${routeId}-${ti + 1}${variants.size > 1 ? String.fromCharCode(97 + vi++) : ""}`;
            const last = v.calls[v.calls.length - 1]!;
            services.set(id, v.dates);
            trips.push({ route_id: routeId, service_id: id, trip_id: id, trip_headsign: last.stop.name });
            v.calls.forEach((c, i) => {
              if (!stops.has(c.stop.id)) stops.set(c.stop.id, { stop_id: c.stop.id, stop_name: c.stop.name, stop_lat: c.stop.lat, stop_lon: c.stop.lon, stop_timezone: "Europe/Madrid" });
              stopTimes.push({ trip_id: id, stop_sequence: i + 1, stop_id: c.stop.id, arr: c.t, dep: c.t });
            });
          }
        });
      });
    }
  }
  if (sink.dropped.length > Math.max(2, trips.length / 10)) throw new GeneratorError(`${sink.dropped.length} of ${trips.length + sink.dropped.length} trips have times that go backwards – the tables were misread: ${sink.dropped[0]}`);
  return {
    agency: [{ agency_id: "busbam", agency_name: "BusBam", agency_url: "https://www.busbam.com/", agency_timezone: "Europe/Madrid", agency_lang: "es" }],
    stops: [...stops.values()],
    routes: routes.filter((r) => trips.some((t) => t.route_id === r.route_id)),
    trips,
    stopTimes,
    services,
    info: { publisher: "EuroTrainBusMap (generated from the operator's timetable pages)", publisherUrl: INDEX_URL, lang: "es", sourceUrl: INDEX_URL },
  };
}

/** What identifies a page's timetable: its tables and the notes below them, nothing else of the page. */
export const contentOf = (page: Page) => page.tables.map((t) => [t.title, ...t.head.map((r) => r.join("|")), ...t.body.map((r) => r.join("|")), t.after].join("\n")).join("\n\n");

export default defineGenerator({
  id: "es-busbam",
  description: "BusBam (Almería) coach and bus lines: the index of busbam.com/horarios links one page per line group; every linked page is parsed the same way (TablePress timetables become trips with explicit dates), stops are located from data/geocodes/es-busbam.json.",
  sourceUrl: INDEX_URL,
  async generate(ctx) {
    const geo = await GeocodeStore.load("es-busbam");
    const slugs = parseIndex(await ctx.fetchText(INDEX_URL, { expect: /horarios/ }));
    if (!slugs.length) throw new GeneratorError(`the index ${INDEX_URL} links no line pages any more (the link pattern /horarios/<line>/ changed)`);
    // two at a time: polite, and the site answers in ~1 s
    const pages = await mapLimit(slugs, 2, async (slug): Promise<FetchedPage> => {
      const url = pageUrl(slug);
      const page = parsePage(await ctx.fetchText(url, { expect: /<\/table>/ }), url);
      const ob = ctx.observe(slug, contentOf(page));
      ctx.log(`${slug}: line ${page.line}, ${page.tables.length} tables${ob.isNew ? " (new page)" : ob.changed ? ` (timetable changed, previous version since ${ob.lastChanged})` : ""}${page.modified ? `, page modified ${page.modified.slice(0, 10)}` : ""}`);
      return { slug, page };
    });
    for (const gone of ctx.knownPages().filter((k) => !slugs.includes(k))) ctx.warn(`page /horarios/${gone}/ is not linked any more: its lines are no longer offered`);
    const dropped: string[] = [];
    const feed = buildFeed(pages, ctx.startDate, ctx.days, ctx.warn, geo, dropped);
    geo.finish(ctx, dropped, feed.routes.length); // names the stops to geocode; fails only when no route is left
    const approx = feed.stops.filter((s) => geo.lookup(s.stop_name)?.approx);
    if (approx.length) ctx.log(`${approx.length} stops with estimated coordinates: ${approx.map((s) => s.stop_name).join(", ")}`);
    return feed;
  },
});
