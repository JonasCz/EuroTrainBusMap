/**
 * CTM (Compagnie de Transports au Maroc), Morocco's national intercity coach operator: every run of its booking site, with
 * stops, times and weekdays. No GTFS exists (Transitous has only `ma_oncf` = ONCF trains + 34 Supratours train-connecting
 * coach routes, the Mobility Database nothing; checked 2026-11-01), the site only answers searches between two cities, so
 * the runs are found by a systematic sweep of those searches (design in WHAT THIS SCRIPT DOES).
 *
 * SOURCE
 *   https://booking.ctm.ma/ – the Turnit booking app of https://www.ctm.ma/, which calls an
 *   unauthenticated JSON API under https://booking.ctm.ma/api/fr-fr/: no key, no cookie, no token. Terms (checked
 *   2026-11-01): booking.ctm.ma/robots.txt is "User-agent: * / Disallow:" (everything allowed), ctm.ma/robots.txt disallows
 *   only /wp-json/, and the terms of sale https://ctm.ma/cgv/ have no scraping / reuse clause. The default request headers of
 *   ctx.fetchText (Accept: text/html plus a wildcard) are answered with JSON, no header option is needed. The API sends
 *   "X-RateLimit-Limit: 3600" (per hour, presumably); this script stays at 1 request/s (at most 2 in flight) and ~1,400
 *   requests per run, see FAILS ON PURPOSE for the hard cap.
 *
 * SHAPE OF THE SOURCE (live, checked 2026-11-01; searched days 2026-11-04 … 2026-12-31)
 *   GET /filtered-stops?onlyWithValidTrips=true – 119 cities, 130 stops (names unique), one country:
 *     {"Countries":[{"CountryId":94,"CountryName":"Maroc","Cities":[{"CityId":5589,"CityName":"Agadir","BusStops":[
 *        {"BusStopId":277,"BusStopCode":"AGD","BusStopName":"Agadir","CountyName":"Souss Massa",
 *         "Coordinates":{"Latitude":30.416237,"Longitude":-9.565609}, …}]}, …]}],"Suggestions":{…}}
 *     A city has 1 to 5 stops (Casablanca: "Casablanca FAR", "Casablanca Maarif", "Casablanca Ain Sebaa", "Supratours Casa
 *     voyageurs"; Dakhla: "Dakhla", "Argoube", "Imlili", "Tchika", "Bir Guendouz"). 125 stops have "Coordinates", 5 have
 *     null: Ait Ourir, Boufakrane, Tchika, "Supratours Casa voyageurs", "Beni Mellal Supratours" (CTM stops despite the
 *     names). One position is wrong: "Ait Aissa" (30.49,-9.13, in the Souss) is a stop on the RN10 east of Tinghir.
 *   GET /journeys/search?departureDate=2026-11-04&isPartOfRoundtrip=false&currency=CURRENCY.MAD&fareClasses=
 *       BONUS_SCHEME_GROUP.ADULT%2C1&originCityId=5618&destinationCityId=5589&IsOutbound=true&CheckPaxSoldTogetherRules=true
 *     (both city ids and `currency` are required: 400 without) – every journey between the stops of the two cities on that
 *     day, direct ones and ones with a change (up to two legs), 46 journeys at most, the fields the script reads:
 *     {"Journeys":[{"JourneyId":"f080ad28-fbe7-4a68-a3c6-20a3171e3f61","DepartureDateTime":"2026-11-04T06:30:00",
 *        "ArrivalDateTime":"2026-11-04T13:45:00","OriginStopName":"Casablanca FAR","OriginStopId":301,
 *        "DestinationStopName":"Agadir","DestinationStopId":277,"IsForSale":true,"RegularPrice":315,…,
 *        "Legs":[{"BusCompanyName":"CTM","BrandShortName":"CONFORT","BusLineNumber":"009040","DepartureStopId":301,
 *          "DepartureStopName":"Casablanca FAR","DepartureDatetime":"2026-11-04T06:30:00","DestinationStopId":277,
 *          "DestinationStopName":"Agadir","ArrivalDatetime":"2026-11-04T13:45:00",…}]}, …]}
 *     A change: Casablanca → Mrirt = leg 009006 "Casablanca FAR" 07:30 → "Beni Mellal Amiral" 11:00 + leg 015001 "Beni
 *     Mellal Amiral" 17:15 → "Mrirt" 20:40. Companies: "CTM" in all 4,000+ legs seen; brands CONFORT / PREMIUM. The day
 *     after the last day of sale and past dates answer {"Journeys":[]} (or a handful of legs of the last day's runs after midnight).
 *   GET /journeys/{JourneyId}/route?includeIntermediateStops=true (the JourneyId expires after ~10 minutes, HTTP 400)
 *     {"Legs":[{"ServiceCode":"CATF100","BusCompanyName":"CTM","BusLineNumber":"009040","TripName":"Casablanca-Tafraout",
 *        "DepartureStopName":"Casablanca FAR","DepartureDatetime":"2026-11-04T06:30:00","DestinationStopName":"Agadir",
 *        "ArrivalDatetime":"2026-11-04T13:45:00","IntermediateStops":[{"StopName":"Casablanca Maarif",
 *        "ArrivalDateTime":"2026-11-04T06:45:00","DepartureDateTime":"2026-11-04T07:00:00","IsRequestPickUpStop":true,
 *        "IsRequestDropOffStop":false}, {"StopName":"Marrakech","ArrivalDateTime":"2026-11-04T10:25:00",…}]}]}
 *     One leg per leg of the journey. ONLY THE SEARCHED PART: the journey Casablanca FAR → Agadir shows FAR, Maarif,
 *     Marrakech, Agadir although the run CATF100 goes on to Tafraout (19:15). Stops are given by name only (= the names of
 *     filtered-stops, all 130 occur). ServiceCode = one run (the same on every day and from every stop: "CATF100" for the
 *     boardings at FAR, Maarif, …), TripName its end-to-end label ("Casablanca-Tafraout", "Fes-Tanger Via Chefchaouen",
 *     spellings "Casa Ainsebaa", "Taounat", "Lamhamid", "Guergarat"), BusLineNumber only a line family (50 numbers, a
 *     number carries both directions and many runs).
 *   Times are local (Africa/Casablanca), "YYYY-MM-DDTHH:MM:00", always whole minutes; a run that passes midnight has the next
 *   date in its later calls. Size on 2026-11-04: 168 ServiceCodes, 7.2 calls per run on average (2 to 18).
 *
 * WHAT THIS SCRIPT DOES (about 1,400 requests, 25 minutes: 1,034 searches, 359 routes; live run 2026-11-01, 1,394 requests
 * in 1,486 s with --start 2026-11-02; the sampled week is then 2026-11-04 … 2026-11-10)
 *   1. GET filtered-stops (cities, stops, coordinates; fails on another country, duplicate stop names, < MIN_CITIES).
 *   2. Discovery on the first sampled day (startDate + 2, tomorrow in the weekly build): for each HUB (Casablanca, Agadir,
 *      Marrakech) search hub → every other city and every other city → hub (236 searches per hub), farthest cities first.
 *      Every journey whose legs are not all explained by a known run is routed, the longest first (one route then explains the
 *      shorter journeys of the same run): the leg's ServiceCode/TripName identify the run, its stops are one piece of it.
 *      Pieces of one ServiceCode are merged (same times at every shared stop); two runs found apart are joined when a
 *      piece bridges them. A search lists the legs of the runs that left the day before as well, so pieces are matched with a
 *      shift of whole days and times are kept relative to the service day (the day of the run's first departure).
 *      Runs that touch no hub are found as the second leg of a journey with a change (Marrakech – Essaouira…).
 *   3. Closure: a city no run calls at (none on 2026-11-04) is searched against its 8 nearest cities.
 *   4. Completion: a run known only in part (its first/last stop is not in the cities of its TripName; 22 after the sweeps)
 *      is completed by searching the two cities of its TripName on the day it was found and the 2 days before and routing the
 *      journey of its line that spans it (50 requests); 3 stay partial (below).
 *   5. Cover: a search of (A, B) lists a run only if one of its stop pairs in A and B is for sale (Inzegane → Agadir lists 3 of
 *      the ~25 runs calling at both), so the pairs that listed a run directly in step 2 (`Run.pairs`) are kept; runs that no
 *      search listed directly (found as a leg of a change) get the pair of their two ends, searched once (12 requests). A
 *      greedy set cover picks 43 pairs that list all 168 runs.
 *   6. Sampled week: the 43 pairs are searched on the seven days (the first day reuses the discovery's answers: no request); a
 *      run is found on a day when one of the journeys is one of its legs (stop names and times; a leg whose time or stops
 *      differ is a new run: routed, merged with the run of the same ServiceCode when the calls agree, else a new run with
 *      its own mask: CABM109 leaves Beni Mellal at 05:30 Monday – Saturday and at 11:00 on Sundays). The weekday mask of a
 *      run = the weekdays of the SERVICE DAYS of the instances found (a search of the pair lists the run on the searched day
 *      or on the day after it left, so the service day is searched day − the day offset of the boarding stop). 263 requests,
 *      4 runs found only on other days.
 *   7. Sales horizon: the busiest pair is searched on the window's last day and, if it has fewer than a quarter of its
 *      journeys of the first day, bisected for the last day with answers (2026-12-31 on 2026-11-01: today + 60; ~7 requests).
 *   8. Spot checks: the 12 busiest pairs on day +21 and +49 of the first day: runs expected by the mask but not found, though
 *      their line is offered, are a warning (0 of 110 on 2026-11-25 and on 2026-12-23).
 *   9. Feed: agency CTM (https://www.ctm.ma/, Africa/Casablanca, fr), route_type 200 (coach). One route per TripName (a
 *      direction, "Fes – Tanger via Chefchaouen"), one trip per run (ServiceCode + time pattern) with ALL its calls
 *      (arrival and departure times, >24:00 after midnight); service = the weekday mask on every day from startDate − 1 to
 *      min(startDate + days, sales horizon). Stops: id s<BusStopId>, coordinates from filtered-stops when inside Morocco, a
 *      reviewed entry of data/geocodes/ma-ctm.json first (it wins: corrections such as Ait Aissa), else the entry for stops
 *      without coordinates (country "ma", `geo.resolve` / `geo.finish`: the runs calling at a stop without a reviewed
 *      position are left out and reported, `pnpm run geocode -- ma-ctm`). Speeds between consecutive calls are checked
 *      (MAX_KMH on distance / (minutes + HOP_SLACK_MIN)): an impossible hop drops the run with a warning.
 *  10. ctx.observe("line-<BusLineNumber>", runs with ServiceCode, trip name, mask, stops and times), no prices, seats or
 *      journey ids.
 *   Politeness: a pacing limiter inside the script (>= 1 s between request starts, at most 2 in flight), a hard budget
 *   (MAX_REQUESTS = 2,000, 70 % of it for steps 1-5; on reaching it the run finishes with what it has and warns), 8 failed
 *   requests in a row end the run. Measured: ~1 request/s sustained, 24 min 46 s for the full run.
 *
 * Measured on 2026-11-04 (hubs in the order Casablanca, Agadir, Fès, Oujda, Marrakech, Tanger, 236 searches each; new runs
 * per hub): 152, +18, ±0 (Fès only completed runs found in part), +0, +2 (Marrakech – Essaouira both ways), +0 = 171 runs, 168
 * ServiceCodes after the completion; the three hubs used (Casablanca, Agadir, Marrakech) find the same 168. Completeness
 * sample: on top of the hubs Casablanca and Agadir, 480 searches for 10 random other cities (Ksar El Kébir, Kassita, Erfoud,
 * Zaouit Echeikh, Midar, Ahfir, Boujdour, Goulmima, Centre 44 ouled dlim, Fès; each against its 12 nearest and 12 random
 * cities, both ways) listed no journey that the known runs do not explain.
 *
 * KNOWN QUIRKS
 *   - ASSUMPTION: the API is per date and the weekly mask comes from ONE sampled week (startDate + 2 … + 8): it is repeated
 *     over the whole window. Holidays, seasonal changes (Eid, summer) and changes after the sampled week are not seen except
 *     by the spot checks (+21 and +49 days: no difference on 2026-11-25 and 2026-12-23).
 *   - The sales horizon differs by line: today + 60 days for most (2026-12-31 on 2026-11-01), only today + 29 for the long
 *     southern lines (Agadir – Dakhla: 2026-11-30 yes, 2026-12-01 empty); the spot check at +49 days therefore misses 18 of
 *     110 runs "not sold that far ahead" (logged, not a warning). Their service is generated up to the pair's horizon all the same.
 *   - GAP (what the sweep cannot see): a run that does not run on the first sampled day AND shares no city pair with a run
 *     that does is not found (weekday-limited runs on a pair nothing else serves); a short run between two cities that are
 *     neither a hub nor reachable by a same-day change is not found either (Marrakech – Essaouira was such a case: found only
 *     since Marrakech is a hub). Measured: see above, no run missing in 480 searches of 10 random cities.
 *   - A leg search lists only for-sale stop pairs: "IsForSale": false (10 % of the journeys, 0 seats, no price: sold out or
 *     not sold on that pair) is still a run that exists and is used as evidence; whole stops are in the route all the same.
 *   - Times are rounded to 5 minutes and sometimes inconsistent with the distance: Safi → Sebt Gzoula 24 km in 5 min
 *     (CAAG112), Idaousmlal → Ait Ouafqa 9 km in 0 min (CATF100), Dakhla – Guerguerat: Imlili → Tchika 90 min for 1 km and
 *     Bir Guendouz → Tchika 145 km in 65 min (DAGR101). HOP_SLACK_MIN (10) keeps these runs; a real position error is far above.
 *   - "IsRequestPickUpStop"/"IsRequestDropOffStop" (on request stops) are not used; every call is a normal call.
 *   - 3 runs end earlier than their TripName says ("Casablanca-Inzegane Via Safi" CAAG100 / CAAG112 end at Agadir, the
 *     return CAAG101 starts there): the API lists no journey to Inzegane for them; they are kept as they are (warning).
 *   - The same ServiceCode can have several time patterns (CABM109 05:30 Mon-Sat, 11:00 Sun; CASA103, CATO101, RABM101): one
 *     trip each, with its own weekdays.
 *   - Stops called "Supratours …" are CTM's (ids 599, 600, 609); Supratours itself is not in this API.
 *   - Every call of every run of 2026-11-04 is one of the 130 stops of filtered-stops (all 130 occur), so no stop needs a
 *     position outside the geocode file; the file also has the correction for "Ait Aissa".
 *   - 119 routes for 172 trips: one route per TripName, i.e. per direction and via ("Fes – Tanger via Chefchaouen" and
 *     "… via Larache" are two routes), no short name (line numbers are internal).
 *
 * FAILS ON PURPOSE (the build skips the feed and keeps going) when
 *   - filtered-stops, a search or a route lacks the fields above or has them in another form (not a JSON object, no
 *     Countries / Journeys / Legs list, a time not "YYYY-MM-DDTHH:MM:00" or more than 4 days from the searched day, a leg that
 *     arrives before it leaves, legs of a journey that do not connect, a route with another number of legs than the journey
 *     or whose leg is not the searched leg, no ServiceCode);
 *   - a country other than "Maroc" (international stops: decide coordinates box, agency, route type), two stops with one
 *     name (routes name stops by name only), fewer than MIN_CITIES (80) cities, a hub name that is not a city;
 *   - a company other than "CTM" in a leg (a partner? keep it as its own agency then);
 *   - fewer than MIN_RUNS (100) runs, or no run at all on the first sampled day;
 *   - more than MAX_DROPPED (10 %) of the runs dropped (times going backwards, impossible hops, a stop twice) or with a trip
 *     name whose ends are neither a city, a stop nor one of TRIP_ALIASES (the trip names changed);
 *   - 8 requests in a row fail, or more than 10 and more than 3 % of all requests (the request layer has retried each 3 times);
 *   - nothing is left because every run calls at a stop without a reviewed position (NeedsGeocodingError; otherwise those
 *     runs are only left out and reported in the build report, `pnpm run geocode -- ma-ctm`).
 *   - (not a failure) the request budget used up (warning, feed built from what was found), runs known in part, a sales horizon
 *     before the window's end (service ends there), spot-check differences, runs that no pair search lists (left out, warning).
 *
 * HOW TO RE-CHECK / UPDATE
 *   - `pnpm --filter @etbm/etl run generate -- ma-ctm --start 2026-11-02` runs it live (~25 min, ~1,400 requests; the log
 *     shows every step with its requests and the runs found; one line per trip at the end). `pnpm run geocode -- ma-ctm`
 *     runs the generator up to three times: record the API's answers (or accept a long wait) rather than asking 4,000 times.
 *   - By hand (stay at 1 request/s): `curl -s 'https://booking.ctm.ma/api/fr-fr/filtered-stops?onlyWithValidTrips=true'`,
 *     the search URL above (change the city ids and the date), then the route of a JourneyId at once (it expires).
 *   - A new TripName spelling that is no city/stop: add it to TRIP_ALIASES (the warning names it). Another company, another
 *     country, or a changed field: update parse* and the header together. A new hub is worth it when it finds >= 2 % more runs
 *     (measure with a sweep as in step 2; the gain list above). New stops need coordinates: the geocode tool.
 *   - The geocode file (data/geocodes/ma-ctm.json): Boufakrane, Ait Ourir (OSM), Tchika (= Supratours' "Tichka" stop of the
 *     ma-oncf feed, 3 km from the OSM place), Beni Mellal Supratours (Supratours' own agency list), Supratours Casa voyageurs
 *     (the Casa Voyageurs station stop of ma-oncf), Ait Aissa (correction of the API, OSM village on the RN10).
 *   - Tests: test/ctm.test.ts with trimmed copies of the API in test/fixtures/ctm/ and a fake API built from a small timetable.
 */
