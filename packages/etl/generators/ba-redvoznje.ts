/**
 * redvoznje.ba: intercity bus lines of Bosnia and Herzegovina (and the diaspora coaches leaving it) from the open
 * JSON API of redvoznje.ba, which collects the departure boards of the country's bus stations.
 *
 * SOURCE
 *   https://redvoznje.ba/api/ (human documentation), https://redvoznje.ba/api/v1.json (root),
 *   https://redvoznje.ba/api/v1/openapi.json (OpenAPI 3.1). Read-only static JSON on a CDN, no key; licence CC BY 4.0
 *   ("Cite the operator as well as redvoznje.ba"); robots.txt "User-agent: * / Allow: /". Data sources of the site:
 *   https://redvoznje.ba/izvori-podataka/ (the stations' boards on *.autobuskastanica.com, buskarta.ba, ŽFBiH, ŽRS).
 *
 * SHAPE OF THE SOURCE (live, checked 2026-10-19; dataset generated_at 2026-09-28T14:00Z)
 *   /api/v1.json        {"api_version":"v1", "license":{"name":"CC BY 4.0", …}, "data_last_confirmed":"2026-09-28",
 *                        "counts":{"routes":2912,"bus_routes":2816,"train_routes":96,"stations":100,"operators":50,…}}
 *   /api/v1/health.json {"status":"degraded","data_last_confirmed":"2026-09-28","stale_after_days":21,
 *                        "sources":[{"source":"autobuskastanica","departures":7498,"last_confirmed":"2026-09-28",
 *                        "age_days":0,"status":"fresh"}, {"source":"buskarta",…,"last_confirmed":"2026-09-28"},
 *                        {"source":"buskarta-intl","departures":309,"last_confirmed":"2026-08-16","status":"stale"},
 *                        {"source":"zfbh",…}, {"source":"zrs",…}]}
 *   /api/v1/stations.json  100 cities with a board: {"slug":"sarajevo","name":"Sarajevo","coordinates":{"lat":43.85881,
 *                        "lon":18.39688,"source":"https://www.openstreetmap.org/way/23724409"},
 *                        "api_url":"/api/v1/stations/sarajevo.json",…}; 49 of them have "coordinates": null.
 *   /api/v1/stations/{city}.json  the board: "departures":[{"mode":"bus","departure":"05:05","arrival":"10:15",
 *                        "days":"0111111","operator":"Globus Tourist Doboj","to":{"slug":"trebinje",…},
 *                        "url":"/autobus/sarajevo-trebinje/"}, …] – every service once, at its furthest stop.
 *   /api/v1/routes/bus/{from}-{to}.json  one city pair: "route":{…,"last_confirmed":"2026-09-28"},
 *                        "html_url":"https://redvoznje.ba/autobus/kakanj-sarajevo/",
 *                        "departures":[{"departure":"04:05","arrival":"05:05","days":"0010101","operator":"Globus
 *                        Tourist Doboj","source":"autobuskastanica","source_url":"https://kakanj.autobuskastanica.com/
 *                        polasci-dolasci",…}], and "lines" – the whole run of the services that have one:
 *                        {"operator":"Globus Tourist Doboj","days":"0010101","source":"autobuskastanica","stops":[
 *                         {"name":"Banja Luka","city":"banja-luka","country":"Bosna i Hercegovina","time":"00:05",
 *                          "day_offset":0,"border":false}, … {"name":"Sarajevo","city":"sarajevo",…,"time":"05:05"},
 *                         … {"name":"Trebinje","city":"trebinje",…,"time":"10:15","day_offset":0,"border":false}]}
 *                        International lines carry border crossings as stops with "border":true and "city":null
 *                        ("Stara Gradiška", "Macelj", "Spielfeld", "Passau") and small places with "city":null but
 *                        "border":false ("Lončari", "Petrovac", "Makarska" riviera villages, "Arnhem").
 *   `days` is a Mon..Sun mask ("1111100" = Monday–Friday); times are local, HH:MM, `day_offset` counts midnights.
 *   One line appears in every pair file it serves (2,816 bus pair files hold 7,467 line entries = 262 lines).
 *
 * WHAT THIS SCRIPT DOES
 *   1. v1.json, health.json, stations.json, operators.json; fails on a changed API version / licence / shape.
 *   2. The station boards (100 requests) give the pair "board city → furthest stop" of every service; only those pair
 *      files are read (about 650 requests instead of 2,816; 4 short lines of 262 are missed that way – Sarajevo – Pale,
 *      also in the Centrotrans GTFS). Four requests at a time, each URL once per run.
 *   3. Bus lines only (the `train` files are ŽFBiH / ŽRS: ba-zfbih covers them). Border pseudo-stops are dropped, a
 *      line repeated across pair files is kept once, coordinates come from stations.json, else from CITY_COORDS (by
 *      city slug) or NAME_COORDS (by stop name) below (GeoNames, checked by hand). A stop without coordinates is left
 *      out (warning); a line whose hops are impossible (> MAX_KMH straight line) or whose times go backwards is
 *      skipped (warning). Joint operations keep the operator text ("Centrotrans Sarajevo/Transturist Tuzla").
 *   4. Duplicates inside the source (the same bus from two boards, or two masks of one bus): two lines sharing at least
 *      two (city, time) calls with overlapping days are one; the one with more stops stays and takes the other's days.
 *      Duplicates with other feeds of the build are left to the build: the cross-feed dedup (coaches against coaches,
 *      and the bus trips of ba-centrotrans, feed option dedupBus), the exclusive operators (FlixBus joint lines go:
 *      eu-flixbus is FlixBus' only source; Li Bus Livno comes from ba-livnobus, operators/livnobus.ts). This feed has
 *      the lowest dedup priority, so a copy from an operator's own GTFS wins ties.
 *   5. Service dates: the mask on every day of the build window, up to `last_confirmed + MAX_SOURCE_AGE_DAYS` of the
 *      line's source (a source that stops being re-confirmed drops out by itself). Route type 200 (coach).
 *
 * KNOWN QUIRKS
 *   - Scrape-day artefact: the boards are read on one day (data_last_confirmed 2026-09-28, a Monday); services that
 *     had already left that day before the scrape lose that weekday in their mask: Kakanj 05:00 → Sarajevo is
 *     "0111100" here and Monday–Friday in the Centrotrans GTFS (17-23), 1,487 masks are "0111111" and 1 is "1011111";
 *     every Monday-0 mask leaves before ~13:00, every Monday-1 mask after. A mask that becomes 1111111 / 1111100 /
 *     1111110 by setting the weekday of its source's last_confirmed date gets that day back (counted in the log).
 *   - The mask is taken for the day of the line's first stop (a line's mask is the same in every pair file).
 *   - Country names are not reliable for city:null stops ("Bratislava", "Brno", "Prag" are "Hrvatska", Swedish
 *     towns "Danska"); they are not used. All stops lie in the CET zone (Europe/Sarajevo).
 *   - 1,465 of 8,327 pair departures (mostly buskarta.ba and buskarta-intl) have no line; they are not used (no
 *     stops – a two-stop trip per pair would repeat one bus once per pair).
 *   - Some services appear as two lines with the same first departure but other intermediate times (Sarajevo 06:30
 *     → Orašje, Centrotrans Sarajevo/Transturist Tuzla): both are kept, the source does not say which is right.
 *   - Some lines mix two variants and their times go backwards (Kantić Touristik Tešanj Sarajevo 12:30 → Frankfurt:
 *     "Karlsruhe 10:40, Ingolstadt 08:00"; Centrotrans "Podlugovi 05:58, Ilijaš 05:08, Sarajevo 06:45"): skipped.
 *   - One slug for two places: "ostrozac" is Ostrožac near Jablanica in stations.json (OSM node 919084787) but also
 *     names Ostrožac (Cazin) on the Bihać – Velika Kladuša line, which then fails the hop check and is skipped.
 *   - Stops left out for want of a certain position: Ormanica, Bjelimići, Špionica, Duba, Ruskamen, Pećingrad.
 *
 * FAILS ON PURPOSE (the build skips the feed and keeps going) when
 *   - v1.json has another api_version or licence than "v1" / "CC BY 4.0" (re-read the terms), or any file lacks the
 *     fields above or has them in another form (`days` not 7 × 0/1, `time` not HH:MM, …);
 *   - health.json's data_last_confirmed, or the last_confirmed of a source whose lines are used, is more than
 *     MAX_SOURCE_AGE_DAYS (60) days old (the site itself calls a source stale after 21 days; 60 leaves room for a
 *     missed monthly refresh). A stale source without lines (buskarta-intl, 64 days old today) only warns;
 *   - fewer than MIN_LINES lines remain, or more than MAX_UNKNOWN_SHARE of the stops have no coordinates (new cities:
 *     extend CITY_COORDS / NAME_COORDS).
 *
 * HOW TO RE-CHECK / UPDATE
 *   - `pnpm --filter @etbm/etl run generate -- ba-redvoznje` runs it against the live API and prints the trips.
 *   - `curl -s https://redvoznje.ba/api/v1/health.json` shows the freshness; compare one pair file with the shape
 *     above (`curl -s https://redvoznje.ba/api/v1/routes/bus/kakanj-sarajevo.json | head -c 2000`).
 *   - "no coordinates for …" warnings: add the slug to CITY_COORDS (GeoNames: work/assets/geonames/places-europe.tsv.gz,
 *     by name, checked against the neighbouring stops' times) or the name to NAME_COORDS.
 *   - When the scrape-day artefact disappears (masks "0111111" become rare), REPAIRABLE can go.
 *   - Tests: test/generators.test.ts with the trimmed API copy in test/fixtures/redvoznje/.
 */
