import { Cat, Flag } from "@etbm/shared";
import type { FeedOptions, ModeClass } from "../feeds.ts";

export interface RouteInfo {
  routeType: number;
  agency: string;
  shortName: string;
  longName: string;
  desc: string;
  /** Alphabetic prefix of trip_short_name, e.g. "REX" from "REX 1234". */
  tripPrefix: string;
}

export interface Classification {
  cls: ModeClass;
  /** Category; null = ambiguous rail, decide per trip with the distance heuristic. */
  cat: number | null;
  flags: number;
}

export interface ClassifyContext {
  keep: ModeClass[];
  opts: FeedOptions;
  country: string;
  coachRe: RegExp;
  urbanRe: RegExp | null;
}

// Train category tokens (case-insensitive unless noted).
const LD_TOKENS = new Set(
  [
    "ice", "ic", "ec", "oui", "ogo", "lyr", "ece", "en", "nj", "ej", "rj", "rjx", "tgv", "inoui", "ouigo", "est", "eurostar", "thalys", "tha",
    "ave", "avlo", "alvia", "av", "avant", "euromed", "iryo", "fr", "fa", "fb", "ita", "italo", "frecciarossa", "frecciargento",
    "frecciabianca", "icn", "ir", "yht", "eic", "eip", "tlk", "ex", "exp", "express", "sc", "le", "d", "flx", "flixtrain",
    "intercity", "eurocity", "eurocity-express", "nightjet", "euronight", "railjet", "ics", "icd", "es",
    "x2000", "sj", "snabbtag", "snabbtåg", "icl", "pendolino", "westbahn", "wb", "rjc", "mtx", "ic-bus",
    "intercites", "intercités", "ter-ic", "lyria", "ecm", "icm", "iry", "ic2",
    "regiojet", "leo", "arenaways", "lumo", "ecr", "fernverkehr",
    "icp", "ice-l",
  ].map((s) => s.toLowerCase()),
);
const LD_CASE_SENSITIVE = new Set(["rj", "RJ", "RJX"]); // regiojet "rj" (CZ) and railjet "RJ" are both long distance
const REG_TOKENS = new Set(
  [
    "re", "rb", "ire", "s", "ter", "r", "rx", "os", "sp", "mex", "rex", "cjx", "regio", "rs", "rer", "tl", "tlx", "er", "rr",
    "tt", "trn", "cre", "skm", "km", "kd", "lka", "ska", "pr", "reg", "regional", "regionalzug", "regionalexpress", "regionalbahn", "sbahn",
    "s-bahn", "sprinter", "stoptrein", "sneltrein", "local", "l", "lt", "trn", "rgt", "slp", "p", "ag", "erx", "brb", "alx",
    "vias", "nwb", "mrb", "rbx", "rt", "rex", "cjx", "atb", "rv", "rf", "rg", "ir-reg", "ter200", "transilien", "train-ter",
    "rgx", "kml", "ks", "osobni", "hex", "fex", "rpx", "cityjet", "pe",
    "regionale", "suburbano", "cercanias", "cercanías", "c", "md", "rodalies", "elron",
  ].map((s) => s.toLowerCase()),
);
const NIGHT_TOKENS = new Set(["nj", "en", "ej", "nightjet", "euronight", "sleeper", "cn"]);
const NIGHT_RE = /\b(nightjet|night\s*train|nachtzug|sleeper|euronight|intercit[eé]s de nuit|nattåg|natttog|nocny|nočný|nočni|lehátkový|cuccette|tren hotel|european sleeper|snälltåget.*natt|caledonian sleeper|night riviera)\b/i;