import { defineGenerator, GeneratorError, type GeneratorContext } from "../src/generators/types.ts";
import { addDays, dateRange, haversineKm, isoWeekday, type GtfsFeed } from "../src/generators/gtfs.ts";
import { serviceWindow } from "../src/generators/registry.ts";
import { GeocodeStore } from "../src/generators/geocodes.ts";

export const SITE_URL = "https://www.ctm.ma/";
export const BOOKING_URL = "https://booking.ctm.ma/";
export const API = "https://booking.ctm.ma/api/fr-fr";

/** Hard cap on requests per run (searches + routes + the stop list); on reaching it the run finishes with what it has. */
export const MAX_REQUESTS = 2000;
/** Share of the budget the discovery (stop list, hub sweeps, completion) may use; the rest is kept for the sampled week. */
export const DISCOVERY_SHARE = 0.7;
/** At most one request start per this many ms on average, and this many in flight. */
export const MIN_INTERVAL_MS = 1000;
export const MAX_IN_FLIGHT = 2;
/** Cities swept against every other city in both directions (the order matters: the first sweep teaches the most). */
export const HUBS = ["Casablanca", "Agadir", "Marrakech"];
/** The sampled week starts this many days after the build's start date (the API has no past dates; today's list is cut). */
export const SAMPLE_OFFSET = 2;
/** Fewer runs than this: the API answered with much less than usual. */
export const MIN_RUNS = 100;
/** Fewer cities in the stop list than this (119 in Nov 2026): the list is cut or changed. */
export const MIN_CITIES = 80;
/** Straight-line speed between two calls above which a run is skipped (wrong coordinates or times). */
export const MAX_KMH = 130;
/** Minutes added to a leg's time before its speed is checked: the timetable rounds to 5 minutes and shows stops a few km apart at the same minute. */
export const HOP_SLACK_MIN = 10;
/** A city no run calls at is searched against this many of its nearest cities (both ways). */
export const CLOSURE_NEIGHBOURS = 8;
/** Spot checks: days after the first sampled day, and how many of the busiest pairs are searched on each. */
export const SPOT_OFFSETS = [21, 49];
export const SPOT_PAIRS = 12;
/** Journeys one sampled day may route that no known run explains (a day that differs much from the first would otherwise route hundreds). */
export const MAX_ROUTES_PER_DAY = 80;
/** This many requests in a row failing (after the retries of the request layer) stop the run. */
export const MAX_FAILURE_STREAK = 8;
/** Share of runs that may be dropped (backwards times, impossible hops…) before the layout is considered misread. */
export const MAX_DROPPED = 0.1;
/** Spellings in the trip names ("TripName": "Marrakech-Lamhamid") that are neither a city nor a stop name, normalised → city or stop name. */
export const TRIP_ALIASES: Record<string, string> = { lamhamid: "M'Hamid El Ghizlane", taounat: "Taounate", casaainsebaa: "Casablanca Ain Sebaa" };