import { defineGenerator, GeneratorError, type GeneratorContext } from "../src/generators/types.ts";
import { addDays, dateRange, haversineKm, isoWeekday, parseHm, type GtfsFeed } from "../src/generators/gtfs.ts";
import { serviceWindow } from "../src/generators/registry.ts";

export const SITE_URL = "https://redvoznje.ba/";
export const API = "https://redvoznje.ba/api/v1";
/** A line source (or the dataset) not re-confirmed for longer than this fails the generator. */
export const MAX_SOURCE_AGE_DAYS = 60;
/** Fewer lines than this: the API answered with much less than usual (262 lines in Oct 2026). */
export const MIN_LINES = 100;
/** Share of calls (after border stops) without coordinates above which the source fails. */
export const MAX_UNKNOWN_SHARE = 0.05;
/**
 * Straight-line speed between two calls above which a line is skipped (wrong coordinates or times); the minutes get
 * one added for the rounding of the times (3 km "in 1 min" between Olovske Luke and Olovo is fine).
 */
export const MAX_KMH = 130;
/** Parallel requests. */
const CONCURRENCY = 4;
/** Masks that a scrape-day artefact may have cut by one day (see KNOWN QUIRKS). */
export const REPAIRABLE = new Set(["1111111", "1111100", "1111110"]);

/**
 * Cities by slug that stations.json has no coordinates for: GeoNames (places-europe of the build's assets), the most
 * populous place of that name in the country, checked by hand against the neighbouring calls. Comment = GeoNames name
 * where it differs.
 */
