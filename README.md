# EuroTrainBusMap

A transit-diagram style map of intercity rail and bus connections across Europe (incl. UK,
CH, NO, the Balkans, Turkey and Ukraine). Click a city to see every city reachable by a
*direct* train/coach/bus – and, if you switch it on, every city reachable with one or two same-day
connections –, click a pair for the timetable (or the journeys with changes), click a departure for the trip's stops and
the onward connections from any of them. Fully static: a weekly pipeline turns ~150 public GTFS feeds into JSON files
served from Cloudflare.

## Architecture

```
packages/
  shared/   schema.ts – the data contract (Manifest, NetworkFile, CityFile, …) + pack.ts (compact network encoding)
  etl/      data pipeline (Node 22 + DuckDB): GTFS feeds → static JSON
    feeds.json          data-driven feed list (Transitous mirror + Mobility Database fallbacks, per-feed options)
    src/cli.ts          `build-data` entry: download → load (DuckDB) → build
    src/gtfs/load.ts    per-feed loading: only kept routes/trips/stop_times/stops, calendars → service days
    src/build.ts        cities, stations, dedup, patterns, corridors, geometry, output, sanity
    src/core/*          pure logic (classification, calendars, names, city assignment, station merging,
                        pattern building, cross-feed dedup) – unit tested in test/
    src/geometry/       corridor geometry: rail / coach+bus routing on graphs built from Overture (OSM) rail and major roads
    src/urban/          local transport (metro / tram / city bus) display layer: own GTFS pass, own tiles (see "Local transport" below)
    urban-feeds.json    extra GTFS feeds that only feed the local layer (kept out of feeds.json: the intercity pipeline is untouched)
    src/assets.ts       builds the slow-changing inputs stored in R2 (see below)
  web/      MapLibre front end (Vite); reads data/ at runtime
```

Pipeline in short:

1. **Feeds** – resolved from `feeds.json` (Transitous file names are looked up in its index, so
   year-suffixed names roll over automatically), downloaded with a custom User-Agent, 3 at a time,
   ETag-cached in `work/cache`. A stale primary source falls back to the next URL.
2. **Load** – each zip is unzipped, filtered and loaded into a DuckDB file, then deleted. Kept:
   heavy rail (long distance, regional/suburban), coaches and *intercity* buses (≥ 15 km span,
   urban modes/operators dropped). Rail is classified LongDistance/Regional from extended route types,
   train category tokens and operators; the night-train flag is set.