function fail(m: string): never {
  throw new GeneratorError(m);
}
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const dayNumber = (iso: string) => Math.round(Date.parse(iso + "T00:00:00Z") / 86_400_000);
const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// ---------------------------------------------------------------- reading the API (strict)

export interface Stop {
  id: number;
  name: string;
  city: City;
  coord: [number, number] | null;
}
export interface City {
  id: number;
  name: string;
  stops: Stop[];
  /** mean position of the stops that have one */
  pos: [number, number] | null;
}
export interface Network {
  cities: City[];
  cityByNorm: Map<string, City>;
  stopByName: Map<string, Stop>;
  stopByNorm: Map<string, Stop>;
}

/** GET /filtered-stops?onlyWithValidTrips=true: the cities and bus stops one can search between. */
export function parseNetwork(j: unknown, minCities = MIN_CITIES): Network {
  const countries = isObj(j) && Array.isArray(j.Countries) ? (j.Countries as unknown[]) : fail("filtered-stops: no Countries list");
  const cities: City[] = [];
  const cityByNorm = new Map<string, City>();
  const stopByName = new Map<string, Stop>();
  const stopByNorm = new Map<string, Stop>();
  for (const c of countries) {
    if (!isObj(c) || typeof c.CountryName !== "string" || !Array.isArray(c.Cities)) fail(`filtered-stops: unreadable country ${JSON.stringify(c).slice(0, 120)}`);
    const co = c as { CountryName: string; Cities: unknown[] };
    if (co.CountryName !== "Maroc") fail(`filtered-stops: country "${co.CountryName}" (the script knows only "Maroc": decide how to treat international stops: coordinates box, agency, route type)`);
    for (const ci of co.Cities) {
      if (!isObj(ci) || !Number.isInteger(ci.CityId) || typeof ci.CityName !== "string" || !Array.isArray(ci.BusStops) || !ci.BusStops.length) fail(`filtered-stops: unreadable city ${JSON.stringify(ci).slice(0, 160)}`);
      const city: City = { id: ci.CityId as number, name: ci.CityName as string, stops: [], pos: null };
      for (const s of ci.BusStops as unknown[]) {
        if (!isObj(s) || !Number.isInteger(s.BusStopId) || typeof s.BusStopName !== "string") fail(`filtered-stops: unreadable stop ${JSON.stringify(s).slice(0, 160)}`);
        let coord: [number, number] | null = null;
        const k = (s as { Coordinates?: unknown }).Coordinates;
        if (k != null) {
          if (!isObj(k) || typeof k.Latitude !== "number" || typeof k.Longitude !== "number") fail(`filtered-stops: stop "${s.BusStopName}": unreadable Coordinates ${JSON.stringify(k)}`);
          coord = [(k as { Latitude: number }).Latitude, (k as { Longitude: number }).Longitude];
        }
        const stop: Stop = { id: s.BusStopId as number, name: s.BusStopName as string, city, coord };
        if (stopByName.has(stop.name)) fail(`filtered-stops: two stops called "${stop.name}" (the route answers name stops by name only)`);
        stopByName.set(stop.name, stop);
        stopByNorm.set(norm(stop.name), stop);
        city.stops.push(stop);
      }
      const cs = city.stops.filter((s) => s.coord);
      if (cs.length) city.pos = [cs.reduce((a, s) => a + s.coord![0], 0) / cs.length, cs.reduce((a, s) => a + s.coord![1], 0) / cs.length];
      if (cityByNorm.has(norm(city.name))) fail(`filtered-stops: two cities called "${city.name}"`);
      cityByNorm.set(norm(city.name), city);
      cities.push(city);
    }
  }
  if (cities.length < minCities) fail(`filtered-stops: only ${cities.length} cities (expected at least ${minCities})`);
  return { cities, cityByNorm, stopByName, stopByNorm };
}

const DT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):00$/;
/** "2026-11-05T03:00:00" → minutes after midnight of `date` (past midnight: > 1440). */
export function minutesOf(dt: unknown, date: string, what: string): number {
  const m = typeof dt === "string" ? DT_RE.exec(dt) : null;
  if (!m) return fail(`${what}: "${String(dt)}" is not a YYYY-MM-DDTHH:MM:00 time`);
  const h = Number(m[2]), mi = Number(m[3]);
  if (h > 23 || mi > 59) fail(`${what}: "${dt}" is not a time`);
  const d = dayNumber(m[1]!) - dayNumber(date);
  if (d < 0 || d > 4) fail(`${what}: "${dt}" lies ${d} days from the searched day ${date}`);
  return d * 1440 + h * 60 + mi;
}

const COMPANY = "CTM";
export interface SLeg {
  line: string;
  depStop: string;
  dep: number;
  destStop: string;
  arr: number;
}
export interface SJourney {
  id: string;
  legs: SLeg[];
  dep: number;
  arr: number;
}

/** GET /journeys/search: the journeys (direct and with a change) between two cities on one day. */
export function parseSearch(j: unknown, date: string): SJourney[] {
  const list = isObj(j) && Array.isArray(j.Journeys) ? (j.Journeys as unknown[]) : fail("journeys/search: no Journeys list");
  const out: SJourney[] = [];
  for (const x of list) {
    if (!isObj(x) || typeof x.JourneyId !== "string" || !Array.isArray(x.Legs) || !x.Legs.length) fail(`journeys/search: unreadable journey ${JSON.stringify(x).slice(0, 160)}`);
    const legs: SLeg[] = [];
    for (const l of (x as { Legs: unknown[] }).Legs) {
      const where = `journeys/search: leg ${JSON.stringify(l).slice(0, 160)}`;
      if (!isObj(l) || typeof l.BusLineNumber !== "string" || typeof l.DepartureStopName !== "string" || typeof l.DestinationStopName !== "string") fail(`${where} lacks BusLineNumber / stop names`);
      const L = l as Record<string, unknown>;
      if (L.BusCompanyName !== COMPANY) fail(`${where}: company "${String(L.BusCompanyName)}" (the script knows only "${COMPANY}": decide whether it is a CTM partner to keep as its own agency)`);
      const dep = minutesOf(L.DepartureDatetime, date, where), arr = minutesOf(L.ArrivalDatetime, date, where);
      if (arr <= dep) fail(`${where}: arrives before it departs`);
      legs.push({ line: L.BusLineNumber as string, depStop: L.DepartureStopName as string, dep, destStop: L.DestinationStopName as string, arr });
    }
    for (let i = 1; i < legs.length; i++) if (legs[i]!.depStop !== legs[i - 1]!.destStop || legs[i]!.dep < legs[i - 1]!.arr) fail(`journeys/search: legs of a journey do not connect: ${JSON.stringify(legs)}`);
    out.push({ id: (x as { JourneyId: string }).JourneyId, legs, dep: legs[0]!.dep, arr: legs[legs.length - 1]!.arr });
  }
  return out;
}

/** A call of a run; the first has no arrival, the last no departure until the run is complete. */
export interface Call {
  name: string;
  arr?: number;
  dep?: number;
}
export interface Piece {
  code: string;
  line: string;
  tripName: string;
  calls: Call[];
}