export const CITY_COORDS: Record<string, [number, number]> = {
  // not listed: "ormanica", "bjelimici" (no GeoNames point), "spionica" (GeoNames' only Špionica, 44.761 18.672, is
  // 10 km off the times between Mionica and Srebrenik)
  "aachen": [50.77664, 6.08342],
  "aalborg": [57.048, 9.9187],
  "amsterdam": [52.37403, 4.88969],
  "antwerpen": [51.22047, 4.40026], // Antwerp
  "augsburg": [48.37154, 10.89851],
  "bar": [42.0937, 19.09841],
  "bare": [43.8745, 18.408], // Sarajevo, Bare neighbourhood (approximate, ±500 m)
  "basel": [47.55839, 7.57327],
  "bec": [48.20849, 16.37208], // Vienna
  "berlin": [52.52437, 13.41053],
  "bonn": [50.73438, 7.09549],
  "bosanska-gradiska": [45.14484, 17.25453], // Gradiška
  "bosanski-brod": [45.13747, 17.98722], // Brod
  "bosanski-samac": [45.05987, 18.46756], // Šamac
  "bregenz": [47.50311, 9.7471],
  "bremen": [53.07582, 8.80717],
  "budva": [42.28721, 18.83922],
  "busovaca": [44.09769, 17.8783],
  "cajnice": [43.55712, 19.07186], // Čajniče
  "celic": [44.72524, 18.81474],
  "cerik": [44.80766, 18.5384],
  "derventa": [44.97839, 17.90779],
  "doboj-jug": [44.68776, 18.04885], // Matuzići
  "dortmund": [51.51494, 7.466],
  "dubrovnik": [42.64125, 18.10909],
  "duisburg": [51.43247, 6.76516],
  "dusseldorf": [51.22319, 6.77927], // Düsseldorf
  "emden": [53.36592, 7.20846],
  "essen": [51.45657, 7.01228],
  "foca": [43.50646, 18.77854],
  "frankfurt": [50.11552, 8.68417], // Frankfurt am Main
  "freilassing": [47.84085, 12.98114],
  "gornji-rahic": [44.78329, 18.6942],
  "gornji-vakuf": [43.93806, 17.58833],
  "gornji-vakuf-uskoplje": [43.93806, 17.58833], // Gornji Vakuf
  "gostivar": [41.79627, 20.90799],
  "gottingen": [51.53443, 9.93228], // Göttingen
  "gracanica": [44.70307, 18.3101],
  "gradacac": [44.87851, 18.42764],
  "graz": [47.06733, 15.44197],
  "hamburg": [53.55073, 9.99302],
  "hannover": [52.37052, 9.73322],
  "heidelberg": [49.40768, 8.69079],
  "heilbronn": [49.13995, 9.22054],
  "herceg-novi": [42.45306, 18.5375],
  "hildesheim": [52.15077, 9.95112],
  "ingolstadt": [48.76508, 11.42372],
  "innsbruck": [47.26266, 11.39454],
  "jajce": [44.34203, 17.27059],
  "karlovac": [45.49167, 15.55],
  "karlsruhe": [49.00937, 8.40444],
  "karuse": [44.69691, 18.04911],
  "kassel": [51.31667, 9.5],
  "kiseljak": [43.94295, 18.08132],
  "klokotnica": [44.7329, 18.18884],
  "koblenz": [50.35357, 7.57883],
  "koln": [50.93333, 6.95], // Köln
  "kopenhagen": [55.67594, 12.56553], // Copenhagen
  "koper": [45.5482, 13.72963],
  "kotor": [42.42067, 18.76825],
  "kotor-varos": [44.61831, 17.37204],
  "krupa-n-v": [44.61875, 17.14351], // Krupa na Vrbasu
  "kupres": [43.99273, 17.27639],
  "laktasi": [44.90857, 17.30135],
  "linz": [48.30639, 14.28611],
  "livno": [43.82695, 17.00746],
  "ljubljana": [46.05108, 14.50513],
  "luzern": [47.05048, 8.30635],
  "makarska": [43.29694, 17.01778],
  "malmo": [55.60587, 13.00073], // Malmö
  "mannheim": [49.4891, 8.46694],
  "maribor": [46.55583, 15.64593],
  "matuzici": [44.68776, 18.04885],
  "metkovic": [43.05417, 17.64833],
  "milici": [44.17016, 19.09195],
  "minhen": [48.13743, 11.57549], // Munich
  "mionica": [44.86646, 18.46603],
  "modrica": [44.95781, 18.30202],
  "mrkonjic-grad": [44.41729, 17.08288],
  "neum": [42.92333, 17.61556],
  "nevesinje": [43.25861, 18.11333],
  "nova-bila": [44.19431, 17.73735],
  "nova-topola": [45.05267, 17.30915],
  "novi-pazar": [43.13667, 20.51222],
  "novi-travnik": [44.17133, 17.65816],
  "novo-mesto": [45.80397, 15.16886],
  "nurnberg": [49.45421, 11.07752], // Nuremberg
  "odzak": [45.02461, 18.32107],
  "olovske-luke": [44.12895, 18.61756],
  "omis": [43.44472, 16.68861],
  "orasje": [45.03366, 18.69334],
  "pale": [43.81664, 18.56949],
  "parsovici": [43.7715, 17.81175],
  "passau": [48.5665, 13.43122],
  "pforzheim": [48.88436, 8.69892],
  "piacenza": [45.05242, 9.69342],
  "pljevlja": [43.3567, 19.35843],
  "ploce": [43.05611, 17.43278],
  "pula": [44.86833, 13.84806],
  "regensburg": [49.01513, 12.10161],
  "rijeka": [45.32673, 14.44241],
  "ripac": [44.76652, 15.95567],
  "rosenheim": [47.85637, 12.12247],
  "rotterdam": [51.9225, 4.47917],
  "rudo": [43.61781, 19.36719],
  "samac": [45.05987, 18.46756],
  "sicki-brod": [44.52299, 18.59468],
  "sije": [44.65115, 18.06547],
  "skoplje": [41.99646, 21.43141], // Skopje
  "slavonski-brod": [45.16158, 18.0163],
  "split": [43.50891, 16.43915],
  "stockholm": [59.32938, 18.06871],
  "stolac": [43.084, 17.95995],
  "stupari": [44.31382, 18.68416],
  "stuttgart": [48.78232, 9.17702],
  "teslic": [44.60639, 17.85972],
  "ulcinj": [41.92936, 19.22436],
  "ulm": [48.39841, 9.99155],
  "utrecht": [52.09083, 5.12222],
  "velika-kladusa": [45.18497, 15.80579],
  "villach": [46.61028, 13.85583],
  "visegrad": [43.7826, 19.29256],
  "wiesbaden": [50.08601, 8.24435],
  "wurzburg": [49.79391, 9.95121], // Würzburg
  "zagreb": [45.81444, 15.97798],
  "zurich": [47.36667, 8.55], // Zürich
};

