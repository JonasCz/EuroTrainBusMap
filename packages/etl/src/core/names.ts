/** Remove diacritics and lowercase. Handles a few letters NFKD does not decompose. */
export function fold(s: string): string {
  return s
    .replace(/ß/g, "ss")
    .replace(/[łŁ]/g, "l")
    .replace(/[øØ]/g, "o")
    .replace(/[đĐ]/g, "d")
    .replace(/[ıİ]/g, "i")
    .replace(/[æÆ]/g, "ae")
    .replace(/[œŒ]/g, "oe")
    .replace(/[þÞ]/g, "th")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Words removed when comparing station names (after folding). */
const NOISE = [
  "hauptbahnhof", "hbf", "bahnhof", "bhf", "bf", "station", "stn", "gare", "sncf", "stazione", "estacion",
  "estacio", "dworzec", "glowny", "gl", "nadrazi", "hl n", "hl.n", "hlavni", "hlavna", "stanica", "pu", "palyaudvar", "pályaudvar",
  "railway", "rail", "train", "trains", "bus", "busbahnhof", "zob", "bussteig", "steig", "gleis", "platform",
  "plateforme", "quai", "voie", "binario", "peron", "tor", "spoor", "perron", "bay", "stand", "stance",
  "centraal", "central", "centrale", "centrum", "zentrum", "centre", "center", "busstation", "autobusove",
  "autobusowy", "autobusni", "autostazione", "estacion de autobuses", "coach", "terminal", "terminus",
  "bahnhofplatz", "bahnhofsplatz", "bahnhofstrasse", "vorplatz", "stop", "halt", "haltestelle", "bstg", "rv", "fv",
  "street", "road", "ul", "str",
  "kolodvor", "autogara", "otogar", "rodoviaria", "autobuska", "busstasjon", "bussterminal", "bussterminalen", "busstation", "omnibusbahnhof", "autostanice", "dworzec",
];
const NOISE_EXACT_WORDS = new Set(NOISE.filter((w) => !w.includes(" ")));

/**
 * Normalize a stop name for similarity comparison: fold diacritics, drop
 * parenthesised parts, platform numbers and generic words.
 * The city prefix is kept (callers strip it if needed).
 */
export function normalizeStopName(name: string): string {
  let s = fold(name);
  s = s.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
  // "Gleis 3", "Bstg. 2", "platform 4a", "Steig A"
  s = s.replace(/\b(gleis|gl|bussteig|bstg|steig|platform|plateforme|quai|voie|binario|peron|spoor|perron|bay|stand|stance|track|tor)\.?\s*[0-9a-z]{0,3}\b/g, " ");
  s = s.replace(/[^a-z0-9]+/g, " ");
  const words = s.split(" ").filter((w) => w && !NOISE_EXACT_WORDS.has(w) && !/^\d{1,2}[a-z]?$/.test(w));
  return words.join(" ").trim();
}

/** Tokens of a normalized name. */
function tokens(n: string): string[] {
  return n.split(" ").filter(Boolean);
}

/**
 * Similarity of two stop names in [0,1]: 1 if normalized names are equal or
 * one contains the other as whole tokens; otherwise token Jaccard.
 */
export function nameSimilarity(a: string, b: string): number {
  return normSimilarity(normalizeStopName(a), normalizeStopName(b));
}

/** nameSimilarity of two already normalised names (see normalizeStopName). */
export function normSimilarity(na: string, nb: string): number {
  if (!na || !nb) return na === nb ? 1 : 0.5; // both generic ("Hbf") → neutral
  if (na === nb) return 1;
  const ta = tokens(na), tb = tokens(nb);
  const sa = new Set(ta), sb = new Set(tb);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  if (inter === sa.size || inter === sb.size) {
    // containment; a lone token (the town name: "Eschwege" ⊂ "Eschwege Post") is only weak evidence
    const [small, big] = inter === sa.size ? [sa, sb] : [sb, sa];
    return small.size === 1 && [...big].some((t) => !small.has(t) && t.length >= 4) ? 0.55 : 0.9;
  }
  // compact compare ignores spacing differences ("Frankfurt(Main)Hbf" vs "Frankfurt Main Hbf")
  if (ta.join("") === tb.join("")) return 1;
  return inter / (sa.size + sb.size - inter);
}

/** Platform / track / stand / bay words in common European languages (matched case-insensitively). */
const PLATFORM_WORDS =
  "platforms?|plat|gleis(?:e)?|gl|bahnsteig(?:e)?|bussteig(?:e)?|bstg|steig|quai|quais|voie|voies|binario|binari|" +
  "andén|anden|plataforma|peron|perron|spoor|perrong|nástupiště|nastupiste|stanowisko|" +
  "track|tracks|bay|bays|stand|stands|stance|stop|stops|spår|raide|vágány|vagany|kolej";
/** A designator: 1-3 digits with optional letter, or a single letter; ranges/lists allowed. */
const DESIG = "(?:[0-9]{1,3}[a-z]?|[a-z])";
const DESIG_LIST = `${DESIG}(?:\\s*(?:[-–/,&+]|and|und|et)\\s*${DESIG})*`;
/** Between the word and its designator: "Platform 6", "Plat.6", "Stop A" (a letter needs a space or dot, so "Baya" stays). */
const SEP = "(?:\\.\\s*|\\s+|(?=[0-9]))";
const QUAL = `(?:${PLATFORM_WORDS})${SEP}${DESIG_LIST}`;
/** Inside brackets longer codes are safe too: "(Stop BW)", "(Platform WD)", "(Stop MS22)", "(Platform 45011680)". */
const DESIG_PAREN = "(?:[a-z]{1,3}[0-9]{0,3}|[0-9]{1,9}[a-z]{0,2})";
const PAREN_PLATFORM = new RegExp(`\\s*[(\\[]\\s*(?:${PLATFORM_WORDS})${SEP}${DESIG_PAREN}(?:\\s*(?:[-–/,&+]|and|und|et)\\s*${DESIG_PAREN})*\\s*[)\\]]`, "giu");
const TRAIL_PLATFORM = new RegExp(`[\\s,;:\\-–]+${QUAL}\\s*$`, "iu");
const LEAD_PLATFORM = new RegExp(`^${QUAL}\\s*[,:\\-–]\\s*`, "iu");

/**
 * Strip platform / track / stand / bay qualifiers from a stop name:
 * "Paddington (Platform 6)" → "Paddington", "Wien Hbf Bahnsteig 3-4" → "Wien Hbf", "Gleis 5, Köln Hbf" → "Köln Hbf".
 * Names are only changed if something meaningful (≥ 2 characters) remains.
 */
export function stripPlatform(name: string): string {
  let n = name.trim();
  for (let i = 0; i < 3; i++) {
    const before = n;
    for (const re of [PAREN_PLATFORM, TRAIL_PLATFORM, LEAD_PLATFORM]) {
      const t = n.replace(re, "").trim();
      if (t.replace(/[^\p{L}\p{N}]/gu, "").length >= 2) n = t;
    }
    if (n === before) break;
  }
  return n.replace(/\s+/g, " ").replace(/[\s,;:\-–]+$/, "");
}

/** Heuristic score for choosing a station display name (lower = better). */
export function nameQuality(name: string, isRail: boolean): number {
  let q = name.length;
  if (!isRail) q += 40;
  if (/\(|\)|,/.test(name)) q += 15;
  if (/\b(gleis|bussteig|steig|bstg|platform|quai|voie|binario|bay|stand)\b/i.test(name)) q += 30;
  if (/^[A-Z0-9 ]+$/.test(name) && name.length > 4) q += 10; // ALL CAPS
  return q;
}

/** Title-case ALL-CAPS names ("LONDON KINGS CROSS" → "London Kings Cross"). */
export function prettifyName(name: string): string {
  const n = name.trim().replace(/\s+/g, " ");
  if (n.length > 3 && n === n.toUpperCase() && /[A-Z]/.test(n)) {
    return n.toLowerCase().replace(/(^|[\s\-/(.'])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase());
  }
  return n;
}

/**
 * Names that refer to a bus / coach terminal (not to a rail station) in the main European
 * languages: "ZOB", "Busbahnhof", "gare routière", "Coach Station", "autobusni kolodvor", "Autogara", "Otogar", …
 */
const TERMINAL_RE = new RegExp(
  "(?:^|[^\\p{L}])(" +
    [
      "zob", "busbahnhof", "omnibusbahnhof", "busterminal", "bus terminal", "bus station", "busstation", "bussterminal", "bussterminalen", "busstasjon", "bus stasjon",
      "coach station", "coach terminal", "coach park", "gare routi[eè]re", "gare des bus", "autobusov[eé]\\s+n[aá]dra[zž][ií]", "autobusov[eé]\\s+stanice", "autobusna\\s+stanica", "autobusni\\s+kolodvor",
      "autobuska\\s+stanica", "autobuski\\s+kolodvor", "autogara", "autostazione", "stazione\\s+autolinee", "stazione\\s+bus", "estaci[oó]n\\s+de\\s+autobuses", "estaci[oó]\\s+d.autobusos",
      "terminal\\s+rodovi[aá]ria", "rodovi[aá]ria", "dworzec\\s+autobusowy", "dworzec\\s+pks", "autobusov[eé]\\s+n[aá]stupi[šs]t[eě]", "otogar", "autobus\\s+station", "busstation",
      "autobuszállomás", "autóbusz-?(?:állomás|pályaudvar)", "autobusu\\s+stacija", "autobusu\\s+osta", "bussijaam", "linja-autoasema", "busstationen", "rutebilstasjon", "rutebilstation",
    ].join("|") +
    ")(?![\\p{L}])",
  "iu",
);
export function isTerminalName(name: string): boolean {
  return TERMINAL_RE.test(name);
}

/**
 * Display-safe station name: removes raw ids and prefixes some feeds leave in stop names
 * ("ROMA | Anagnina (Metro A) # f3583" → "Roma Anagnina (Metro A)"), HTML entities and control characters.
 */
export function sanitizeName(name: string): string {
  let n = name
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'");
  // trailing technical id: " # f3583", " #1234", " [id 123]"
  const id = /\s+#\s*(?=[0-9a-f]*\d)[0-9a-f]{3,}\s*$/i.exec(n);
  if (id && !/\b(gleis|platform|bay|stand|track|stop|quai|voie|bahnsteig|steig|line|linie|nr|no)\.?\s*$/i.test(n.slice(0, id.index))) n = n.slice(0, id.index);
  n = n.replace(/\s*[([]\s*id\s*[:=]?\s*\w+\s*[)\]]\s*$/i, "");
  // "CITY | Stop" → "City Stop" (an ALL-CAPS prefix is title-cased)
  const m = /^([^|]{2,40}?)\s*\|\s*(.{2,})$/u.exec(n);
  if (m) n = `${prettifyName(m[1]!)} ${m[2]!}`;
  n = n.replace(/\s*\|\s*/g, " - ").replace(/\s+/g, " ").trim();
  return n || name.trim();
}