/** GET /journeys/{id}/route?includeIntermediateStops=true: the legs of a journey with their stops (only the part between the searched stops). */
export function parseRoute(j: unknown, date: string): Piece[] {
  const legs = isObj(j) && Array.isArray(j.Legs) ? (j.Legs as unknown[]) : fail("route: no Legs list");
  const out: Piece[] = [];
  for (const l of legs) {
    const where = `route: leg ${JSON.stringify(l).slice(0, 160)}`;
    if (!isObj(l) || typeof l.ServiceCode !== "string" || !l.ServiceCode || typeof l.BusLineNumber !== "string" || typeof l.TripName !== "string" || typeof l.DepartureStopName !== "string" || typeof l.DestinationStopName !== "string" || !Array.isArray(l.IntermediateStops))
      fail(`${where} lacks ServiceCode / BusLineNumber / TripName / stops`);
    const L = l as Record<string, unknown>;
    if (L.BusCompanyName !== COMPANY) fail(`${where}: company "${String(L.BusCompanyName)}" (the script knows only "${COMPANY}")`);
    const calls: Call[] = [{ name: L.DepartureStopName as string, dep: minutesOf(L.DepartureDatetime, date, where) }];
    for (const s of L.IntermediateStops as unknown[]) {
      if (!isObj(s) || typeof s.StopName !== "string") fail(`${where}: unreadable intermediate stop ${JSON.stringify(s).slice(0, 120)}`);
      calls.push({ name: s.StopName as string, arr: minutesOf(s.ArrivalDateTime, date, where), dep: minutesOf(s.DepartureDateTime, date, where) });
    }
    calls.push({ name: L.DestinationStopName as string, arr: minutesOf(L.ArrivalDatetime, date, where) });
    out.push({ code: L.ServiceCode as string, line: L.BusLineNumber as string, tripName: L.TripName as string, calls });
  }
  return out;
}

// ---------------------------------------------------------------- runs

const DAY = 1440;
const mod = (n: number) => ((n % DAY) + DAY) % DAY;
const epochDay = dayNumber;
const dateOfEpochDay = (n: number) => addDays("1970-01-01", n);

/**
 * One run: a ServiceCode with its calls. Times are minutes after midnight of the run's service day (the day of its
 * first departure; the first call leaves in [0, 1440), later calls may pass midnight). The same bus is found on many days
 * and, because a search also lists the legs of a run that left the day before, one search can show instances of
 * different service days: `refDay` is the service day of the instance the calls are expressed for, an instance seen
 * later is `refDay + k`.
 */
export interface Run {
  code: string;
  line: string;
  tripName: string;
  calls: Call[];
  /** epoch day number of the reference instance's service day */
  refDay: number;
  /** searched day (YYYY-MM-DD) → instances (k, in days after refDay) found by the sampled-week searches of that day */
  seen: Map<string, Set<number>>;
  /** the searched day whose answer created the run */
  born: string;
  /** city pairs (`originId>destId`) whose search listed the run as a direct journey: those searches show the run again on other days */
  pairs: Set<string>;
}

const sameTime = (a: number | undefined, b: number | undefined) => a === undefined || b === undefined || a === b;

/** Can the calls of `b` be merged into those of `a` (same times at every shared call, same order, at least one shared call)? Returns the merged calls, or null. */
export function mergeCalls(a: Call[], b: Call[]): Call[] | null {
  const out = a.map((c) => ({ ...c }));
  const idx = (n: string) => out.findIndex((c) => c.name === n);
  const fi = b.findIndex((c) => idx(c.name) >= 0);
  if (fi < 0) return null;
  const fill = (k: number, c: Call): boolean => {
    const o = out[k]!;
    if (!sameTime(o.arr, c.arr) || !sameTime(o.dep, c.dep)) return false;
    o.arr ??= c.arr;
    o.dep ??= c.dep;
    return true;
  };
  const pos = idx(b[fi]!.name);
  if (!fill(pos, b[fi]!)) return null;
  let at = pos;
  for (let i = fi + 1; i < b.length; i++) {
    const k = idx(b[i]!.name);
    if (k >= 0) {
      if (k <= at || !fill(k, b[i]!)) return null;
      at = k;
    } else out.splice(++at, 0, { ...b[i]! });
  }
  at = pos;
  for (let i = fi - 1; i >= 0; i--) {
    const k = idx(b[i]!.name);
    if (k >= 0) {
      if (k >= at || !fill(k, b[i]!)) return null;
      at = k;
    } else out.splice(at, 0, { ...b[i]! });
  }
  // times never go backwards along the run
  let prev = -Infinity;
  for (const c of out) {
    for (const t of [c.arr, c.dep]) {
      if (t === undefined) continue;
      if (t < prev) return null;
      prev = t;
    }
  }
  return out;
}

const SHIFTS = [0, -1, 1, -2, 2, -3, 3];
const shifted = (calls: Call[], min: number): Call[] => calls.map((c) => ({ name: c.name, ...(c.arr !== undefined ? { arr: c.arr + min } : {}), ...(c.dep !== undefined ? { dep: c.dep + min } : {}) }));
const firstTime = (r: { calls: Call[] }) => r.calls[0]!.dep ?? r.calls[0]!.arr!;

/** All runs found so far, with an index to recognise a journey leg as part of a known run without asking the route. */
export class RunStore {
  readonly runs: Run[] = [];
  private readonly byCode = new Map<string, Run[]>();
  private readonly byDep = new Map<string, Run[]>();
  /** pieces that shared a stop with a run of their ServiceCode but could not be merged (other times) */
  conflicts = 0;

  private index(r: Run): void {
    for (const c of r.calls) {
      if (c.dep === undefined) continue;
      const k = `${r.line}|${c.name}|${mod(c.dep)}`;
      const l = this.byDep.get(k) ?? this.byDep.set(k, []).get(k)!;
      if (!l.includes(r)) l.push(r);
    }
  }

  /** The first call leaves in [0, 1440): the service day is the day of the first departure. */
  private normalize(r: Run): void {
    const d = Math.floor(firstTime(r) / DAY);
    if (!d) return;
    r.calls = shifted(r.calls, -d * DAY);
    r.refDay += d;
  }

  private record(r: Run, date: string, k: number): void {
    (r.seen.get(date) ?? r.seen.set(date, new Set()).get(date)!).add(k);
  }

  /**
   * The run (and instance k) a journey leg belongs to, if known. With `record` the instance counts as found on the
   * searched day `date` (the sampled-week searches; a search of the discovery does not).
   */
  explains(date: string, leg: SLeg, record = false): Run | undefined {
    const day = epochDay(date);
    for (const r of this.byDep.get(`${leg.line}|${leg.depStop}|${mod(leg.dep)}`) ?? []) {
      const i = r.calls.findIndex((c) => c.name === leg.depStop && c.dep !== undefined && mod(c.dep) === mod(leg.dep));
      if (i < 0) continue;
      const delta = leg.dep - r.calls[i]!.dep!; // a multiple of 1440: the instance's service day − the searched day
      const j = r.calls.findIndex((c, n) => n > i && c.name === leg.destStop && c.arr !== undefined && leg.arr - c.arr === delta);
      if (j < 0) continue;
      if (record) this.record(r, date, day + delta / DAY - r.refDay);
      return r;
    }
    return undefined;
  }

  /** Add what a route answered: merged into a run of the same ServiceCode (of whatever day) when the calls agree, else a new run. */
  add(date: string, p: Piece, record = false): Run {
    const day = epochDay(date);
    let into: Run | undefined;
    for (const r of this.byCode.get(p.code) ?? []) {
      if (r.line !== p.line) continue;
      for (const k of SHIFTS) {
        const m = mergeCalls(r.calls, shifted(p.calls, (day - r.refDay - k) * DAY));
        if (!m) continue;
        r.calls = m;
        into = r;
        if (record) this.record(r, date, k);
        break;
      }
      if (into) break;
    }
    if (!into) {
      if ((this.byCode.get(p.code) ?? []).some((r) => r.calls.some((c) => p.calls.some((d) => d.name === c.name)))) this.conflicts++;
      into = { code: p.code, line: p.line, tripName: p.tripName, calls: p.calls.map((c) => ({ ...c })), refDay: day, seen: new Map(), born: date, pairs: new Set() };
      this.runs.push(into);
      (this.byCode.get(p.code) ?? this.byCode.set(p.code, []).get(p.code)!).push(into);
      if (record) this.record(into, date, 0);
    }
    this.normalize(into);
    this.consolidate(into);
    this.index(into);
    return into;
  }

  /** A piece can join two runs of one ServiceCode that were found apart: they become one. */
  private consolidate(r: Run): void {
    for (let again = true; again; ) {
      again = false;
      for (const o of this.byCode.get(r.code) ?? []) {
        if (o === r || o.line !== r.line) continue;
        for (const j of SHIFTS) {
          const m = mergeCalls(r.calls, shifted(o.calls, j * DAY));
          if (!m) continue;
          r.calls = m;
          for (const [d, ks] of o.seen) for (const k of ks) this.record(r, d, k + o.refDay - j - r.refDay);
          if (o.born < r.born) r.born = o.born;
          for (const k of o.pairs) r.pairs.add(k);
          this.runs.splice(this.runs.indexOf(o), 1);
          this.byCode.get(r.code)!.splice(this.byCode.get(r.code)!.indexOf(o), 1);
          for (const l of this.byDep.values()) if (l.includes(o)) l.splice(l.indexOf(o), 1);
          this.normalize(r);
          again = true;
          break;
        }
        if (again) break;
      }
    }
  }
}

const fmtT = (m: number | undefined) => (m === undefined ? "" : `${hm(m)}${m >= DAY ? `+${Math.floor(m / DAY)}` : ""}`);
export const describe = (r: Run) => `${r.code} ${r.line} ${r.calls[0]!.name} ${fmtT(firstTime(r))} → ${r.calls[r.calls.length - 1]!.name} ${fmtT(r.calls[r.calls.length - 1]!.arr)}`;

// ---------------------------------------------------------------- requests: pacing, budget