/** Stops without a city slug (`"city": null`, not a border crossing), by name; same origin as CITY_COORDS. */
export const NAME_COORDS: Record<string, [number, number]> = {
  // not listed: "Duba" (several on the Makarska riviera road, none certain), "Ruskamen", "Pećingrad" (no GeoNames point)
  "Andrijevica": [42.73389, 19.79194],
  "Arnhem": [51.98, 5.91111],
  "Baške Vode": [43.35694, 16.95028], // Baška Voda
  "Berane": [42.84333, 19.87281],
  "Bijelo Polje": [43.03834, 19.74758],
  "Bischofshofen": [47.41667, 13.21667],
  "Bludenz": [47.15476, 9.82255],
  "Boario Terme": [45.8915, 10.18879], // Darfo Boario Terme
  "Bochum": [51.48165, 7.21648],
  "Bratislava": [48.14816, 17.10674],
  "Breda": [51.58656, 4.77596],
  "Brescia": [45.53558, 10.21472],
  "Brist": [43.11806, 17.32472],
  "Brno": [49.19522, 16.60796],
  "Bruck An Der Mur": [47.406, 15.258], // Bruck an der Mur
  "Brussel": [50.85045, 4.34878], // Brussels
  "Deggendorf": [48.84085, 12.96068],
  "Den Hag": [52.07667, 4.29861], // The Hague
  "Deventer": [52.255, 6.16389],
  "Donja Brela": [43.36889, 16.93417], // Brela
  "Dornbirn": [47.41427, 9.74195],
  "Drezden": [51.05089, 13.73832], // Dresden
  "Drvenik": [43.15573, 17.24854],
  "Dugi Rat": [43.44611, 16.63972],
  "Eben In Pangau/Bahnhof": [47.4, 13.4], // Eben im Pongau
  "Enschede": [52.21833, 6.89583],
  "Esbjerg": [55.47028, 8.45187],
  "Feistritz An Der Drau": [46.70157, 13.66479], // Feistritz an der Drau
  "Feldkirch": [47.23645, 9.59734],
  "Froslev": [54.82137, 9.34148], // Frøslev (DK), at the Padborg border crossing
  "Gradac": [43.10583, 17.34167],
  "Groningen": [53.21917, 6.56667],
  "Gusinje": [42.56194, 19.83389],
  "Helsingborg": [56.04673, 12.69437],
  "Herning": [56.13615, 8.97662],
  "Igrane": [43.19528, 17.13889],
  "Ikast": [56.13883, 9.15768],
  "Imst/Bahnhof": [47.24504, 10.73974], // Imst
  "Jenbach/Bahnhof": [47.39173, 11.77245], // Jenbach
  "Jonkoping": [57.78145, 14.15618], // Jönköping
  "Kircheim/Teck": [48.64683, 9.45378], // Kirchheim unter Teck
  "Kolding": [55.4904, 9.47216],
  "Kopači": [43.67833, 19.02845],
  "Leoben": [47.379, 15.094],
  "Liege": [50.63373, 5.56749], // Liège
  "Liezen": [47.56667, 14.23333],
  "Linkoping": [58.41086, 15.62157], // Linköping
  "Lofer-Kreuzfield": [47.58475, 12.69333], // Lofer
  "Lončari": [44.94247, 18.68431],
  "Maastricht": [50.84833, 5.68889],
  "Mala Kladuša": [45.13443, 15.85217],
  "Mimice": [43.40492, 16.81166],
  "Mjolbj": [58.32595, 15.12365], // Mjölby
  "Norrkoping": [58.59419, 16.1826], // Norrköping
  "Nova Varoš": [43.46056, 19.81139],
  "Oberhausen": [51.47805, 6.8625],
  "Odense": [55.39594, 10.38831],
  "Opuzen": [43.01528, 17.56556],
  "Petrovac": [42.20556, 18.9425], // Petrovac na Moru
  "Plav": [42.5969, 19.94415],
  "Podgora": [43.24333, 17.07722],
  "Prag": [50.08804, 14.42076], // Prague
  "Priboj": [43.58306, 19.52519],
  "Promajna": [43.33611, 16.97556],
  "Randers": [56.4607, 10.03639],
  "Ringkobing": [56.09006, 8.24402], // Ringkøbing
  "Ringsted": [55.4426, 11.79011],
  "Saalfelden Bahnhof": [47.42681, 12.848], // Saalfelden am Steinernen Meer
  "Sankt Michael Im Lungau": [47.1, 13.63333], // Sankt Michael im Lungau
  "Siegburg": [50.80019, 7.20769],
  "Silkeborg": [56.1697, 9.54508],
  "Sjenica": [43.27306, 19.99944],
  "St Johann Im Pongau Bahnhof": [47.35, 13.2], // Sankt Johann im Pongau
  "St.Johan I.T": [47.5233, 12.4232], // Sankt Johann in Tirol
  "Stayr": [48.04274, 14.42127], // Steyr
  "Straubing": [48.88126, 12.57385],
  "Sutomore": [42.14278, 19.04667],
  "Tetovo": [42.00989, 20.97138],
  "Tivat": [42.43623, 18.69361],
  "Tučepi": [43.27222, 17.05444],
  "Ustiprača": [43.69109, 19.08922],
  "Varde": [55.62112, 8.48069],
  "Varnamo": [57.18604, 14.04001], // Värnamo
  "Verona": [45.43854, 10.9938],
  "Wiener Neustadt": [47.80485, 16.23196],
  "Worgl Hauptbahnhof": [47.48906, 12.06174], // Wörgl
  "Zaostrog": [43.1425, 17.28222],
  "Zell Am See-Kurcenter": [47.32306, 12.79839], // Zell am See
  "Živogošće": [43.18798, 17.16091],
};

