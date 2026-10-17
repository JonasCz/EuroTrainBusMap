# EuroTrainBusMap

A transit-diagram style map of intercity rail and bus connections across Europe (incl. UK,
CH, NO, the Balkans, Turkey and Ukraine). Click a city to see every city reachable by a
*direct* train/coach/bus, click a pair for the timetable, click a departure for onward
connections. Fully static: a weekly pipeline turns ~150 public GTFS feeds into JSON files
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
   fallback; one carrying exactly the name of a rail / coach station within 1 km joins that station's place) and only count in places
   with ≥ 2000 inhabitants. Synthetic towns with a generic name (≥ 4 of them: "Road End", "Hotel", "Mairie") get the nearest place
   added ("Road End (Strathy)"). Cities never influence the drawing.
5. **Dedup** – the same train/coach present in several feeds (DE+AT+CH+CZ…) is detected by matching
   (city, time) sequences and kept once, with merged calendars.
6. **Patterns & trips** – station sequences with offsets, deduplicated; calendars as 60-day bitmasks starting the day before the build (Berlin date), so viewers in earlier timezones stay covered.
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
   timetables, grouped into ~600 shards of spatially neighbouring cities (`City.shard`).
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
   - `geo/<shard>.json` (~80 KB gzip on average): for each timetable shard, the corridors its patterns
     use (with segment geometry, for the selection highlight) and the stations it references
     (names/positions). Loaded together with the shard on a click. Highlighted lines are sized by the
     selection's own trips/day (the selected city's / pair's patterns, a journey leg = 1), not by the line's
     total traffic, and a pair is drawn from the first stop of each trip in the origin city.
   `manifest.json` points to `core.json` and lists the tiles (`Manifest.mapdata`).
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