class BudgetExhausted extends Error {}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Options {
  /** at most one request start per this many ms */
  intervalMs: number;
  inFlight: number;
  maxRequests: number;
  hubs: string[];
  /** fewer runs than this fail the source */
  minRuns: number;
  minCities: number;
  /** the geocode store (default: data/geocodes/ma-ctm.json) */
  geo?: GeocodeStore;
}
export const DEFAULTS: Options = { intervalMs: MIN_INTERVAL_MS, inFlight: MAX_IN_FLIGHT, maxRequests: MAX_REQUESTS, hubs: HUBS, minRuns: MIN_RUNS, minCities: MIN_CITIES };

export class Api {
  requests = 0;
  searches = 0;
  routes = 0;
  failures = 0;
  exhausted = false;
  /** requests allowed so far: the discovery gets DISCOVERY_SHARE of the budget, the sampled week the rest */
  cap: number;
  private streak = 0;
  private inFlight = 0;
  private gate: Promise<void> = Promise.resolve();
  private lastStart = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly ctx: GeneratorContext,
    readonly o: Options,
  ) {
    this.cap = o.maxRequests;
  }

  /** One request start at a time, at least `intervalMs` after the previous one (a stalled timer does not make the next ones bunch up). */
  private pace(): Promise<void> {
    const turn = this.gate.then(async () => {
      for (let wait = this.lastStart + this.o.intervalMs - Date.now(); wait > 0; wait = this.lastStart + this.o.intervalMs - Date.now()) await sleep(wait);
      this.lastStart = Date.now();
    });
    this.gate = turn;
    return turn;
  }

  private async json(url: string): Promise<unknown> {
    if (this.requests >= this.cap) {
      this.exhausted = true;
      throw new BudgetExhausted();
    }
    this.requests++;
    while (this.inFlight >= this.o.inFlight) await new Promise<void>((r) => this.waiting.push(r));
    this.inFlight++;
    try {
      await this.pace();
      const text = await this.ctx.fetchText(url, { expect: /[}\]]\s*$/ });
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return fail(`${url}: not JSON`);
      }
    } finally {
      this.inFlight--;
      this.waiting.shift()?.();
    }
  }

  /** The answer, or undefined when the budget is used up or the request failed (counted; too many failures fail the run at the end). */
  async get(url: string, kind: "search" | "route" | "stops"): Promise<unknown> {
    try {
      const j = await this.json(url);
      if (kind === "search") this.searches++;
      else if (kind === "route") this.routes++;
      this.streak = 0;
      return j;
    } catch (e) {
      if (e instanceof BudgetExhausted) return undefined;
      if (e instanceof GeneratorError) throw e;
      this.failures++;
      // the request layer has retried already: an API that keeps failing is left alone instead of being asked for 2,000 more answers
      if (++this.streak >= MAX_FAILURE_STREAK) fail(`${this.streak} requests in a row failed, the API does not answer (last: ${(e as Error).message})`);
      if (this.failures <= 10) this.ctx.warn(`request failed (${this.failures} so far): ${(e as Error).message}`);
      return undefined;
    }
  }
}

export const searchUrl = (origin: number, dest: number, date: string) =>
  `${API}/journeys/search?departureDate=${date}&isPartOfRoundtrip=false&currency=CURRENCY.MAD&fareClasses=BONUS_SCHEME_GROUP.ADULT%2C1&originCityId=${origin}&destinationCityId=${dest}&IsOutbound=true&CheckPaxSoldTogetherRules=true`;
export const routeUrl = (journeyId: string) => `${API}/journeys/${journeyId}/route?includeIntermediateStops=true`;
export const STOPS_URL = `${API}/filtered-stops?onlyWithValidTrips=true`;

// ---------------------------------------------------------------- crawling

export class Crawler {
  private readonly pairMemo = new Map<string, { at: number; js: SJourney[] }>();
  /** every search answer of the run, to look a pair up again without a request */
  readonly memo = new Map<string, SJourney[]>();
  /** journeys left unexplained because a day's route allowance was used up */
  capped = 0;
  constructor(
    readonly ctx: GeneratorContext,
    readonly api: Api,
    readonly net: Network,
    readonly store: RunStore,
  ) {}

  async search(origin: City, dest: City, date: string, useMemo = false): Promise<SJourney[] | undefined> {
    const key = `${origin.id}>${dest.id}|${date}`;
    const had = this.memo.get(key);
    if (useMemo && had) return had;
    const j = await this.api.get(searchUrl(origin.id, dest.id, date), "search");
    if (j === undefined) return undefined;
    const js = parseSearch(j, date);
    this.memo.set(key, js);
    return js;
  }

  /**
   * Ask the route of every journey that is not explained by a known run, the longest first (one route then explains its
   * shorter parts). `record`: the answer counts for the sampled week (instances found on `date`).
   */
  async resolve(date: string, js: SJourney[], canRoute: () => boolean = () => true, record = false, pair?: [City, City]): Promise<void> {
    const key = pair ? `${pair[0].id}>${pair[1].id}` : undefined;
    const order = [...js].sort((a, b) => a.legs.length - b.legs.length || b.arr - b.dep - (a.arr - a.dep) || a.dep - b.dep);
    for (const j of order) {
      const known = j.legs.map((l) => this.store.explains(date, l, record));
      if (known.every(Boolean)) {
        if (key && j.legs.length === 1) known[0]!.pairs.add(key);
        continue;
      }
      if (!canRoute()) {
        this.capped++;
        continue;
      }
      const raw = await this.api.get(routeUrl(j.id), "route");
      if (raw === undefined) {
        if (this.api.exhausted) return;
        continue;
      }
      const pieces = parseRoute(raw, date);
      if (pieces.length !== j.legs.length) fail(`route of a journey with ${j.legs.length} legs has ${pieces.length} legs`);
      pieces.forEach((p, i) => {
        const l = j.legs[i]!, first = p.calls[0]!, last = p.calls[p.calls.length - 1]!;
        if (first.name !== l.depStop || first.dep !== l.dep || last.name !== l.destStop || last.arr !== l.arr || p.line !== l.line)
          fail(`route leg ${p.code} ${p.line} (${first.name} ${first.dep} → ${last.name} ${last.arr}) does not match the searched leg ${JSON.stringify(l)} of journey ${JSON.stringify(j.legs)}`);
        const run = this.store.add(date, p, record);
        if (key && j.legs.length === 1) run.pairs.add(key);
      });
    }
  }

  /** Journeys hub → every city and every city → hub, farthest first (long runs explain the shorter parts that follow). */
  async sweep(hub: City, date: string, targets: City[] = this.net.cities): Promise<void> {
    const far = (c: City) => (hub.pos && c.pos ? haversineKm(hub.pos[0], hub.pos[1], c.pos[0], c.pos[1]) : -1);
    const others = targets.filter((c) => c !== hub).sort((a, b) => far(b) - far(a) || a.id - b.id);
    const jobs: [City, City][] = [...others.map((c): [City, City] => [hub, c]), ...others.map((c): [City, City] => [c, hub])];
    await this.runJobs(jobs, date);
  }

  /** Search the given city pairs (two at a time) and resolve what they list; `record`: sampled-week searches. */
  async runJobs(jobs: [City, City][], date: string, maxRoutes = Infinity, record = false): Promise<void> {
    const routes0 = this.api.routes;
    await Promise.all(
      Array.from({ length: this.api.o.inFlight }, async () => {
        while (jobs.length && !this.api.exhausted) {
          const [o, d] = jobs.shift()!;
          // a pair already searched on this day (the discovery): its journey ids have expired, nothing is routed again
          const had = record && this.memo.has(`${o.id}>${d.id}|${date}`);
          const js = await this.search(o, d, date, record);
          if (js) await this.resolve(date, js, () => !had && this.api.routes - routes0 < maxRoutes, record, [o, d]);
        }
      }),
    );
  }

  /**
   * "Casablanca-Tafraout", "Fes-Tanger Via Chefchaouen", "Casa Ainsebaa-Dakhla" → the cities at the two ends, or null. A
   * place is a city name, a stop name or one of the spellings in TRIP_ALIASES.
   */
  splitTrip(tripName: string): [City, City] | null {
    const parts = tripName.replace(/\s+via\s+.*$/i, "").split("-");
    const place = (t: string): City | undefined => {
      const n = norm(t);
      return this.net.cityByNorm.get(n) ?? this.net.stopByNorm.get(n)?.city ?? this.net.cityByNorm.get(norm(TRIP_ALIASES[n] ?? "")) ?? this.net.stopByNorm.get(norm(TRIP_ALIASES[n] ?? ""))?.city;
    };
    for (let i = 1; i < parts.length; i++) {
      const a = place(parts.slice(0, i).join("-")), b = place(parts.slice(i).join("-"));
      if (a && b) return [a, b];
    }
    return null;
  }

  /** First and last call lie in the cities of the trip name (a run that starts or ends earlier is only known in part). */
  isComplete(r: Run): boolean | null {
    const t = this.splitTrip(r.tripName);
    if (!t) return null;
    return this.net.stopByName.get(r.calls[0]!.name)?.city === t[0] && this.net.stopByName.get(r.calls[r.calls.length - 1]!.name)?.city === t[1];
  }