// ---------------------------------------------------------------- reading the API (strict)

function fail(m: string): never {
  throw new GeneratorError(m);
}
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAYS_RE = /^[01]{7}$/;

/** Whole days from `from` to `to` (YYYY-MM-DD). */
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);

/** /api/v1.json: the API version and licence this script was written for. */
export function checkIndex(j: unknown): void {
  if (!isObj(j)) fail("v1.json: not a JSON object");
  const o = j as Record<string, unknown>;
  if (o.api_version !== "v1") fail(`v1.json: api_version "${String(o.api_version)}" (expected "v1")`);
  const lic = o.license;
  if (!isObj(lic) || lic.name !== "CC BY 4.0") fail(`v1.json: licence changed to ${JSON.stringify(lic)} (expected CC BY 4.0: re-read the terms)`);
}

export interface Health {
  dataLastConfirmed: string;
  /** source → last_confirmed */
  sources: Map<string, string>;
}

/** /api/v1/health.json; fails when the whole dataset is older than MAX_SOURCE_AGE_DAYS on `today`. */
export function parseHealth(j: unknown, today: string): Health {
  if (!isObj(j)) fail("health.json: not a JSON object");
  const o = j as Record<string, unknown>;
  const dl = o.data_last_confirmed;
  if (typeof dl !== "string" || !DATE_RE.test(dl)) fail(`health.json: data_last_confirmed ${JSON.stringify(dl)} is not a date`);
  if (!Array.isArray(o.sources) || !o.sources.length) fail("health.json: no sources list");
  const sources = new Map<string, string>();
  for (const s of o.sources as unknown[]) {
    if (!isObj(s) || typeof s.source !== "string" || typeof s.last_confirmed !== "string" || !DATE_RE.test(s.last_confirmed)) fail(`health.json: unreadable source ${JSON.stringify(s)}`);
    sources.set((s as { source: string }).source, (s as { last_confirmed: string }).last_confirmed);
  }
  const age = daysBetween(dl as string, today);
  if (age > MAX_SOURCE_AGE_DAYS) fail(`data too stale: health.json data_last_confirmed ${dl} is ${age} days old (limit ${MAX_SOURCE_AGE_DAYS})`);
  return { dataLastConfirmed: dl as string, sources };
}

export interface Station {
  slug: string;
  name: string;
  coord: [number, number] | null;
  apiUrl: string;
}

/** /api/v1/stations.json */
export function parseStations(j: unknown): Map<string, Station> {
  const list = isObj(j) && Array.isArray(j.stations) ? (j.stations as unknown[]) : fail("stations.json: no stations list");
  const out = new Map<string, Station>();
  for (const s of list!) {
    if (!isObj(s) || typeof s.slug !== "string" || typeof s.name !== "string" || typeof s.api_url !== "string") fail(`stations.json: unreadable station ${JSON.stringify(s).slice(0, 200)}`);
    const st = s as { slug: string; name: string; api_url: string; coordinates?: unknown };
    let coord: [number, number] | null = null;
    if (st.coordinates != null) {
      const c = st.coordinates;
      if (!isObj(c) || typeof c.lat !== "number" || typeof c.lon !== "number") fail(`stations.json: ${st.slug}: unreadable coordinates ${JSON.stringify(c)}`);
      coord = [(c as { lat: number }).lat, (c as { lon: number }).lon];
    }
    out.set(st.slug, { slug: st.slug, name: st.name, coord, apiUrl: st.api_url });
  }
  if (out.size < 20) fail(`stations.json: only ${out.size} stations`);
  return out;
}

/** /api/v1/operators.json: operator name → web page (its own site, else its page on redvoznje.ba). */
export function parseOperators(j: unknown): Map<string, string> {
  const list = isObj(j) && Array.isArray(j.operators) ? (j.operators as unknown[]) : fail("operators.json: no operators list");
  const out = new Map<string, string>();
  for (const o of list!) {
    if (!isObj(o) || typeof o.name !== "string" || typeof o.url !== "string") fail(`operators.json: unreadable operator ${JSON.stringify(o).slice(0, 200)}`);
    const w = typeof o.website === "string" && /^https?:\/\//.test(o.website) ? o.website : new URL(o.url as string, SITE_URL).href;
    out.set(o.name as string, w);
  }
  return out;
}

/** A station board: the pair files (API paths) of its bus departures ("/autobus/a-b/" → "/routes/bus/a-b.json"). */
export function boardPairs(j: unknown, city: string): string[] {
  const deps = isObj(j) && Array.isArray(j.departures) ? (j.departures as unknown[]) : fail(`stations/${city}.json: no departures list`);
  const out = new Set<string>();
  for (const d of deps!) {
    if (!isObj(d) || typeof d.mode !== "string" || typeof d.url !== "string") fail(`stations/${city}.json: unreadable departure ${JSON.stringify(d).slice(0, 200)}`);
    if (d.mode !== "bus") continue;
    const m = /^\/autobus\/([a-z0-9-]+)\/$/.exec(d.url as string);
    if (!m) fail(`stations/${city}.json: unexpected url "${d.url}" (expected /autobus/<from>-<to>/)`);
    out.add(`/routes/bus/${m![1]}.json`);
  }
  return [...out].sort();
}