/** Operators whose rail services are long distance whatever the route_type. */
const LD_OPERATORS = /\b(lner|avanti|crosscountry|cross country|grand central|hull trains|lumo|transpennine|caledonian sleeper|eurostar|thalys|ouigo|italo|iryo|westbahn|regiojet|leo express|flixtrain|european sleeper|nightjet|snälltåget|sj\b|vy tog.*fjern|ns international|ic\b|intercity|pkp intercity|db fernverkehr|öbb.*fern|renfe viajeros.*ave|ave\b|trenitalia france|tgv|alstom)\b/i;
const REG_OPERATORS = /\b(northern|southern|southeastern|thameslink|great northern|c2c|merseyrail|london overground|elizabeth line|island line|scotrail|transport for wales|tfw rail|west midlands|london northwestern|chiltern|greater anglia|south western|gwr|emr|heathrow express|gatwick express|stansted express|s-bahn|regionalverkehr|regio\b|transilien|ter\b|koleje|przewozy regionalne|polregio|skm|elron|pågatåg|øresundståg|go-ahead)\b/i;

/** Rail-replacement / special buses we never want. */
const REPLACEMENT_RE = /(\bsev\b|schienenersatz|ersatzverkehr|\bev\d*\b|rail replacement|replacement bus|bus replacement|treinvervangend|\bnáhradní|\bnahradna|\bzka\b|zastępcza|bus de substitution|bus sostitutivo|autobus sostitutivo|substitution|ersatzbus|\bsv\s?\d)/i;

export function tokenOf(s: string): string {
  const m = /^\s*([A-Za-zÀ-ž][A-Za-zÀ-ž\-]{0,15})/.exec(s);
  return m ? m[1]! : "";
}

function catFromToken(tok: string): number | null {
  if (!tok) return null;
  if (LD_CASE_SENSITIVE.has(tok)) return Cat.LongDistance;
  const t = tok.toLowerCase();
  if (LD_TOKENS.has(t)) return Cat.LongDistance;
  if (REG_TOKENS.has(t)) return Cat.Regional;
  return null;
}

/** Mode class from (extended) GTFS route_type; null = excluded mode. */
export function modeOfRouteType(t: number): ModeClass | null {
  if (t === 2 || (t >= 100 && t <= 117)) return t === 108 || t === 110 || t === 111 || t === 112 || t === 114 || t === 115 ? null : "rail";
  // 108 rail shuttle (within complex), 110 replacement rail, 111 special, 112 lorry transport, 114 all rail, 115 cross-country rail?
  if (t === 3) return "bus";
  if (t >= 200 && t <= 209) return "coach";
  if (t >= 700 && t <= 716) {
    // 706 special needs, 707? 710 sightseeing, 711 shuttle, 712 school, 714 rail replacement, 715/716 demand responsive
    if ([706, 707, 710, 711, 712, 714, 715, 716].includes(t)) return null;
    return "bus";
  }
  return null; // tram, metro, ferry, cable car, funicular, trolleybus (11), monorail (12), air, taxi…
}

/**
 * Classify a route (optionally per trip-name prefix).
 * Returns null if the route should be dropped.
 */