  /**
   * Runs known only in part (found from a stop in the middle of the run) are completed by searching the cities of their
   * trip name and asking the route of the journey that spans the known part and reaches further. The searched day is the
   * day the run was found on, else the day before (the run may have left the day before it was seen).
   */
  async complete(runs: Run[] = this.store.runs): Promise<{ incomplete: number; done: number; left: number }> {
    const todo = runs.filter((r) => this.isComplete(r) === false);
    let done = 0;
    for (const r of todo) {
      if (this.api.exhausted) break;
      const [a, b] = this.splitTrip(r.tripName)!;
      for (const date of [r.born, addDays(r.born, -1), addDays(r.born, -2)]) {
        if (this.isComplete(r) !== false || this.api.exhausted) break;
        const k = `${date}|${a.id}>${b.id}`;
        const memo = this.pairMemo.get(k);
        let js = memo && Date.now() - memo.at < 5 * 60_000 ? memo.js : undefined;
        if (!js) {
          js = await this.search(a, b, date);
          if (!js) continue;
          this.pairMemo.set(k, { at: Date.now(), js });
        }
        // single legs of the line that reach beyond the known part: either they share a call with it (same time of day), or
        // they span it (leave before its first call and arrive after its last, on the day of the run or a neighbour)
        const f = firstTime(r), l = r.calls[r.calls.length - 1]!.arr ?? r.calls[r.calls.length - 1]!.dep!;
        const cands = js
          .flatMap((j) => (j.legs.length === 1 && j.legs[0]!.line === r.line ? [{ j, l: j.legs[0]! }] : []))
          .flatMap(({ j, l: leg }) => {
            const ci = r.calls.findIndex((c) => c.name === leg.depStop && c.dep !== undefined && mod(c.dep) === mod(leg.dep));
            const ki = r.calls.findIndex((c) => c.name === leg.destStop && c.arr !== undefined && mod(c.arr) === mod(leg.arr));
            if (ci >= 0 || ki >= 0) {
              if (ci >= 0 && ki >= 0 && (ki <= ci || leg.dep - r.calls[ci]!.dep! !== leg.arr - r.calls[ki]!.arr!)) return [];
              const delta = ci >= 0 ? leg.dep - r.calls[ci]!.dep! : leg.arr - r.calls[ki]!.arr!;
              return leg.dep - delta < f || leg.arr - delta > l ? [{ j, rank: 0, size: leg.arr - leg.dep }] : [];
            }
            for (const n of [0, -1, 1]) if (leg.dep <= f + n * DAY && leg.arr >= l + n * DAY) return [{ j, rank: 1, size: f + n * DAY - leg.dep + (leg.arr - l - n * DAY) }];
            return [];
          })
          .sort((x, y) => x.rank - y.rank || (x.rank === 0 ? y.size - x.size : x.size - y.size))
          .map((x) => x.j);
        for (const j of cands.slice(0, 3)) {
          const raw = await this.api.get(routeUrl(j.id), "route");
          if (raw === undefined) break;
          parseRoute(raw, date).forEach((p, i) => {
            const run = this.store.add(date, p);
            if (i === 0) run.pairs.add(`${a.id}>${b.id}`);
          });
          if (this.isComplete(r) !== false) break;
        }
      }
      if (this.isComplete(r) !== false) done++;
    }
    return { incomplete: todo.length, done, left: todo.length - done };
  }
}

// ---------------------------------------------------------------- the sampled week

/** Service days (epoch day numbers) of a run's instances found by the sampled-week searches. */
export function serviceDays(r: Run, sample: string[]): number[] {
  return [...new Set(sample.flatMap((d) => [...(r.seen.get(d) ?? [])].map((k) => r.refDay + k)))].sort((a, b) => a - b);
}
/** 0 = Monday … 6 = Sunday → the weekday mask of a run: the weekdays of the service days of its instances found in the sampled week. */
export function maskOf(r: Run, sample: string[]): boolean[] {
  const m = [false, false, false, false, false, false, false];
  for (const day of serviceDays(r, sample)) m[isoWeekday(dateOfEpochDay(day))] = true;
  return m;
}
export const maskText = (m: boolean[]) => m.map((x) => (x ? "1" : "0")).join("");

export interface CoverPair {
  a: City;
  b: City;
  runs: Run[];
}

/** The cities a run calls in, in order (stops the API does not list as searchable are skipped). */
export function citiesOf(r: Run, net: Network): City[] {
  const out: City[] = [];
  for (const c of r.calls) {
    const city = net.stopByName.get(c.name)?.city;
    if (city && out[out.length - 1] !== city && !out.includes(city)) out.push(city);
  }
  return out;
}

/**
 * Few city pairs whose searches show every run: a search of (A, B) lists a run when one of its stop pairs in A and B is for
 * sale, which is only known from a search that did list it (`Run.pairs`, seen in the discovery). A greedy cover over those
 * pairs replaces one search per terminus pair. Runs no search listed directly have no pair (`uncovered`).
 */
export function coverPairs(runs: Run[], net: Network): { pairs: CoverPair[]; uncovered: Run[] } {
  const city = new Map(net.cities.map((c) => [c.id, c]));
  const by = new Map<string, CoverPair>();
  for (const r of runs)
    for (const k of r.pairs) {
      const [a, b] = k.split(">").map((x) => city.get(Number(x))!);
      (by.get(k) ?? by.set(k, { a: a!, b: b!, runs: [] }).get(k)!).runs.push(r);
    }
  const left = new Set(runs.filter((r) => r.pairs.size));
  const uncovered = runs.filter((r) => !r.pairs.size);
  const pairs: CoverPair[] = [];
  while (left.size) {
    let best: CoverPair | undefined, bestN = 0;
    for (const p of by.values()) {
      const n = p.runs.reduce((a, r) => a + (left.has(r) ? 1 : 0), 0);
      if (n > bestN || (n === bestN && best && n > 0 && (p.a.id - best.a.id || p.b.id - best.b.id) < 0)) (best = p), (bestN = n);
    }
    if (!best) break;
    pairs.push(best);
    for (const r of best.runs) left.delete(r);
  }
  return { pairs, uncovered };
}

// ---------------------------------------------------------------- runs → trips

/** Morocco with Western Sahara (Lagouira to Saïdia, Tanger to Guerguerat). */
export const BOX = { south: 20.5, north: 36.2, west: -17.5, east: -0.5 };
export const inBox = (lat: number, lon: number) => lat >= BOX.south && lat <= BOX.north && lon >= BOX.west && lon <= BOX.east;

const slugOf = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();

export interface BuildInput {
  runs: Run[];
  net: Network;
  sample: string[];
  /** service from `from` to `to` (the build window, cut at the sales horizon) */
  from: string;
  to: string;
  geo: GeocodeStore;
  splitTrip(tripName: string): [City, City] | null;
  warn(m: string): void;
}

export interface BuildStats {
  runs: number;
  noService: number;
  backwards: number;
  hops: number;
  repeated: number;
  unlocated: number;
  skippedStops: Map<string, number>;
}

