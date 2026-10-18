import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  /** Operator adapters for this route (operators/registry.ts FeedOperators.classifyHooks). */
  hooks?: RouteHooks;
}

/** Operator-adapter hooks around the generic rules (see operators/types.ts ClassifyHooks). */
export interface RouteHooks {
  /** Before the generic rules: force the mode class and add flags. */
  before?(r: RouteInfo, mode: ModeClass): { mode?: ModeClass; flags?: number } | undefined;
  /** After the generic rules (before railCatDefault): a new classification, null = drop, undefined = keep. */
  after?(r: RouteInfo, cl: Classification): Classification | null | undefined;
}

/** A keyword pattern of data/classify-keywords.json: {words} = \b(a|b|…)\b, {any} = (a|b|…), {regex} = as written. */
interface KeywordPattern {
  words?: string[];
  any?: string[];
  regex?: string;
  flags?: string;
}
interface Keywords {
  trainCategories: { longDistance: string[]; longDistanceCaseSensitive: string[]; regional: string[]; night: string[] };
  roadTripCategories: { list: string[] };
  nightNames: KeywordPattern;
  longDistanceOperators: KeywordPattern;
  regionalOperators: KeywordPattern;
  replacementNames: KeywordPattern;
  replacementNamesCaseSensitive: KeywordPattern;
  replacementHeadsigns: KeywordPattern;
  railLineCode: KeywordPattern;
  highSpeedBrands: KeywordPattern;
  notHighSpeed: KeywordPattern;
}

/** Generic multilingual keyword lists (train categories, brands, rail-replacement wording): data, not code. */
const KW = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../data/classify-keywords.json"), "utf8")) as Keywords;

function kwRe(p: KeywordPattern): RegExp {
  const src = p.regex ?? (p.words ? `\\b(${p.words.join("|")})\\b` : `(${p.any!.join("|")})`);
  return new RegExp(src, p.flags ?? "");
}

// Train category tokens (case-insensitive unless noted).
const LD_TOKENS = new Set(KW.trainCategories.longDistance.map((s) => s.toLowerCase()));
const LD_CASE_SENSITIVE = new Set(KW.trainCategories.longDistanceCaseSensitive); // regiojet "rj" (CZ) and railjet "RJ" are both long distance
const REG_TOKENS = new Set(KW.trainCategories.regional.map((s) => s.toLowerCase()));
const NIGHT_TOKENS = new Set(KW.trainCategories.night);
const NIGHT_RE = kwRe(KW.nightNames);

/** Operators whose rail services are long distance whatever the route_type. */
const LD_OPERATORS = kwRe(KW.longDistanceOperators);
const REG_OPERATORS = kwRe(KW.regionalOperators);

/**
 * Trip categories that are road vehicles even when the route is a rail route (route_type 2): a trip category "BUS"
 * (Irish Rail numbers its buses on rail routes "BUS123"), "Car", "Autocar", "Autobus". Such trips are classified as
 * buses, not as trains. Operator-specific categories (SNCF CTE / CRE) are in the operator adapters.
 */
const ROAD_TRIP_PREFIXES = new Set(KW.roadTripCategories.list);

/**
 * Rail-replacement / special buses we never want, by route name, route description or agency (DELFI "DB SEV GmbH",
 * "Bus SEV, nur Abellio …"), in every country's wording (data/classify-keywords.json, replacementNames).
 */
const REPLACEMENT_RE = kwRe(KW.replacementNames);
/** Case-sensitive markers: CZ / SK "NAD" (náhradní autobusová doprava; "nad" is also the Czech "above"), PL "ZKA". */
const REPLACEMENT_CS_RE = kwRe(KW.replacementNamesCaseSensitive);

/** True for route names / descriptions / agency names that mark a rail-replacement bus. */
export function isReplacementName(...texts: string[]): boolean {
  return texts.some((t) => !!t && (REPLACEMENT_RE.test(t) || REPLACEMENT_CS_RE.test(t)));
}