export interface ApiStop {
  name: string;
  city: string | null;
  time: string;
  day_offset: number;
  border: boolean;
}
export interface ApiLine {
  operator: string | null;
  days: string;
  source: string;
  stops: ApiStop[];
}
export interface PairFile {
  /** html_url of the pair (the page a traveller reads) */
  html: string;
  lines: ApiLine[];
}

/** One pair file: its lines, every field checked. */
export function parsePair(j: unknown, file: string): PairFile {
  if (!isObj(j)) fail(`${file}: not a JSON object`);
  const o = j as Record<string, unknown>;
  if (!isObj(o.route) || (o.route as { mode?: unknown }).mode !== "bus") fail(`${file}: route.mode is not "bus"`);
  if (typeof o.html_url !== "string") fail(`${file}: no html_url`);
  if (!Array.isArray(o.departures)) fail(`${file}: no departures list`);
  if (!Array.isArray(o.lines)) fail(`${file}: no lines list (API shape changed)`);
  const lines: ApiLine[] = [];
  for (const l of o.lines as unknown[]) {
    const where = `${file}: line ${JSON.stringify(l).slice(0, 120)}`;
    if (!isObj(l)) fail(`${where}: not an object`);
    const L = l as Record<string, unknown>;
    if (!(L.operator === null || typeof L.operator === "string")) fail(`${where}: operator`);
    if (typeof L.days !== "string" || !DAYS_RE.test(L.days)) fail(`${where}: days is not a Mon..Sun mask of 0/1`);
    if (typeof L.source !== "string") fail(`${where}: source`);
    if (!Array.isArray(L.stops) || L.stops.length < 2) fail(`${where}: stops`);
    const stops: ApiStop[] = [];
    for (const s of L.stops as unknown[]) {
      if (!isObj(s)) fail(`${where}: stop not an object`);
      const S = s as Record<string, unknown>;
      if (typeof S.name !== "string" || !(S.city === null || typeof S.city === "string") || typeof S.border !== "boolean")
        fail(`${where}: stop ${JSON.stringify(s)} lacks name / city / border`);
      if (typeof S.time !== "string" || parseHm(S.time) === null) fail(`${where}: stop time ${JSON.stringify(S.time)} is not HH:MM`);
      if (!Number.isInteger(S.day_offset) || (S.day_offset as number) < 0 || (S.day_offset as number) > 3) fail(`${where}: day_offset ${JSON.stringify(S.day_offset)}`);
      stops.push({ name: S.name as string, city: S.city as string | null, time: S.time as string, day_offset: S.day_offset as number, border: S.border as boolean });
    }
    lines.push({ operator: L.operator as string | null, days: L.days as string, source: L.source as string, stops });
  }
  return { html: o.html_url as string, lines };
}

// ---------------------------------------------------------------- lines → trips

/** A call of a line after border stops are dropped: stop key, name, minutes after midnight of the first day. */
export interface Call {
  key: string;
  name: string;
  t: number;
  coord: [number, number];
}
export interface Line {
  operator: string;
  days: string;
  source: string;
  calls: Call[];
  /** pair pages listing it (the first one is the route page) */
  pages: string[];
}

const slugOf = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

export interface LineStats {
  lineEntries: number;
  unique: number;
  noOperator: number;
  border: number;
  unknownStops: Map<string, number>;
  calls: number;
  badTimes: number;
  badHops: number;
}

/**
 * Turn the pair files' lines into unique lines with coordinates: border stops dropped, the same line of several pair
 * files kept once, stops without coordinates left out, lines with times going backwards or impossible hops skipped.
 */
export function collectLines(pairs: PairFile[], stations: Map<string, Station>, warn: (m: string) => void): { lines: Line[]; stats: LineStats } {
  const stats: LineStats = { lineEntries: 0, unique: 0, noOperator: 0, border: 0, unknownStops: new Map(), calls: 0, badTimes: 0, badHops: 0 };
  const byKey = new Map<string, Line | null>();
  for (const p of pairs)
    for (const l of p.lines) {
      stats.lineEntries++;
      const key = JSON.stringify([l.operator, l.days, l.source, l.stops.map((s) => [s.name, s.city, s.time, s.day_offset, s.border])]);
      const had = byKey.get(key);
      if (had !== undefined) {
        if (had && !had.pages.includes(p.html)) had.pages.push(p.html);
        continue;
      }
      if (!l.operator) {
        stats.noOperator++;
        byKey.set(key, null);
        continue;
      }
      const calls: Call[] = [];
      let prevT = -1, bad = false;
      for (const s of l.stops) {
        const t = parseHm(s.time)! + 1440 * s.day_offset;
        if (t < prevT) bad = true;
        prevT = t;
        if (s.border) {
          stats.border++;
          continue;
        }
        stats.calls++;
        const st = s.city ? stations.get(s.city) : undefined;
        const coord = st?.coord ?? (s.city ? CITY_COORDS[s.city] : undefined) ?? NAME_COORDS[s.name];
        if (!coord) {
          const k = s.city ?? s.name;
          stats.unknownStops.set(k, (stats.unknownStops.get(k) ?? 0) + 1);
          continue;
        }
        const ck = s.city ?? `x-${slugOf(s.name)}`;
        const last = calls[calls.length - 1];
        if (last?.key === ck) continue; // the same place twice in a row (a board and its city stop): one call
        calls.push({ key: ck, name: st?.name ?? s.name, t, coord });
      }
      if (bad) {
        stats.badTimes++;
        warn(`line ${l.operator} ${l.stops[0]!.name} ${l.stops[0]!.time} → ${l.stops[l.stops.length - 1]!.name}: times go backwards, skipped`);
        byKey.set(key, null);
        continue;
      }
      if (calls.length < 2 || new Set(calls.map((c) => c.key)).size !== calls.length || calls[calls.length - 1]!.t === calls[0]!.t) {
        byKey.set(key, null);
        continue;
      }
      let hop = "";
      for (let i = 1; i < calls.length && !hop; i++) {
        const a = calls[i - 1]!, b = calls[i]!;
        const km = haversineKm(a.coord[0], a.coord[1], b.coord[0], b.coord[1]);
        const min = b.t - a.t;
        if ((km / (min + 1)) * 60 > MAX_KMH) hop = `${a.name} → ${b.name}: ${km.toFixed(0)} km in ${min} min`;
      }
      if (hop) {
        stats.badHops++;
        warn(`line ${l.operator} ${calls[0]!.name} → ${calls[calls.length - 1]!.name}: impossible hop ${hop}, skipped`);
        byKey.set(key, null);
        continue;
      }
      byKey.set(key, { operator: l.operator, days: l.days, source: l.source, calls, pages: [p.html] });
    }
  const lines = [...byKey.values()].filter((x): x is Line => !!x);
  stats.unique = lines.length;
  return { lines, stats };
}