/** The GTFS feed from the runs and their weekly masks. */
export function buildFeed(o: BuildInput): { feed: GtfsFeed; stats: BuildStats; dropped: string[] } {
  const feed: GtfsFeed = {
    agency: [{ agency_id: "ctm", agency_name: "CTM (Compagnie de Transports au Maroc)", agency_url: SITE_URL, agency_timezone: "Africa/Casablanca", agency_lang: "fr" }],
    stops: [],
    routes: [],
    trips: [],
    stopTimes: [],
    services: new Map(),
    info: { publisher: "EuroTrainBusMap (generated from the CTM booking site)", publisherUrl: SITE_URL, lang: "fr", sourceUrl: BOOKING_URL },
  };
  const stats: BuildStats = { runs: 0, noService: 0, backwards: 0, hops: 0, repeated: 0, unlocated: 0, skippedStops: new Map() };
  const dropped: string[] = [];
  const stopIds = new Map<string, string>();
  const services = new Map<string, string>();
  const days = o.from <= o.to ? dateRange(o.from, o.to) : [];
  const sorted = [...o.runs].sort((a, b) => a.line.localeCompare(b.line) || a.code.localeCompare(b.code) || (a.calls[0]!.dep ?? 0) - (b.calls[0]!.dep ?? 0));
  for (const r of sorted) {
    stats.runs++;
    const label = `${r.tripName} ${r.code} ${hm(r.calls[0]!.dep ?? 0)}`;
    const mask = maskOf(r, o.sample);
    const dates = days.filter((d) => mask[isoWeekday(d)]);
    if (!dates.length) {
      stats.noService++;
      continue;
    }
    // calls with positions: the geocode store (a reviewed entry wins: a correction), else the API's coordinates, else missing
    let unlocated = false, skippedHere = false;
    const calls: { call: Call; name: string; key: string; t: number; arr: number; coord: [number, number] }[] = [];
    for (const c of r.calls) {
      const st = o.net.stopByName.get(c.name);
      const e = o.geo.lookup(c.name);
      let coord: [number, number] | undefined;
      if (e && e.checked) {
        const used = o.geo.resolve(c.name, `run ${label}`);
        if (used?.skip) {
          stats.skippedStops.set(c.name, (stats.skippedStops.get(c.name) ?? 0) + 1);
          skippedHere = true;
          continue;
        }
        if (used) coord = [used.lat, used.lon];
      } else if (st?.coord && inBox(st.coord[0], st.coord[1])) coord = st.coord;
      else {
        const used = o.geo.resolve(c.name, `run ${label}`);
        if (used?.skip) {
          stats.skippedStops.set(c.name, (stats.skippedStops.get(c.name) ?? 0) + 1);
          skippedHere = true;
          continue;
        }
        if (used) coord = [used.lat, used.lon];
      }
      if (!coord) {
        unlocated = true;
        continue;
      }
      const dep = c.dep ?? c.arr!, arr = c.arr ?? c.dep!;
      calls.push({ call: c, name: st?.name ?? c.name, key: st ? `s${st.id}` : `x-${slugOf(c.name)}`, t: dep, arr, coord });
    }
    if (unlocated) {
      stats.unlocated++;
      dropped.push(label);
      continue;
    }
    if (calls.length < 2 && skippedHere) continue; // stops left out on purpose (reviewed "skip" entries) leave nothing to run
    if (calls.length < 2 || new Set(calls.map((c) => c.key)).size !== calls.length) {
      stats.repeated++;
      o.warn(`run ${label}: calls twice at one stop or has fewer than two stops, skipped`);
      dropped.push(label);
      continue;
    }
    let prev = -1, bad = false;
    for (const c of calls) {
      if (c.arr < prev || c.t < c.arr) bad = true;
      prev = c.t;
    }
    if (bad || calls[calls.length - 1]!.arr <= calls[0]!.t) {
      stats.backwards++;
      o.warn(`run ${label}: times go backwards, skipped`);
      dropped.push(label);
      continue;
    }
    let hop = "";
    for (let i = 1; i < calls.length && !hop; i++) {
      const a = calls[i - 1]!, b = calls[i]!;
      const km = haversineKm(a.coord[0], a.coord[1], b.coord[0], b.coord[1]);
      const min = b.arr - a.t;
      if ((km / (min + HOP_SLACK_MIN)) * 60 > MAX_KMH) hop = `${a.name} → ${b.name}: ${km.toFixed(0)} km in ${min} min`;
    }
    if (hop) {
      stats.hops++;
      o.warn(`run ${label}: impossible hop ${hop}, skipped`);
      dropped.push(label);
      continue;
    }
    const dkey = dates.join(",");
    let sid = services.get(dkey);
    if (!sid) services.set(dkey, (sid = `s${services.size + 1}`));
    feed.services.set(sid, dates);
    const trip = o.splitTrip(r.tripName);
    const via = /\s+via\s+(.+)$/i.exec(r.tripName)?.[1];
    const rname = trip ? `${trip[0].name} – ${trip[1].name}${via ? ` via ${via}` : ""}` : r.tripName;
    const rid = slugOf(r.tripName) || slugOf(r.code);
    if (!feed.routes.some((x) => x.route_id === rid)) feed.routes.push({ route_id: rid, agency_id: "ctm", route_short_name: "", route_long_name: rname, route_type: 200, route_url: BOOKING_URL });
    const tid = `${r.code}:${hm(calls[0]!.t)}:${maskText(mask)}`;
    let id = tid, n = 1;
    while (feed.trips.some((t) => t.trip_id === id)) id = `${tid}:${++n}`;
    feed.trips.push({ route_id: rid, service_id: sid, trip_id: id, trip_headsign: calls[calls.length - 1]!.name });
    calls.forEach((c, i) => {
      if (!stopIds.has(c.key)) {
        stopIds.set(c.key, c.name);
        feed.stops.push({ stop_id: c.key, stop_name: c.name, stop_lat: c.coord[0], stop_lon: c.coord[1] });
      }
      feed.stopTimes.push({ trip_id: id, stop_sequence: i + 1, stop_id: c.key, arr: c.arr, dep: c.t });
    });
  }
  const used = stats.runs - stats.noService;
  const lost = stats.backwards + stats.hops + stats.repeated;
  if (used && lost / used > MAX_DROPPED) fail(`${lost} of ${used} runs dropped (backwards times ${stats.backwards}, impossible hops ${stats.hops}, repeated or single stops ${stats.repeated}): the run lists were misread`);
  return { feed, stats, dropped };
}

// ---------------------------------------------------------------- the run

/**
 * Last day of the window the API still sells: probes the busiest pair at the window's end, then bisects. A day beyond the
 * sales horizon is not quite empty: the legs of a run that left on the last day of sale after midnight are still listed
 * (Casablanca – Rabat on 2027-01-01 lists 1 journey against 46 the day before), so a day counts as sold when its answer
 * has at least a quarter of the journeys the pair had on the first sampled day.
 */
async function salesHorizon(cr: Crawler, pair: CoverPair, firstDay: string, lastGood: string, windowEnd: string): Promise<string> {
  const base = (await cr.search(pair.a, pair.b, firstDay, true))?.length ?? 0;
  const need = Math.max(2, Math.ceil(base / 4));
  const has = async (d: string): Promise<boolean | undefined> => {
    const js = await cr.search(pair.a, pair.b, d);
    return js ? js.length >= need : undefined;
  };
  if (windowEnd <= lastGood) return windowEnd;
  const top = await has(windowEnd);
  if (top === undefined || top) return windowEnd;
  let lo = dayNumber(lastGood), hi = dayNumber(windowEnd); // lo answers, hi does not
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await has(addDays(lastGood, mid - dayNumber(lastGood)));
    if (r === undefined) break;
    if (r) lo = mid;
    else hi = mid;
  }
  return addDays(lastGood, lo - dayNumber(lastGood));
}

export default defineGenerator({
  id: "ma-ctm",
  description: "CTM (Morocco's national intercity coaches) from the unauthenticated JSON API of its booking site (booking.ctm.ma): runs found by sweeping hub cities, weekdays from a sampled week.",
  sourceUrl: BOOKING_URL,
  generate: (ctx: GeneratorContext) => generateFrom(ctx),
});

export interface Crawl {
  api: Api;
  cr: Crawler;
  net: Network;
  store: RunStore;
  sample: string[];
  /** last service day (the build window cut at the sales horizon) */
  to: string;
  from: string;
  pairs: CoverPair[];
  /** the spot checks: per later day, the runs compared and the differences found */
  spot: { date: string; runs: number; missing: number; notSold: number; extra: number; unknown: number }[];
  t0: number;
}

/** The generator's run (tests: other limits, no pacing). */
export async function generateFrom(ctx: GeneratorContext, opts: Partial<Options> = {}): Promise<GtfsFeed> {
  const o: Options = { ...DEFAULTS, ...opts };
  const c = await crawl(ctx, o);
  return finish(ctx, o, c);
}