/**
 * Trip headsigns of rail-replacement buses published under an ordinary line (DELFI "Gera Hbf (SEV)", "Derkum Bahnhof
 * SEV, Weilerswist", Rejseplanen "Nykøbing F St. (togbus)"). Stricter than the route-name test: headsigns are place
 * names, so "Ev. Kirche" (evangelische) or a Slovenian "Planina/Sev." must not match.
 */
export const REPLACEMENT_HEADSIGN_RE = kwRe(KW.replacementHeadsigns);

/**
 * Line codes of trains (German / Austrian / Swiss style: RE 7, RB81X, S1EV, MEX17E, IRE3): a bus route with such a
 * name whose agency runs trains in the same country is a rail-replacement bus (DELFI publishes SEV buses as bus
 * routes "RE1" of the railway's agency, or of "Nahreisezug"). See build.ts (replacement buses).
 */
export const RAIL_LINE_CODE_RE = kwRe(KW.railLineCode);

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
  const cl = classifyGeneric(r, ctx);
  if (!cl) return null;
  const out = ctx.hooks?.after ? ctx.hooks.after(r, cl) : undefined;
  const res = out === undefined ? cl : out;
  if (res && res.cls === "rail" && res.cat == null && ctx.opts.railCatDefault) return { ...res, cat: Cat[ctx.opts.railCatDefault] };
  return res;
}

function classifyGeneric(r: RouteInfo, ctx: ClassifyContext): Classification | null {
  let mode = modeOfRouteType(r.routeType);
  if (!mode) return null;
  const prefix = r.tripPrefix.toLowerCase();
  const ov = ctx.hooks?.before?.(r, mode);
  let roadFlags = ov?.flags ?? 0;
  if (ov?.mode) mode = ov.mode;
  else if (mode === "rail" && ROAD_TRIP_PREFIXES.has(prefix)) mode = "bus";
  const allNames = `${r.shortName} ${r.longName} ${r.desc}`;
  const { opts } = ctx;
  // replacement buses, also when published as a train (ŽSR "Os 14281" with the long name "NAD")
  if (isReplacementName(r.shortName, r.longName, r.desc, r.agency) || REPLACEMENT_RE.test(r.tripPrefix)) return null;

  if (mode !== "rail") {
    const coachByName = ctx.coachRe.test(r.agency) || ctx.coachRe.test(allNames);
    if (mode === "coach") {
      if (r.routeType === 204 || r.routeType === 208 || r.routeType === 209 || opts.coachTypesAsBus) mode = coachByName ? "coach" : "bus";
    } else if (coachByName || opts.allCoach) mode = "coach";
    if (mode === "bus" && ctx.urbanRe && ctx.urbanRe.test(r.agency)) return null;
  }
  if (opts.allCoach && mode !== "rail") mode = "coach";
  if (!ctx.keep.includes(mode)) return null;

  if (mode === "coach") return { cls: "coach", cat: Cat.Coach, flags: roadFlags };
  if (mode === "bus") return { cls: "bus", cat: Cat.Bus, flags: roadFlags };

  // ---- rail ----
  let flags = roadFlags;
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
  return { cls: "rail", cat, flags };
}

/**
 * High-speed services: train brands built for (and timetabled on) high-speed lines (LGV, NBS, AV,
 * HSL, HS1), or GTFS route_type 101. Used only to steer rail geometry (geometry/guide.ts): other
 * trains are kept off the lines named as high-speed lines unless their timetable needs them.
 */
const HS_RE = kwRe(KW.highSpeedBrands);
/** Brand names that look high-speed but are not ("OUIGO Train Classique" runs on classic lines). */
const NOT_HS_RE = kwRe(KW.notHighSpeed);

/**
 * `highSpeed`: an operator adapter says the route is a high-speed service although its names carry no brand
 * (operators/*.ts route hook, e.g. an operator that names its routes after the end stations only).
 */
export function isHighSpeedService(r: { routeType?: number | null; agency: string; names: string[]; highSpeed?: boolean }): boolean {
  const text = r.names.filter(Boolean).join(" ");
  if (NOT_HS_RE.test(text)) return false;
  if (r.routeType === 101) return true;
  if (r.highSpeed) return true;
  return HS_RE.test(text);
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
