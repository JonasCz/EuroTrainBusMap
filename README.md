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
    src/geometry/       corridor geometry: rail routing on a graph built from Overture (OSM) rail
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
   train category tokens and operators; Deutschlandticket and night-train flags are set.
3. **Cities** – every stop is assigned to a GeoNames place (population-scaled radius, city districts
   and city-state units absorbed into their city, local names such as "München", "Praha", "İstanbul");
   stops far from any place form synthetic towns (rail/coach only). Bus stops only count in places
   with ≥ 2000 inhabitants.
4. **Stations** – stops merged by parent station, proximity + name similarity and across feeds.
5. **Dedup** – the same train/coach present in several feeds (DE+AT+CH+CZ…) is detected by matching
   (city, time) sequences and kept once, with merged calendars.
6. **Patterns & trips** – station sequences with offsets, deduplicated; calendars as 60-day bitmasks.
7. **Corridors** – undirected edges between consecutive cities, with trips/day per category and
   geometry routed on the rail graph (simplified to city-level detail).
8. **Output** (`data/<build>/`): `network.json` (packed, ~9 MB raw / ~3.5 MB compressed),
   `calendars.json`, `attribution.json`, `basemap/*.json` and `shard/<n>.json` – the per-city
   timetables, grouped into ~600 shards of spatially neighbouring cities (`City.shard`).
   `data/manifest.json` points to the current build.

Typical full build: ~150 feed files, ~36k cities, ~76k stations, ~70k corridors, ~2.1M trips,
~1.1 GB in ~640 files; ~15 min on a 4-core runner (plus ~1 min to download assets).

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
inputs are unchanged – handy when iterating on later stages), `--no-geometry`, `--no-basemap`,
`--assets <dir>` (default `work/assets`), `--extract-rail` (allow the slow Overture extraction locally),
`--start YYYY-MM-DD`, `--days 60`. A build report (stats per stage/country, sanity checks) is written to
`<work>/build-report.json`.

Without assets the ETL downloads GeoNames/Natural Earth itself; rail geometry needs the rail graph
(`pnpm --filter @etbm/etl run assets -- --only rail`, ~30 min the first time, or download
`rail/rail-graph-v1.bin` from R2 into `work/geometry/`), otherwise corridors are drawn as curves.

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
  GeoNames, ~2 MB), `basemap/*.json` (Natural Earth), `rail/rail-graph-v1.bin` (rail graph from the
  Overture rail extract, ~19 MB), and `manifest.json`.

Secrets: `CLOUDFLARE_API_TOKEN` (Workers deploy + R2) and `CLOUDFLARE_ACCOUNT_ID`.

## Costs

Designed to run for free:

- **GitHub Actions** – free for public repositories (weekly ~20–30 min job, monthly asset refresh).
- **Cloudflare Workers static assets** – requests to static assets are free; ~640 files ≈ 1.1 GB per
  build (limits: 25 MiB per file, 20k files per deployment on the free plan).
- **Cloudflare R2** – ~25 MB stored, a handful of operations per week: well inside the free tier
  (10 GB storage, 1M class A / 10M class B ops per month, no egress fees).
- **Data sources** – free/open (Transitous mirror, Mobility Database, GeoNames, Natural Earth,
  Overture/OSM). Transitous is a community service: the pipeline downloads once a week with a
  descriptive User-Agent. Licences/attribution are listed in the app ("Data sources").