export function classifyRoute(r: RouteInfo, ctx: ClassifyContext): Classification | null {
  let mode = modeOfRouteType(r.routeType);
  if (!mode) return null;
  const allNames = `${r.shortName} ${r.longName} ${r.desc}`;
  const { opts } = ctx;

  if (mode !== "rail") {
    if (REPLACEMENT_RE.test(allNames) || REPLACEMENT_RE.test(r.tripPrefix)) return null;
    const coachByName = ctx.coachRe.test(r.agency) || ctx.coachRe.test(allNames);
    if (mode === "coach") {
      if (r.routeType === 204 || r.routeType === 208 || r.routeType === 209 || opts.coachTypesAsBus) mode = coachByName ? "coach" : "bus";
    } else if (coachByName || opts.allCoach) mode = "coach";
    if (mode === "bus" && ctx.urbanRe && ctx.urbanRe.test(r.agency)) return null;
  }
  if (opts.allCoach && mode !== "rail") mode = "coach";
  if (!ctx.keep.includes(mode)) return null;

  if (mode === "coach") return { cls: "coach", cat: Cat.Coach, flags: 0 };
  if (mode === "bus") return { cls: "bus", cat: Cat.Bus, flags: opts.dticket && ctx.country === "DE" ? Flag.DTicket : 0 };

  // ---- rail ----
  let flags = 0;
  const tokTrip = r.tripPrefix;
  const tokShort = tokenOf(r.shortName);
  const tokDesc = tokenOf(r.desc);
  const tokLong = tokenOf(r.longName);
  const tokens = [tokTrip, tokShort, tokDesc, tokLong];
  if (
    r.routeType === 105 ||
    opts.night ||
    tokens.some((t) => t && NIGHT_TOKENS.has(t.toLowerCase())) ||
    NIGHT_RE.test(allNames) ||
    NIGHT_RE.test(r.agency)
  )
    flags |= Flag.Night;

  let cat: number | null = null;
  if (opts.railCat) cat = Cat[opts.railCat];
  else if (flags & Flag.Night) cat = Cat.LongDistance;
  else if ([101, 102, 103, 105].includes(r.routeType)) cat = Cat.LongDistance;
  else if ([106, 107, 109, 116, 117].includes(r.routeType)) cat = Cat.Regional;
  if (cat == null) {
    for (const t of tokens) {
      const c = catFromToken(t);
      if (c != null) {
        cat = c;
        break;
      }
    }
  }
  if (cat == null) {
    // Whole-word scan of names (e.g. NL "Stoptrein RS21", "Intercity direct").
    const words = allNames.split(/[\s/,;:()]+/).filter(Boolean);
    for (const w of words) {
      const c = catFromToken(w);
      if (c != null && w.length >= 2) {
        cat = c;
        break;
      }
    }
  }
  if (cat == null) {
    if (REG_OPERATORS.test(r.agency) || REG_OPERATORS.test(allNames)) cat = Cat.Regional;
    else if (LD_OPERATORS.test(r.agency) || LD_OPERATORS.test(allNames)) cat = Cat.LongDistance;
  }
  // Mixed operators (GWR, EMR, ScotRail…) are left ambiguous when only matched by operator name in GB.
  if (cat === Cat.Regional && ctx.country === "GB" && /\b(gwr|emr|scotrail|transport for wales|tfw)\b/i.test(r.agency + " " + allNames)) cat = null;

  if (cat == null && opts.railCatDefault) cat = Cat[opts.railCatDefault];
  if (cat === Cat.Regional && opts.dticket && ctx.country === "DE") flags |= Flag.DTicket;
  return { cls: "rail", cat, flags };
}

/**
 * Per-trip fallback for ambiguous rail: long distance if the trip covers a
 * long straight-line distance with sparse stops.
 */
export function heuristicRailCat(spanKm: number, nStops: number, durationMin: number): number {
  if (spanKm >= 100 && spanKm / Math.max(1, nStops - 1) >= 18) return Cat.LongDistance;
  if (spanKm >= 250 && durationMin >= 150) return Cat.LongDistance;
  return Cat.Regional;
}

/**
 * Display name and number for a trip.
 *  - route "ICE 597" (train number as route) → name "ICE", number "597"
 *  - trip_short_name "REX 1234" with route "A-1" → name "REX", number "REX 1234"
 */
export function displayName(
  shortName: string,
  longName: string,
  tripShortName: string,
  agency: string,
): { name: string; number?: string } {
  const sn = shortName.trim(), ln = longName.trim(), tsn = tripShortName.trim();
  const tp = /^([A-Za-zÀ-ž]{1,6})\s*\d/.exec(tsn)?.[1];
  const split = /^([A-Za-zÀ-ž]{1,6})\s?(\d{3,6})$/.exec(sn);
  if (tp) {
    if (sn && sn.toLowerCase().startsWith(tp.toLowerCase()) && !/\d{3,}/.test(sn)) return { name: sn, number: tsn };
    return { name: tp, number: tsn };
  }
  if (split && !tsn) return { name: split[1]!, number: split[2]! };
  const name = sn || ln || agency || "?";
  return tsn ? { name, number: tsn } : { name };
}