/** Everything that asks the API: the stop list, the runs of the first sampled day, the sampled week, the spot checks. */
export async function crawl(ctx: GeneratorContext, o: Options): Promise<Crawl> {
  const t0 = Date.now();
  const api = new Api(ctx, o);
  const rawStops = await api.get(STOPS_URL, "stops");
  if (rawStops === undefined) return fail("filtered-stops: no answer");
  const net = parseNetwork(rawStops, o.minCities);
  const win = serviceWindow(ctx.startDate, ctx.days);
  const sample = dateRange(addDays(ctx.startDate, SAMPLE_OFFSET), addDays(ctx.startDate, SAMPLE_OFFSET + 6));
  const d0 = sample[0]!;
  const store = new RunStore();
  const cr = new Crawler(ctx, api, net, store);
  api.cap = Math.floor(o.maxRequests * DISCOVERY_SHARE);
  const phase = (what: string, r0: number, n0: number) => ctx.log(`${what}: ${api.requests - r0} requests, ${store.runs.length - n0} new runs (${store.runs.length} runs, ${api.requests} requests, ${Math.round((Date.now() - t0) / 1000)} s)`);

  // 1. hubs: every city against the hub and the hub against every city, on the first sampled day
  for (const name of o.hubs) {
    const hub = net.cityByNorm.get(norm(name)) ?? fail(`hub city "${name}" is not in filtered-stops`);
    const r0 = api.requests, n0 = store.runs.length;
    await cr.sweep(hub, d0);
    phase(`hub ${hub.name}`, r0, n0);
  }
  if (!store.runs.length && !api.exhausted) fail(`no runs found on ${d0} (the search answers are empty: is the day beyond the sales horizon?)`);

  // 2. closure: a city that no run calls at is searched against its nearest neighbours
  const served = () => new Set(store.runs.flatMap((r) => citiesOf(r, net)));
  {
    const s = served();
    const idle = net.cities.filter((c) => !s.has(c));
    if (idle.length && !api.exhausted) {
      const r0 = api.requests, n0 = store.runs.length;
      const jobs: [City, City][] = [];
      for (const c of idle) {
        const near = net.cities
          .filter((x) => x !== c && c.pos && x.pos)
          .sort((a, b) => haversineKm(c.pos![0], c.pos![1], a.pos![0], a.pos![1]) - haversineKm(c.pos![0], c.pos![1], b.pos![0], b.pos![1]))
          .slice(0, CLOSURE_NEIGHBOURS);
        for (const x of near) jobs.push([c, x], [x, c]);
      }
      await cr.runJobs(jobs, d0);
      phase(`closure for ${idle.length} cities without a run (${idle.map((c) => c.name).join(", ")})`, r0, n0);
      const still = net.cities.filter((c) => !served().has(c));
      if (still.length) ctx.log(`${still.length} cities have no run on ${d0}: ${still.map((c) => c.name).join(", ")}`);
    }
  }

  // 3. runs known only in part
  {
    const r0 = api.requests, n0 = store.runs.length;
    const c = await cr.complete();
    phase(`completion of ${c.incomplete} partial runs (${c.done} done, ${c.left} left)`, r0, n0);
  }
  const lines = new Set(store.runs.map((r) => r.line));
  ctx.log(`${store.runs.length} runs, ${lines.size} line numbers on ${d0}`);
  if (store.runs.length < o.minRuns && !api.exhausted) fail(`only ${store.runs.length} runs found (expected at least ${o.minRuns}): API answer incomplete or changed`);

  // 4. the sampled week: the cover pairs on the other six days. A run no search listed directly (found only as a leg of a
  // journey with a change) gets the pair of its two ends, if that search lists it
  {
    const loose = store.runs.filter((r) => !r.pairs.size);
    const jobs = new Map<string, [City, City]>();
    for (const r of loose) {
      const a = net.stopByName.get(r.calls[0]!.name)?.city, b = net.stopByName.get(r.calls[r.calls.length - 1]!.name)?.city;
      if (a && b && a !== b) jobs.set(`${a.id}>${b.id}`, [a, b]);
    }
    if (jobs.size && !api.exhausted) {
      const r0 = api.requests, n0 = store.runs.length;
      await cr.runJobs([...jobs.values()], d0);
      phase(`end-to-end pairs of ${loose.length} runs no search listed directly`, r0, n0);
    }
  }
  if (api.exhausted) ctx.warn(`request budget for the discovery (${api.cap} of ${o.maxRequests}) used up on ${d0}: ${store.runs.length} runs found, runs of cities not searched yet are missing`);
  api.cap = o.maxRequests;
  api.exhausted = false;
  const { pairs, uncovered } = coverPairs(store.runs, net);
  ctx.log(`${pairs.length} city pairs cover ${store.runs.length - uncovered.length} runs${uncovered.length ? `; ${uncovered.length} runs are listed by no pair search` : ""}`);
  if (uncovered.length && !api.exhausted) ctx.warn(`${uncovered.length} runs are listed by no search of a city pair, so their days are unknown and they are left out: ${uncovered.slice(0, 6).map(describe).join("; ")}${uncovered.length > 6 ? "; …" : ""}`);
  let to = win.to;
  if (pairs.length && !api.exhausted) to = await salesHorizon(cr, pairs[0]!, d0, sample[6]!, win.to);
  if (to < win.to) ctx.warn(`the API sells up to ${to}; service ends there (the build window runs to ${win.to})`);
  const coverJobs = (ps: CoverPair[]): [City, City][] => ps.map((p) => [p.a, p.b]);
  {
    // every sampled day, the cover pairs: a run is found on a day when one of the journeys of its pair is one of its legs
    const r0 = api.requests, n0 = store.runs.length;
    for (const d of sample) {
      if (api.exhausted) break;
      await cr.runJobs(coverJobs(pairs), d, MAX_ROUTES_PER_DAY, true);
    }
    phase(`sampled week ${sample[0]} … ${sample[6]}`, r0, n0);
    // runs first seen on another day were not searched on the days before: complete them, search their pairs on all days
    for (let round = 0; round < 2 && store.runs.length > n0 && !api.exhausted; round++) {
      const fresh = store.runs.slice(n0).filter((r) => sample.some((d) => !r.seen.has(d)));
      if (!fresh.length) break;
      await cr.complete(fresh);
      const cover = coverPairs(fresh, net).pairs;
      for (const d of sample) if (!api.exhausted) await cr.runJobs(coverJobs(cover), d, MAX_ROUTES_PER_DAY, true);
    }
    if (cr.capped) ctx.warn(`${cr.capped} journeys of the sampled week were left unexplained (route allowance of ${MAX_ROUTES_PER_DAY} per day used up): the other days differ much from the first`);
  }

  // 5. spot checks later in the window: do the busiest pairs show what the weekly masks predict? (A line the API does not
  // offer that far ahead at all is not a difference: some lines are sold 30 days ahead, others 60.)
  const spot: Crawl["spot"] = [];
  if (!api.exhausted) {
    for (const off of SPOT_OFFSETS) {
      const d = addDays(d0, off);
      if (d > to || api.exhausted) continue;
      const top = [...pairs].sort((a, b) => b.runs.length - a.runs.length).slice(0, SPOT_PAIRS);
      const known = new Set(store.runs);
      await cr.runJobs(coverJobs(top), d, MAX_ROUTES_PER_DAY, true);
      const missing: string[] = [], notSold: string[] = [], extra: string[] = [];
      const covered = new Set(top.flatMap((p) => p.runs));
      for (const r of covered) {
        const first = sample.find((x) => r.seen.get(x)?.size);
        if (!first) continue;
        const j = epochDay(first) - (r.refDay + [...r.seen.get(first)!][0]!); // the boarding stop's day offset: searched day − service day
        const expected = maskOf(r, sample)[isoWeekday(dateOfEpochDay(epochDay(d) - j))]!, found = !!r.seen.get(d)?.size;
        if (expected && !found) {
          const lineSold = top.some((p) => r.pairs.has(`${p.a.id}>${p.b.id}`) && (cr.memo.get(`${p.a.id}>${p.b.id}|${d}`) ?? []).some((jy) => jy.legs.some((l) => l.line === r.line)));
          (lineSold ? missing : notSold).push(describe(r));
        }
        if (!expected && found) extra.push(describe(r));
      }
      const unknown = store.runs.filter((r) => !known.has(r)).map(describe);
      spot.push({ date: d, runs: covered.size, missing: missing.length, notSold: notSold.length, extra: extra.length, unknown: unknown.length });
      ctx.log(`spot check ${d}: ${covered.size} runs on ${top.length} pairs, ${missing.length} expected but not found, ${notSold.length} of lines not sold that far ahead, ${extra.length} found on a weekday the mask lacks, ${unknown.length} runs not known before`);
      if (missing.length || extra.length || unknown.length)
        ctx.warn(
          `the sampled week does not predict ${d}: ${missing.length} of ${covered.size} runs expected but not found though their line is offered (${missing.slice(0, 3).join("; ")}), ${extra.length} found on a weekday their mask lacks (${extra.slice(0, 3).join("; ")}), ${unknown.length} unknown runs (${unknown.slice(0, 3).join("; ")}); service follows the sampled week anyway`,
        );
    }
  }
  return { api, cr, net, store, sample, to, from: win.from, pairs, spot, t0 };
}

/** The feed from the crawl; reports at the end what the crawl cost. */
export async function finish(ctx: GeneratorContext, o: Options, c: Crawl): Promise<GtfsFeed> {
  const { api, cr, net, store, sample, to, from, t0 } = c;
  if (api.exhausted) ctx.warn(`request budget of ${o.maxRequests} reached: finished with ${store.runs.length} runs found so far (weekday masks may be incomplete)`);
  if (api.failures > Math.max(10, api.requests * 0.03)) fail(`${api.failures} of ${api.requests} requests failed`);

  // 6. the feed
  const geo = o.geo ?? (await GeocodeStore.load("ma-ctm"));
  const runs = store.runs.filter((r) => r.calls.length >= 2);
  const { feed, stats, dropped } = buildFeed({ runs, net, sample, from, to, geo, splitTrip: (t) => cr.splitTrip(t), warn: ctx.warn });
  observeRuns(ctx, runs, sample);
  if (stats.skippedStops.size) ctx.warn(`${stats.skippedStops.size} stops left out on purpose (skip entries in data/geocodes/ma-ctm.json): ${[...stats.skippedStops].map(([k, n]) => `${k} ×${n}`).join(", ")}`);
  const partial = runs.filter((r) => cr.isComplete(r) === false);
  if (partial.length) ctx.warn(`${partial.length} runs are known only in part (their first or last stop is not in the cities of their trip name; the API lists no longer journey): ${partial.slice(0, 6).map(describe).join("; ")}${partial.length > 6 ? "; …" : ""}`);
  const noTrip = runs.filter((r) => cr.isComplete(r) === null);
  if (noTrip.length > runs.length * MAX_DROPPED) fail(`${noTrip.length} of ${runs.length} runs have a trip name whose ends are no city or stop (${[...new Set(noTrip.map((r) => r.tripName))].slice(0, 4).join("; ")}): the trip names changed`);
  if (noTrip.length) ctx.warn(`${noTrip.length} runs have a trip name whose ends are no city or stop (new spelling? see TRIP_ALIASES): ${[...new Set(noTrip.map((r) => r.tripName))].slice(0, 6).join("; ")}`);
  ctx.log(
    `${api.requests} requests (${api.searches} searches, ${api.routes} routes), ${Math.round((Date.now() - t0) / 1000)} s: ${stats.runs} runs, ${stats.noService} without a day in the window, ${stats.backwards} backwards, ${stats.hops} impossible hops, ${stats.repeated} repeated stops, ${stats.unlocated} with a stop that needs geocoding; ${feed.trips.length} trips, ${feed.routes.length} routes, ${feed.stops.length} stops`,
  );
  geo.finish(ctx, dropped.length ? [`${dropped.length} runs calling at ${geo.missing.map((m) => m.name).join(", ")}`] : [], feed.trips.length);
  return feed;
}

/** One observed page per line number: its runs with masks, stops and times (no prices, seats or journey ids). */
export function observeRuns(ctx: GeneratorContext, runs: Run[], sample: string[]): void {
  const t = (m: number | undefined) => (m === undefined ? "" : `${hm(m)}${m >= 1440 ? `+${Math.floor(m / 1440)}` : ""}`);
  const by = new Map<string, string[]>();
  for (const r of runs) {
    const row = `${r.code} ${r.tripName} ${maskText(maskOf(r, sample))}: ${r.calls.map((c) => `${c.name} ${c.arr !== undefined && c.arr !== c.dep ? t(c.arr) + "/" : ""}${t(c.dep)}`).join(" – ")}`;
    (by.get(r.line) ?? by.set(r.line, []).get(r.line)!).push(row);
  }
  for (const [line, rows] of [...by].sort(([a], [b]) => a.localeCompare(b))) ctx.observe(`line-${line}`, rows.sort().join("\n"));
}