/** Days of a mask: 0 = Monday … 6 = Sunday. */
const maskDays = (m: string) => [...m].flatMap((c, i) => (c === "1" ? [i] : []));
const orMask = (a: string, b: string) => [...a].map((c, i) => (c === "1" || b[i] === "1" ? "1" : "0")).join("");

/**
 * The scrape-day artefact (KNOWN QUIRKS): a mask that lacks the weekday the line's source was read on, and becomes
 * a regular mask with it, gets it back. Returns the mask and whether it changed.
 */
export function repairMask(mask: string, scrapeDate: string): { mask: string; repaired: boolean } {
  const w = isoWeekday(scrapeDate);
  if (mask[w] === "1") return { mask, repaired: false };
  const fixed = mask.slice(0, w) + "1" + mask.slice(w + 1);
  return REPAIRABLE.has(fixed) ? { mask: fixed, repaired: true } : { mask, repaired: false };
}

/**
 * One bus listed twice (by two boards, or with two masks): lines sharing at least two (place, time) calls and a
 * service day are merged – the one with more calls stays (then more pages, then the smaller key) and takes the other's
 * days. Mirrors the build's cross-feed dedup (core/dedup.ts) inside this source.
 */
export function mergeDuplicates(lines: Line[]): { lines: Line[]; merged: number } {
  const order = lines.map((_, i) => i).sort((a, b) => lines[b]!.calls.length - lines[a]!.calls.length || lines[b]!.pages.length - lines[a]!.pages.length || (JSON.stringify(lines[a]) < JSON.stringify(lines[b]) ? -1 : 1));
  const kept: Line[] = [];
  const at = new Map<string, number[]>(); // "place|time" → indexes into kept
  let merged = 0;
  for (const i of order) {
    const l = lines[i]!;
    const hits = new Map<number, number>();
    for (const c of l.calls) for (const k of at.get(`${c.key}|${c.t % 1440}`) ?? []) hits.set(k, (hits.get(k) ?? 0) + 1);
    const into = [...hits].filter(([k, n]) => n >= 2 && maskDays(kept[k]!.days).some((d) => l.days[d] === "1")).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    if (into) {
      const k = kept[into[0]]!;
      k.days = orMask(k.days, l.days);
      for (const p of l.pages) if (!k.pages.includes(p)) k.pages.push(p);
      merged++;
      continue;
    }
    const idx = kept.length;
    kept.push({ ...l, pages: [...l.pages] });
    for (const c of l.calls) {
      const key = `${c.key}|${c.t % 1440}`;
      let a = at.get(key);
      if (!a) at.set(key, (a = []));
      a.push(idx);
    }
  }
  return { lines: kept, merged };
}

// ---------------------------------------------------------------- feed

export interface BuildInput {
  health: Health;
  stations: Map<string, Station>;
  operators: Map<string, string>;
  pairs: PairFile[];
  /** today's date (the staleness rules count from it) */
  today: string;
  startDate: string;
  days: number;
  /** MIN_LINES unless given (tests with a few pair files) */
  minLines?: number;
  warn(m: string): void;
  log?(m: string): void;
}