3. **Stations** (`core/stations.ts`) – stops are merged into stations first, purely spatially, from several weak
   signals, none trusted alone: the feed's `parent_station` (explicit but rarely maintained), *near* (≤ 60 m always;
   ≤ 150 m when a rail stop is involved, shrinking to 100 / 70 m where many differently named stops lie around, so
   cities are not chained into blobs; two bus stops with different names are two places and only merge at the same
   spot), *name* (same normalised name within 250 m, 400 m around rail stops; a lone town name inside a longer one is
   only weak evidence), *terminal* (a bus / coach terminal – "ZOB", "gare routière", "Coach Station", "autobusni
   kolodvor", "Autogara", "Otogar"… – within 450 m of a rail stop with a compatible name) and *isolated* (≤ 300 m and
   no other differently named stop within 400 m: a small town's station and its bus stop). Strong signals are applied
   first; a merged cluster may not exceed 250 m (near) / 450 m (name, terminal, isolated) between centroids. The reviewed
   `data/stop-names.json` merges are applied afterwards (a target is found by the name of the station or of any of
   its stops). A station's name is the best name among its stops *after* `sanitizeName` (raw ids such as
   `# f3583`, `"ROMA | "` prefixes, HTML entities) and after removing platform / track / stand / bay qualifiers in the common
   European languages (`stripPlatform` in `core/names.ts`: "Paddington (Platform 6)" → "Paddington"); the map label
   drops the city prefix ("Berlin Hbf" → "Hbf") only while the remainder is distinctive (`shortStationName`: "London
   Bridge", "Paris Nord", "Leeds Central" keep the city).
4. **Cities** (`core/cities.ts`) – the selection unit, grouping stations: every *station* is assigned to a GeoNames place
   (population-scaled radius; city districts and, for big cities, places of their administrative unit within ~1.8
   radii / 30 km absorbed; local names such as "München", "Praha", "İstanbul"; an *agglomeration* – a big plain PPL known only
   by its region, such as "Marne La Vallée" – absorbs nothing and only gets the stations named after it and their forecourt
   within 600 m, so it does not swallow Champigny, Chelles or Bondy). Rail and coach stations must also be
   within the place's *core* (45 % of the radius for a village, growing to the whole radius from 200 000 inhabitants,
   so Paris and London group all their stations) or carry the place's name ("Aix-en-Provence TGV" at 8 km). A
   village beside a town therefore keeps its own station: it becomes a synthetic town named after the station
   (Anchamps ≠ Revin, Limerick Junction ≠ Tipperary). Bus-only stops keep the plain catchment rule (nearest place, 5 km
   fallback; one carrying exactly the name of a rail / coach station within 1 km joins that station's place). A synthetic town
   whose name is the name of a GeoNames populated place of any size within 4 km (`matchVillage`; the villages below cities1000
   come from the per-country dumps, asset `geonames/villages-europe.tsv.gz`) becomes that *village* ("Scariff" = GeoNames
   "Scarriff", 770 inhabitants; towns matching the same village are joined). Bus stops count as destinations in every named
   place – GeoNames towns and villages, whatever their population; stops in the remaining synthetic towns (stop clusters named
   "School Road", "Road End", a farm) are listed in the trip schedule only (see 6 and 9). Synthetic towns with a generic name (≥ 4 of them: "Road End", "Hotel", "Mairie") get the nearest place
   added ("Road End (Strathy)"). Cities never influence the drawing.
5. **Dedup** – the same train/coach present in several feeds (DE+AT+CH+CZ…) is detected by matching
   (city, time) sequences and kept once, with merged calendars. The kept trip also takes the boarding / alighting
   restrictions of the dropped copies, and of the copies a feed leaves to a dedicated operator's feed
   (`dedicatedOperators`; kept by the loader as `limit_hints`): the more restrictive copy wins. The Eurostar feed lets
   anyone ride Rotterdam → Amsterdam, NS's copy in nl-openov (no domestic travel) does not.
6. **Patterns & trips** – station sequences with offsets, deduplicated (a bus pattern keeps the stops in named places (towns and
   villages, `busPlace`), one main stop per smaller town and the entry / exit stops of a big city; the stops it leaves out are kept with
   their times as the run's full stop list, `ScheduleRun` in `packages/shared/src/schema.ts`, shown only in the trip schedule); calendars as 60-day bitmasks starting the day before the build (Berlin date), so viewers in earlier timezones stay covered.
   Boarding / alighting restrictions: GTFS `pickup_type` / `drop_off_type` 1 ("no pickup" / "no drop off") become
   `Pattern.limits` (restricted stops only, `StopLimit` bits). Types 2 / 3 (phone the agency / ask the driver) are
   ordinary stops: the Austrian PTA feeds mark ordinary trains and buses with 2, NS's international trains their
   reservation-only stops, German heritage lines their request stops. A ride from A to B needs boarding at A and
   alighting at B; the web app applies this to the destinations, pair timetables, onward connections, the station
   lists and the search with changes (the vehicle still passes such stops), and labels the stops in a trip's schedule
   ("drop-off only" / "boarding only"). Typical cases: no domestic travel on Eurostar and Nightjet trains in the
   Netherlands (from NS's copies, see 5), long-distance trains that only set down (Trenitalia at Roma Ostiense) or
   only pick up (ICE at Berlin Südkreuz), pick-up / set-down-only stops of British and Irish coaches (National Express), express
   buses that carry no local passengers inside a city (Norway, Sweden, Asturias). FlixBus, BlaBlaCar and European
   Sleeper publish no restrictions. Full build: 31.7k of 412k distinct patterns have restricted stops, 8.3k of 1.1 M
   direct city pairs disappear; the timetable shards grow by ~0.8 %, the transfer timetable by ~0.6 %.
   Invalid stop times are repaired (`repairTimes` in `core/patterns.ts`): hops of more than 3 km that take no time or would need more than 450 km/h (rail) / 160 km/h (road), as in a Milan–Paris–Lyon pattern whose Paris and Lyon calls both read 12:00, get times interpolated by distance between the surrounding valid times (extrapolated at a typical speed at the end of a trip); the UI never shows "0 min" between two cities.
7. **Corridors** – the drawn network connects *stations*: a corridor is an undirected edge between two stations
   that are consecutive stops of a trip, between cities as well as inside one (Tipperary – Limerick Junction,
   Paddington – Ealing Broadway), so lines are continuous at every zoom. Trips/day per category; geometry routed on the
   rail graph (trains: along the feed's shape where it lies on the track – a deduplicated trip takes a dropped copy's
   shape – else the shortest path, and hops of ≥ 25 km are then routed again with lightly used track made up to ×2 more
   expensive, using the trains/day of all other routed hops per piece of track, so non-stop trains stay on the main
   line instead of a shorter branch; `src/geometry/guide.ts`), else – rail replacement buses, tram-trains, stops far from any track – on the road graph, or
   (coaches/buses) on the road graph; ferries, islands and anything not routable become *approximate alignments*
   (`Corridor.snapped` = false), drawn thin and dashed, never as solid straight lines. Rail graph holes are bridged
   (disused / under-construction track stays routable at a high cost, dead ends within 300 m of another component are
   joined). A line ends exactly at its two stations (a straight stub joins a station to its snapped track point
   if that is ≤ 1 km, `STUB_MAX_M`); a city's point is its main station (busiest rail station, else busiest stop;
   `src/core/anchor.ts`) and is only the marker of the city dot / label.
8. **Line graph** (`src/core/segments.ts`) – corridor geometries are conflated onto shared
   reference lines (resampled every 100 m, matched within 80 m with a similar direction, rail with
   rail, road with road) and cut where the set of corridors using them changes; every segment is
   simplified with Douglas–Peucker at 12 m (routed) / 60 m (unsnapped curves). Each piece of
   track/road is stored and drawn once (`NetworkFile.segments`, `Corridor.segs`) with the summed
   traffic of all corridors on it, so an express A–C no longer draws a second line beside A–B–C.
9. **Output** (`data/<build>/`): `network.json` (packed, ~10.6 MB raw / ~4.5 MB gzip; the full network for tools – the web app uses the map data below),
   `calendars.json`, `attribution.json`, `basemap/{borders,labels}.json` (Natural Earth 1:10m borders) and `shard/<n>.json` – the per-city
   timetables, grouped into ~600 shards of spatially neighbouring cities (`City.shard`), and `sched/<n>.json` – the full stop lists of
   the runs whose pattern leaves stops out (`Pattern.run`), one file per 4 shards (`scheduleFile`), loaded only when a trip's schedule opens.
   `data/manifest.json` points to the current build.
10. **Map data** (`src/mapdata.ts`, formats in `packages/shared/src/netmap.ts`) – what the web app
   actually loads, so phones never download the whole network:
   - `core.json` (~0.7 MB gzip): cities only (names, positions, importance, shard) + tile index;
     the only data needed to start.
   - `tiles/{z}/{x}/{y}.pbf.gz` (z2–9, ~4100 files, ~30 MB gzip total, + `tiles-m/` z2–6 for mode filters; only tiles that contain data):
     gzipped Mapbox vector tiles of the drawn network (layers `seg`, `city`, and at z9 also `st` stations),
     overzoomed beyond z9. z9 (extent 8192 ≈ 6 m) holds the stored
     geometry almost unsimplified, z7/z8 are simplified to ~200 / ~100 m. Features are filter-independent: per category width/LOD level; the
     style packs the visible categories side by side. Low zooms only hold what is shown
     there, with equal neighbouring segments merged. Lines are revealed as a whole: per category,
     corridors (hops between consecutive stations) that meet in a station where exactly two of them
     meet form a chain (`packages/shared/src/lines.ts`, ends at junctions), and a chain gets the
     earliest LOD level of its hops – a route no longer shows up piece by piece because its
     patterns skip different stops. LOD is density-aware
     (`packages/shared/src/density.ts`): the target is a roughly even amount of ink per screen
     cell, so where the map around a line is sparse, whole chains of regional rail, coach and bus
     lines appear as early as the budget allows (floors: long-distance 3, regional/coach 4, bus 5),
     in importance order within an ink budget (3000 px of line per 256 × 256 px, checked on a
     64 px grid over a 192 px window, so a sparse region next to a dense one – Northern Ireland,
     Northern England, the Balkans – fills up on its own), never in dense areas beyond the
     budget, and only connected to the visible network (by city); computed globally in the ETL, so
     neighbouring tiles always agree. **Mode filters**: the levels are computed for every subset of
     the four modes (15 scenarios sharing one pass, ~40 s; only the subset's own ink counts, so
     with "Coach" alone the coaches fill the room the trains left; a subset never shows a line later
     than a superset). Tiles store the all-modes level `l{k}` plus, where it differs, the subset levels
     packed as base-16 digits `s{k}` (cities: `n{k}`), and the style picks the digit of the active
     filter. Up to z6 a filtered view loads its own tile set `tiles-m/` (~9 MB, 134 files: the union of
     all scenarios is 2–3× heavier at low zoom), so the default view stays light; from z7 `tiles/`
     serves every filter (the protocol redirects). Lines fade in over 0.7 zoom levels ending at their level
     (`FADE_ZOOM`; tile z already holds everything that starts fading in before z+1), city
     markers/labels and stations fade the same way (style `line-opacity` / `circle-opacity`
     interpolated over zoom with per-feature stops). Stored gzipped because static hosts don't
     compress protobuf; the app inflates them (DecompressionStream).
   - **Cities and stations in the UI**: zoomed out a click selects the *city* (reach = the union over all its stations);
     from `STATION_ZOOM` (10.5) the dots and labels of stations are clickable and select that *one station* (reach and
     timetables only use trips boarding there; URL `#from=paris&station=gare-de-lyon`, the slug of the station's short
     name; the panel lists the city's stations as buttons and "All of Paris" returns to the city). Nothing marks a
     city's member stations permanently: only while a city (or one of its stations) is selected, a soft ring is
     drawn around each of its stations (`member-ring-*`, stronger for the chosen one). Timetable rows always show the
     station each departure leaves from / arrives at.
     In the panel's station list, stations without departures under the mode filter are greyed out (tooltip: which modes
     serve them; `logic/stations.ts`), long lists get a search field, and the timetable's date opens a month calendar with a
     dot on every day the pair's service runs (`serviceDates`). Modes are drawn with one pictogram each (`ui/icons.ts`).
   - **Trip schedule** (`logic/schedule.ts`, panel view `schedule`, URL `&legs=…&trip=1`): a departure opens the whole run of
     its vehicle – every stop of the pattern from its first stop (shards hold every pattern with its full stop list and the geo
     file every station those patterns call at, so no extra data is needed; regional *buses* only keep stops in towns ≥ 1000
     inhabitants, see `processTripStops`). Stops are drawn on a vertical line in the mode colour from boarding to alighting,
     grey before and after; a stop shows its departure (first / intermediate stops), its arrival (last stop, alighting stop) or
     both when it dwells more than 5 minutes (`DWELL_SHOW_MIN`), in the stop's local time with day shifts (+1) and foreign zone names
     relative to the boarding date. Every stop after boarding (outside the boarding city) opens the onward connections from it
     (`chooseStop`: the leg's alighting stop becomes that stop) and shows how many there are (3 h window, the vehicle itself not
     counted), computed lazily when its row scrolls into view (`App.onwardCount`, loads that city's shard). Onward connections
     start from the arrival *station* only; "All stations of X" (offered once per city, for places with several stations and
     importance ≥ 0.6, shown once it adds departures; URL `onward=city`, toggle in the connections view) boards anywhere in the
     city with the walking transfer time (`CityFile.transfers`, at least `minTransfer`; stations too far apart to walk are not
     combined, see the walking transfers below). Back goes
     connections → schedule → departures. On the map the ridden part is highlighted as before and the rest of the run (before
     boarding / after alighting) is drawn thin and faded (`Highlight.context`, layers `hl-ctx*`).
   - **Connections with changes** (`logic/transfer.ts`, worker `data/transfer.worker.ts`, client `data/transfer.ts`; URL
     `changes=1|2`, `mintransfer=<min>`, `wait=<min>|day`, written only when they differ from the defaults 0 / 10 / same day; the
     minimum transfer and maximum wait are also remembered in localStorage). The city panel shows "{n} direct destinations", then
     "{m} destinations with 1 same-day connection" (and with 2) with a pencil that opens the settings dialog: number of connections
     (0 = direct only, the default; 1; 2), minimum transfer time (at the same station; a change between two stations of a city takes at
     least the walk between them, `CityFile.transfers`), walk or cycle between stations (URL `xfer=bike`, remembered too; see
     the walking transfers below) and maximum waiting time (1–12 h or "same day":
     the connecting departure leaves before local midnight of the arrival; an arrival between midnight and 04:00 may not wait
     out the night, `NIGHT_END_MIN`). The search runs for the travel day (the view's date, else
     today, origin-local; a date bar under the count changes it), mode filters apply to every leg. Lists: "Major destinations / Other
     places (direct)", then the same per level "(with 1 connection)", "(with 2 connections)", each place with the change city of its
     fastest journey ("via Limoges") and that journey's duration; lists of places with connections render 300 rows until "Show all" or
     a filter. On the map direct lines keep their colour and width, lines ridden after one change are drawn thin in the category colour
     at ~50 % opacity, after two changes at ~25 %, everything else stays grey (layer `hl-xfer`, built as GeoJSON in the worker); the
     1500 most important places reached with changes get lighter dots / labels. A place reached only with changes opens the
     **journeys view** (a pair without a direct service, `renderJourneys`): the journeys of the day grouped by *route option*
     (`logic/journeygroups.ts`: the brand of every leg and the change cities, e.g. "Intercités → Marseille-St-Charles → TER" or
     "TGV INOUI → Paris → TGV INOUI"; header with the duration range, changes and runs a day, below it one row per departure with
     the change time and the walk), each journey matched back to the boarding cities' shards (`matchLeg`) for route names; a row
     opens the journey's legs (schedule of the last leg, crumbs, the walk between stations shown with the change).
     - **Continuing a journey** (`App.renderExtension`, URL `next=<city>`, then `parts=<n>,…`): while a journey (or a trip's
       schedule, or the connections from a stop) is shown, tapping another city on the map – or naming one in the "Continue from X"
       box under the journey – searches the journeys from the city where it ends to that city, leaving after its arrival
       (`SearchParams.after`: first legs board no earlier than the minimum transfer time / the walk from the arrival station, and
       within the maximum wait or the same day; at least 1 change, the set number if higher). The list is the journeys view with a
       "Continuing A → B" line and "Search A → C instead" (the old tap behaviour); a row appends its legs and opens the joined
       journey (header A → C, all legs and changes). `parts` records where joined journeys end, so Back drops the last
       continuation; journeys can so be built beyond the 2 changes searched at once (Bordeaux → Ventimiglia → Genova).
     - **Search**: round-based (RAPTOR-like) over trips, not a time-expanded graph. Round 1 boards every trip leaving the origin on
       the day and records an arrival event at every later stop (intermediate stops included); round r + 1 boards at every city
       reached in round r every trip whose departure is feasible after one of the city's arrivals (transfer time per station pair,
       maximum wait / same day; arrivals per city sorted by time with a range maximum over the origin departure, so the boarding
       picks the latest origin departure in O(log n)). The last round of a reach search keeps one entry per pattern and boarding stop
       (the best "slack"), not per trip. Results per city: first round, fastest duration, change city, modes; hops ridden per round
       for the map.
     - **Journeys between a pair** (`searchOptions`): a plain RAPTOR keeps one label per trip (the latest origin departure), so a
       slower option riding into the same or another fast train is merged away (Bordeaux → Nice: Intercités → Marseille → TGV
       vanished behind TGV → Paris → TGV, and TER onward services behind the TGV). The pair search therefore runs the earlier
       rounds only to load the chunks, then a multi-label search whose label is the *brand sequence* of the legs so far
       (`TtChunk.pBrand`, `routeBrand`: route name without line / train number, "FlixBus N1138" → "FlixBus"; regional buses
       count by mode): a trip is boarded once per brand sequence arriving in time, every onward service of a change city is
       kept per arriving sequence. Events are only stored in cities from which the target is still reachable with the legs left
       (time-independent backward pass over the loaded patterns), which keeps it cheaper than the old single-label pair search.
       Results: per brand sequence the Pareto set over (later departure, earlier arrival), ties by the longer change; a journey is
       dropped when one with fewer changes and no other brand departs no earlier and arrives no later, or when it takes more than
       twice the fastest journey + 1 h. Measured (Mon 19 Oct, all chunks loaded, desktop Node): Bordeaux → Nice rail 0.3 s,
       all modes 0.75 s, Paris → Nice rail 0.5 s, London → Edinburgh 3.5 s (old: 0.4 / 2.8 / 2.0 / 5.1 s); in the browser
       (dev build, headless Chromium, chunks not cached) Bordeaux → Nice 2.1 s, of which 1 s loading.
     - **Walking transfers** (`packages/shared/src/walk.ts`, used by the ETL and the web app): a change between two stations of a
       city is always a walk, never a metro / bus ride (local transport is not in the timetable), so its time is a conservative
       estimate for every station pair: straight-line distance × 1.3 (street detour) at 75 m/min (4.5 km/h) + 3 min, rounded up,
       and at least the minimum transfer time; e.g. Paris Montparnasse → Gare de Lyon (4.1 km straight) is 75 min, 5.4 km.
       Pairs farther apart than a 2 h walk (6.75 km straight, ≈ 8.8 km on foot) get no walking transfer, i.e. no change between them
       is offered. The ETL writes the minutes of every pair within that range to `CityFile.transfers` and the transfer timetable
       chunks; the journeys view shows "75 min walk Montparnasse → Gare de Lyon (Paris) · 5.4 km". In the search, arrivals at
       stations out of walking range of a departure station are left out of that station's range maximum (a filtered copy of the
       city's arrivals, cached per excluded set).
       With "Cycle" in the settings (`TransferSettings.changeBy = "bike"`) a change between stations is a bike ride instead:
       the same street distance at 14 km/h including stops (233 m/min; measured urban averages are ≈ 15–15.5 km/h in
       Copenhagen, 14.4 km/h in Amsterdam, 16.9 km/h in Arnhem, so the conservative end) + 5 min to take and park the bike,
       rounded up, at most 1 h (≈ 9.9 km straight); a change is still walked where that is no slower (short ones).
       Montparnasse → Gare de Lyon becomes "29 min cycle · 5.4 km", which makes e.g. the 05:39 Bordeaux → Paris TGV and the
       09:10 to Nice (1 h 01 between them) a journey. The ride time is derived from the stored walking minutes
       (`cycleMinutesFromWalk`: street distance ≤ (walk − 3) · 75 m, so at most a minute conservative), so the data has one
       number per pair; the ETL stores pairs up to `TRANSFER_MAX_M` (the cycling range; walking minutes above 120 are only
       used by bike). That is 194 k pairs instead of 156 k: +0.1 MB (1.2 %) of gzipped transfer chunks, +1.2 MB (0.1 %) of
       city shards; search times unchanged.
     - **Data** (`packages/shared/src/tt.ts`, written by the map-data stage, `src/transfers.ts`): every pattern and trip of the
       shards deduplicated (416 k patterns (a pattern per brand), 2.19 M trips; shards repeat a pattern for every city it calls at, ~3 M times), as gzipped
       varint chunks (version 2: a brand per pattern, names in `TtIndex.brands`): chunk 0 = the *trunk* (all long-distance trains and coaches of Europe, 1.1 MB gz) and 32 regions (k-d split of
       the cities by regional rail / bus departures, 0.08–0.36 MB gz each; a regional pattern is in every region it can be boarded
       in), plus per chunk a line file (corridor → segment codes, segments simplified to 100 m, 1e-4° coordinates; 4.7 MB gz in
       all) and `tt/index.json` (chunk of every city). 8 MB + 4.7 MB gz, 67 files. A search loads the trunk plus the regions of the
       cities where it changes; the worker keeps loaded chunks for later searches.
     - **Measured** (full build, Tue 20 Oct, desktop Node; chunk download excluded, decode included): Orléans k=1 0.6 s (9 chunks,
       2.4 MB), Berlin k=1 1.0 s (23 chunks, 5.9 MB), Paris k=1 1.2 s (26 chunks, 6.4 MB), Gien k=1 0.2 s; k=2: Bad Belzig 0.3 s,
       Gien 1.4 s, Berlin 4.9 s, Paris 5.5 s (1.2–1.4 M arrival events, ~100 MB worker memory, all 33 chunks). In the browser
       (production build, headless Chromium without GPU, local files): Orléans k=1 2.3 s for the first search (worker start, 13 chunks,
       lines included), Berlin k=1 2.9 s, Paris k=1 2.6 s, Gien 0.3 s with chunks cached, Berlin k=2 8.7 s; the list shows after the
       search, the lines (line files + GeoJSON, 1.1–1.5 s for k=1) follow. **Maximum k = 2**: one
       connection stays around a second on a desktop (a few seconds on a mid-range phone, off the main thread, results shown per
       round); two connections are fine from towns but take 5–15 s from big hubs (and then cover nearly all of Europe), so the
       dialog warns about it; a third round would load and scan everything for every origin and add little information.
   - `geo/<shard>.json` (~80 KB gzip on average): for each timetable shard, the corridors its patterns
     use (with segment geometry, for the selection highlight) and the stations it references
     (names/positions). Loaded together with the shard on a click. Highlighted lines are sized by the
     selection's own trips/day (the selected city's / pair's patterns, a journey leg = 1), not by the line's
     total traffic, and a pair is drawn from the first stop of each trip in the origin city.
   `manifest.json` points to `core.json` and lists the tiles (`Manifest.mapdata`) and the transfer timetable (`Manifest.transfers`, `tt/index.json`).
   Rebuild just this stage for an existing build: `node --import tsx packages/etl/src/mapdata.ts <out>/<build>`.

11. **Local transport** (`src/urban/`, formats in `packages/shared/src/urban.ts`) – metro, tram, light rail,
   funicular / cable car and city bus lines with their stops, a *display layer* beside the intercity network: it has
   no timetables, no cities and no shards (urban trips would multiply both), only lines and stops shown from
   zoom 10 / 12. Own pass over the cached feed zips (`work/cache/feeds`: the intercity feeds of `feeds.json` plus
   the extra ones of `urban-feeds.json`, ~60 city feeds such as IDFM, Madrid, Barcelona, Rome, Milan, Warsaw, Budapest,
   Prague, Helsinki, Lisbon…, downloaded into the same cache), its own in-memory DuckDB, per-feed results cached in
   `work/urban/feeds/*.json.gz`:
   - **Extraction** (`extract.ts`): route types 0/5/9xx tram, 1/12/400-402/405 metro, 6/7/13xx/1400 cable, 3/11/7xx bus
     (rail-replacement, school, shuttle and coach operators dropped). Per route and direction the most frequent
     shape (or headsign) plus up to two frequent variants, one representative trip each (a few trips per route, so
     `stop_times` is filtered down before it is read); trips per direction on a typical weekday (a Wednesday a week
     after the start date) give `tpd`, shown as "every ~10 min". City buses are lines whose stops lie ≥ 60 % inside
     the disc (4–16 km, grows with population) of a place with ≥ 100 000 inhabitants and span ≤ 30 km;
     metro / tram / cable lines are kept anywhere.
   - **Alignment**: the feed's `shapes.txt` where there is one (simplified to 3 m); lines without shapes (all of
     DELFI, GB, CH, SE, …) are routed hop by hop between their stops on a tram / metro / light-rail track graph
     (`rail/urbanrail-graph-v1.bin`, Overture classes the intercity rail graph drops) – buses on the road graph
     (motorway…tertiary) – with a detour bound; ≥ 70 % routed hops make the alignment `rail` / `road`, else the
     line stays a straight stop-to-stop chain, drawn dashed (`g` = 3). Duplicates (the opposite direction, the same
     line in two feeds) are dropped by name + geometry overlap (`dedupeLines`).
   - **Stations** (`model.ts`): the stops are merged with the same `mergeStations` as the intercity stations
     (names, proximity, `parent_station`), "City, Stop" names lose the city (`stripCityName`), every station knows its
     lines. A station at an intercity station (≤ 90 m, or ≤ 350 m with the same normalised name) is flagged `x` and
     gets no dot or label of its own. **Adaptive merging over zoom**: stations are ranked by importance (lines ×
     mode × frequency) and each takes the first zoom level (10.5, 11.5 … 14.5) at which no more important station
     within ~24 px is already shown (`thinZooms`, buses 14 / 14.8 at 12 px), so a centre shows its hubs first and
     fills in as one zooms; a stop never appears before its first line. Lines have a first zoom too (`lineZoom`):
     metro 10 / 10.8 (≥ 100 trips per direction and day), tram 11.2 / 12 / 12.6, cable 12.5, buses 12.4 … 14.2 by frequency.
   - **Tiles**: two vector sources, `urban/rail/10/{x}/{y}.pbf.gz` (metro / tram / cable lines and the stops of
     stations with such a line; extent 16384 ≈ 2.4 m) and `urban/bus/11/…` (bus lines and bus-only stops; extent 8192), stored at
     one zoom only, non-empty tiles only (`Manifest.urban` lists them, the app answers the rest with an empty tile) and overzoomed by MapLibre.
     Lines are `ul` (mode, short name, feed colour clamped to a readable luminance, agency, description, tpd, first zoom, geometry quality),
     stops `us` (name, mode mask, line names, importance, first zoom, `x`).
   - **Web** (`map/urban.ts`, `ui/urbanpopup.ts`): drawn *below* the intercity network (land-coloured halo,
     thin, buses grey and thinner), fading in over 0.6 zoom levels after their own first zoom; labels (stop names from z12.4, line
     names along the line) sit below the intercity labels so those win collisions. A click / tap on a stop or line opens a small popup (line chips, modes,
     operator, frequency band); hover shows the name. The chip "Local transport" (on by default; `#local=0` in the URL when off)
     hides all of it. Nothing of this loads below zoom 10.
   Rebuild just this stage for an existing build: `node --import tsx packages/etl/src/urban/index.ts <out>/<build>`
   (~1 min with warm caches, ~15 min when the zips of all feeds must be re-read), or skip it with `--no-urban`.

The coastline and lakes are not part of a build: `data/basemap-v2/` (next to `manifest.json`, shared by all
builds, `Manifest.basemap`) holds OSM land polygons + Natural Earth 10m lakes as gzipped vector tiles z2–z9
(extent 8192 at z9 ≈ 6 m, overzoomed to z15), ~4.9k files / ~31 MB. Tiles without land are missing (sea) and
tiles entirely covered by land are missing too but listed in `basemap-v2/index.json`; the web app answers them
with a synthetic all-land tile (`web/src/map/basemap.ts`). The tiles are built by `refresh-assets` as ONE R2 object
(`basemap/tiles-v2.tar`) and unpacked by every build (see `.claude/skills/basemap/SKILL.md`).

Typical full build: ~150 feed files, ~920k stops → ~73k stations (served) in ~41k cities, ~125k corridors on ~176k line-graph segments, ~2.1M trips,
~1.4 GB in ~12.9k files incl. ~4.9k basemap tiles and ~2.4k local-transport tiles (Cloudflare limit: 20k files per deployment); ~12 min on a 4-core machine with a warm DuckDB
(`--reuse-db`; ~16 min on a runner incl. loading, plus ~1 min to download assets). The local-transport stage adds ~7 min when its per-feed caches are cold
(129 feeds with local lines: 21k lines / 25k alignments, 179k stations, 2 384 tiles / 11 MB gz, largest tile 86 KB).

## Running locally

```sh
pnpm install
# small subset (ids from packages/etl/feeds.json), output into packages/web/public/data
pnpm --filter @etbm/etl run build-data -- --out packages/web/public/data --feeds de-gtfsde-fv,de-gtfsde-rv,at-rail,ch-national,eu-flixbus
pnpm dev                       # http://localhost:5173

# full Europe (≈ 15 min, ~8 GB RAM, ~10 GB disk in ./work)
pnpm --filter @etbm/etl run build-data -- --out work/out
# rail/coach only
pnpm --filter @etbm/etl run build-data -- --out work/out --subset core
```

Useful flags: `--work <dir>` (cache/DuckDB, default `./work`), `--reuse-db` (skip download+load when
inputs are unchanged – handy when iterating on later stages), `--no-geometry`, `--no-basemap`, `--no-urban`,
`--assets <dir>` (default `work/assets`), `--extract-rail` (allow the slow Overture extraction locally),
`--start YYYY-MM-DD`, `--days 60`. A build report (stats per stage/country, sanity checks) is written to
`<work>/build-report.json`.

Without assets the ETL downloads GeoNames/Natural Earth itself; corridor geometry needs the rail and road graphs
(`pnpm --filter @etbm/etl run assets -- --only rail,road`, ~30 min each the first time, or download
`rail/rail-graph-v1.bin` / `road/road-graph-v1.bin` from R2 into `work/geometry/`), otherwise corridors are drawn as curves.

Tests: `pnpm test`, types: `pnpm typecheck`.

## Weekly refresh & deployment

- **`.github/workflows/build-deploy.yml`**
  - *schedule* (Mondays 03:17 UTC) and *manual dispatch*: download assets from R2, run the full
    ETL, cache the output (`actions/cache`, keyed by a hash of the ETL/schema sources), build the web
    app, assemble `dist/site` (web + `data/` under `BASE_PATH`, repo variable, default `/`) and
    `wrangler deploy` (static-assets Worker, `wrangler.jsonc`).
  - *push*: reuses the cached data (web-only rebuild + redeploy, a few minutes); data is rebuilt
    only when no compatible cached data exists (ETL/schema code changed).
  - A keepalive step re-enables the workflow, since GitHub disables schedules in repositories
    without activity for 60 days.
- **`.github/workflows/refresh-assets.yml`** (monthly + manual): rebuilds the slow-changing inputs and
  uploads them to the R2 bucket `eurotrainbusmap-assets`: `geonames/places-europe.tsv.gz` (pruned
  GeoNames, ~2 MB), `basemap/{borders,labels}.json` (Natural Earth 1:10m borders, country labels), `basemap/tiles-v2.tar` (land + lake vector tiles from OSM land polygons, ~31 MB, rebuilt with `--only tiles`: ~1 GB download, ~3 min), `rail/urbanrail-graph-v1.bin` (tram / metro / light-rail track for local-transport lines without shapes, ~2 MB), `rail/rail-graph-v1.bin` (rail graph from the
  Overture rail extract incl. disused/under-construction track at high cost and bridged gaps, ~27 MB),
  `road/road-graph-v1.bin` (motorway…tertiary road graph, 30 m geometry, ~114 MB) and `manifest.json`.

Secrets: `CLOUDFLARE_API_TOKEN` (Workers deploy + R2) and `CLOUDFLARE_ACCOUNT_ID`.

## Costs

Designed to run for free:

- **GitHub Actions** – free for public repositories (weekly ~20–30 min job, monthly asset refresh).
- **Cloudflare Workers static assets** – requests to static assets are free; ~10k files ≈ 1.1 GB per
  build (limits: 25 MiB per file, 20k files per deployment on the free plan).
- **Cloudflare R2** – ~80 MB stored, a handful of operations per week: well inside the free tier
  (10 GB storage, 1M class A / 10M class B ops per month, no egress fees).
- **Data sources** – free/open (Transitous mirror, Mobility Database, GeoNames, Natural Earth,
  Overture/OSM, OSM land polygons). Transitous is a community service: the pipeline downloads once a week with a
  descriptive User-Agent. Licences/attribution are listed in the app ("Data sources").