/** The GTFS feed from the API's answers. */
export function buildFeed(o: BuildInput): GtfsFeed {
  const { lines: raw, stats } = collectLines(o.pairs, o.stations, o.warn);
  const unknown = [...stats.unknownStops.values()].reduce((a, b) => a + b, 0);
  if (stats.unknownStops.size)
    o.warn(`no coordinates for ${stats.unknownStops.size} places (${unknown} calls left out): ${[...stats.unknownStops].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(", ")}`);
  if (stats.calls && unknown / stats.calls > MAX_UNKNOWN_SHARE)
    fail(`${unknown} of ${stats.calls} calls have no coordinates (more than ${MAX_UNKNOWN_SHARE * 100} %): add the places to CITY_COORDS / NAME_COORDS`);
  // the line sources must be fresh; a stale source without lines only warns
  const used = new Set(raw.map((l) => l.source));
  for (const [src, last] of o.health.sources) {
    const age = daysBetween(last, o.today);
    if (age <= MAX_SOURCE_AGE_DAYS) continue;
    if (used.has(src)) fail(`data too stale: source ${src} (lines) last confirmed ${last}, ${age} days ago (limit ${MAX_SOURCE_AGE_DAYS})`);
    o.warn(`source ${src} last confirmed ${last} (${age} days ago); it has no lines here, nothing of it is used`);
  }
  for (const s of used) if (!o.health.sources.has(s)) fail(`lines from source "${s}", which health.json does not list`);
  // the scrape-day artefact, then duplicates inside the source
  let repaired = 0;
  for (const l of raw) {
    const r = repairMask(l.days, o.health.sources.get(l.source)!);
    if (r.repaired) (l.days = r.mask), repaired++;
  }
  const { lines, merged } = mergeDuplicates(raw);
  const minLines = o.minLines ?? MIN_LINES;
  if (lines.length < minLines) fail(`only ${lines.length} lines (expected at least ${minLines}): API answer incomplete or changed`);

  const win = serviceWindow(o.startDate, o.days);
  const feed: GtfsFeed = {
    agency: [],
    stops: [],
    routes: [],
    trips: [],
    stopTimes: [],
    services: new Map(),
    info: { publisher: "EuroTrainBusMap (generated from the redvoznje.ba API, CC BY 4.0)", publisherUrl: SITE_URL, lang: "bs", sourceUrl: SITE_URL },
  };
  const agencyIds = new Map<string, string>();
  const agency = (name: string) => {
    let id = agencyIds.get(name);
    if (id) return id;
    id = slugOf(name) || `op${agencyIds.size + 1}`;
    while (feed.agency.some((a) => a.agency_id === id)) id += "-x";
    agencyIds.set(name, id);
    // a joint operation ("Centrotrans Sarajevo/Transturist Tuzla") links the page of its first carrier
    const url = o.operators.get(name) ?? o.operators.get(name.split("/")[0]!.trim()) ?? SITE_URL;
    feed.agency.push({ agency_id: id, agency_name: name, agency_url: url, agency_timezone: "Europe/Sarajevo", agency_lang: "bs" });
    return id;
  };
  const stopIds = new Set<string>();
  const services = new Map<string, string>();
  let idle = 0;
  const sorted = [...lines].sort((a, b) => a.calls[0]!.name.localeCompare(b.calls[0]!.name) || a.calls[0]!.t - b.calls[0]!.t || a.operator.localeCompare(b.operator) || a.calls.length - b.calls.length);
  for (const l of sorted) {
    // service days: the mask within the build window, up to MAX_SOURCE_AGE_DAYS after the source was confirmed
    const until = addDays(o.health.sources.get(l.source)!, MAX_SOURCE_AGE_DAYS);
    const last = until < win.to ? until : win.to;
    const dates = win.from <= last ? dateRange(win.from, last).filter((d) => l.days[isoWeekday(d)] === "1") : [];
    if (!dates.length) {
      idle++;
      continue;
    }
    const dkey = dates.join(",");
    let sid = services.get(dkey);
    if (!sid) services.set(dkey, (sid = `s${services.size + 1}`));
    feed.services.set(sid, dates);
    const first = l.calls[0]!, end = l.calls[l.calls.length - 1]!;
    const aid = agency(l.operator);
    const rid = `${aid}:${first.key}:${end.key}`;
    if (!feed.routes.some((r) => r.route_id === rid))
      feed.routes.push({ route_id: rid, agency_id: aid, route_short_name: "", route_long_name: `${first.name} – ${end.name}`, route_type: 200, route_url: l.pages[0] });
    const tid = `${rid}:${first.t}:${l.days}:${l.calls.length}`;
    let trip = tid, n = 1;
    while (feed.trips.some((t) => t.trip_id === trip)) trip = `${tid}:${++n}`;
    feed.trips.push({ route_id: rid, service_id: sid, trip_id: trip, trip_headsign: end.name });
    l.calls.forEach((c, i) => {
      if (!stopIds.has(c.key)) {
        stopIds.add(c.key);
        feed.stops.push({ stop_id: c.key, stop_name: c.name, stop_lat: c.coord[0], stop_lon: c.coord[1] });
      }
      feed.stopTimes.push({ trip_id: trip, stop_sequence: i + 1, stop_id: c.key, arr: c.t, dep: c.t });
    });
  }
  o.log?.(
    `${stats.lineEntries} line entries → ${stats.unique} lines (${stats.noOperator} without operator, ${stats.badTimes} with times going backwards, ${stats.badHops} with impossible hops skipped), ` +
      `${repaired} masks repaired (scrape day), ${merged} duplicates merged, ${feed.trips.length} trips (${idle} without a day in the window), ${feed.agency.length} operators, ${feed.stops.length} places`,
  );
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
  id: "ba-redvoznje",
  description: "Intercity buses of Bosnia and Herzegovina from the redvoznje.ba JSON API (CC BY 4.0): the full runs (lines) of the pair files, deduplicated, with coordinates.",
  sourceUrl: SITE_URL,
  generate: (ctx: GeneratorContext) => generateFrom(ctx, new Date().toISOString().slice(0, 10)),
});

/** The generator's run with an explicit date for the staleness rules (tests). */
export async function generateFrom(ctx: GeneratorContext, today: string, minLines = MIN_LINES): Promise<GtfsFeed> {
  const cache = new Map<string, Promise<unknown>>();
  // every URL once per run; a JSON answer must end with its closing brace (a cut-off answer is retried)
  const getJson = (path: string) => {
    let p = cache.get(path);
    if (!p) {
      const url = path.startsWith("http") ? path : API + path;
      p = ctx.fetchText(url, { expect: /[}\]]\s*$/ }).then((t) => {
        try {
          return JSON.parse(t) as unknown;
        } catch {
          return fail(`${url}: not JSON`);
        }
      });
      cache.set(path, p);
    }
    return p;
  };
  checkIndex(await getJson(".json"));
  const health = parseHealth(await getJson("/health.json"), today);
  const stations = parseStations(await getJson("/stations.json"));
  const operators = parseOperators(await getJson("/operators.json"));
  ctx.log(`data last confirmed ${health.dataLastConfirmed} (${[...health.sources].map(([s, d]) => `${s} ${d}`).join(", ")}), ${stations.size} station boards`);
  const boards = await pool([...stations.values()], CONCURRENCY, async (s) => boardPairs(await getJson(s.apiUrl.replace(/^\/api\/v1/, "")), s.slug));
  const files = [...new Set(boards.flat())].sort();
  ctx.log(`${files.length} pair files from the boards`);
  const pairs = await pool(files, CONCURRENCY, async (f) => parsePair(await getJson(f), f));
  return buildFeed({ health, stations, operators, pairs, today, startDate: ctx.startDate, days: ctx.days, minLines, warn: ctx.warn, log: ctx.log });
}
