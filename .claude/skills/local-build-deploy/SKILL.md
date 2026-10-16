---
name: local-build-deploy
description: Run the full EuroTrainBusMap data build, preview it and deploy it to Cloudflare from a local or cloud-session machine instead of GitHub Actions. Covers downloading the R2 assets, the full ETL command and its timings, iterating on only the map-data stage or on later stages with --reuse-db, assembling dist/site, wrangler whoami / dry-run / deploy, previewing with vite and Playwright screenshots, and the gotchas. Use when you need real data locally (to debug rendering, LOD, geometry or station merging), want to test an ETL change on the full network before pushing, or must deploy without the workflow.
---

# Local full build, preview and deploy

Mirrors `.github/workflows/build-deploy.yml` step by step. Needs `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in the environment for the R2 download and the deploy (never print them).
Machine used so far: 4 cores, 15 GB RAM, ~30 GB free disk. The build peaks at ~6 GB RSS and
uses ~12 GB of disk in `work/` (`work/` and `dist/` are git-ignored).

All commands run from the repo root unless noted. `node --import tsx` only resolves when the
current directory is inside `packages/etl` (tsx is a dependency of that package only).

## 1. Install and download the R2 assets

```sh
pnpm install
mkdir -p work/assets
B=eurotrainbusmap-assets
npx -y wrangler@4 r2 object get "$B/manifest.json" --file work/assets/manifest.json --remote
for key in $(node -e 'console.log(require(process.argv[1]).files.join("\n"))' "$PWD/work/assets/manifest.json"); do
  mkdir -p "work/assets/$(dirname "$key")"
  npx -y wrangler@4 r2 object get "$B/$key" --file "work/assets/$key" --remote || echo "MISSING $key"
done
```

Gives `basemap/{land,borders,lakes,labels}.json`, `geonames/places-europe.tsv.gz`,
`rail/rail-graph-v1.bin` (19 MB), `road/road-graph-v1.bin` (53 MB); takes about a minute. Without the
graphs corridors become unsnapped curves, so do not skip them (see the `refresh-geometry-assets` skill).

## 2. Full data build (~22 min wall clock on 4 cores)

```sh
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE AWS_DEFAULT_REGION AWS_REGION
export ETBM_RAIL_GRAPH=$PWD/work/assets/rail/rail-graph-v1.bin
export ETBM_ROAD_GRAPH=$PWD/work/assets/road/road-graph-v1.bin
rm -rf work/out-new
nohup pnpm --filter @etbm/etl run build-data -- --out $PWD/work/out-new --work $PWD/work \
  --assets $PWD/work/assets --subset full > work/build.log 2>&1 &
tail -f work/build.log        # stages are logged as "=== stage: <name>"
```

When it finishes (`=== done` / exit 0, `work/out-new/manifest.json` exists):

```sh
rm -rf work/out && mv work/out-new work/out
```

Do NOT run the workflow's cleanup line (`rm -rf work/etl.duckdb work/cache/feeds work/tmp`) if you want
to iterate: the DuckDB file and the feed cache are what make `--reuse-db` and re-runs fast.
`--subset core` (rail + coaches only) is much faster for smoke tests. A build report with per-stage
seconds, stats, failed feeds and sanity checks is written to `work/build-report.json`.
Feeds are downloaded from Transitous/Mobility Database through the session proxy; if a download
fails with TLS/403 see `/root/.ccr/README.md`.

## 3. Iterate without a full rebuild

Output layout: `work/out/manifest.json` (points at the current build) and `work/out/<build>/`
(`network.json`, `core.json`, `tiles/`, `geo/`, `shard/`, `city/`, `basemap/`, ...).

- Only the map data stage (tiles, core.json, geo files; changes to `packages/shared/src/{netmap,lod,density}.ts`
  or `packages/etl/src/mapdata.ts`; about 1-3 min):
  ```sh
  cd packages/etl && node --import tsx src/mapdata.ts ../../work/out/<build>
  ```
  It reads `network.json`, rewrites `tiles/`, `core.json`, `geo/*` and updates `manifest.json`.
  It does not re-run geometry, segments or the timetable.
- Later ETL stages (everything after download+load: cities, stations, dedup, patterns, corridors,
  geometry, segments, output; changes to `packages/etl/src/{build.ts,core/*,geometry/*}`):
  ```sh
  pnpm --filter @etbm/etl run build-data -- --out $PWD/work/out-new --work $PWD/work \
    --assets $PWD/work/assets --subset full --reuse-db      # same env vars as above
  ```
  `--reuse-db` skips download and load when feeds/start date/config are unchanged (it checks
  `work/db-state.json`; a change to `feeds.json` or the start date forces a reload). Add `--no-geometry`
  to skip routing, `--no-basemap` to skip the basemap, `--start YYYY-MM-DD` to pin the calendar window.
- Quick checks: `pnpm typecheck` and `pnpm test` (see "Status" below).

## 4. Assemble and deploy

```sh
pnpm --filter @etbm/web build                 # BASE_PATH env if not served at "/" (workflow uses vars.BASE_PATH, default "/")
base="${BASE_PATH#/}"; base="${base%/}"
site=dist/site; target="$site${base:+/$base}"
rm -rf "$site" && mkdir -p "$target"
cp -r packages/web/dist/. "$target/"
rm -rf "$target/data" && mkdir -p "$target/data"
cp -r work/out/. "$target/data/"
rm -f "$target"/data/*/network.json "$target"/data/*/network-*.json     # network.json is for tools only
if [ -n "$base" ] && [ -f "$target/_headers" ]; then sed "s#^/#/$base/#" "$target/_headers" > "$site/_headers" && rm "$target/_headers"; fi
find "$site" -type f | wc -l; du -sh "$site"
find "$site" -type f -size +25M      # must print nothing (Workers asset limit 25 MiB; 20k files on the free plan)
```

Then:

```sh
npx -y wrangler@4 whoami                       # token check (account name + id only)
npx -y wrangler@4 deploy --dry-run             # validates wrangler.jsonc + dist/site, uploads nothing
npx -y wrangler@4 deploy                       # REAL deploy to the live site; only on explicit request
```

`wrangler.jsonc`: Worker `eurotrainbusmap`, static assets from `./dist/site`, `workers_dev: true`.
Live URL: `https://eurotrainbusmap.<subdomain>.workers.dev`; the account's workers.dev subdomain is
`jonascz`, i.e. **https://eurotrainbusmap.jonascz.workers.dev** (look it up with
`GET /accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain` using the token; `data/manifest.json` there shows
which build is live). A deploy replaces the live site for everybody, and the weekly workflow will
overwrite it again on its next run (Mondays 03:17 UTC) or on the next push to main.

## 5. Preview locally

Dev server against the built data (the app fetches `${BASE_URL}data/manifest.json`):

```sh
rm -rf packages/web/public/data && ln -s ../../../work/out packages/web/public/data   # or cp -r
# remove the symlink again before committing/deploying: public/ is copied into dist/
pnpm dev            # http://localhost:5173 (vite hot-reloads web code; data is static)
```
`network.json` is never fetched by the app, so no need to strip it for dev. Alternatively serve the assembled
`dist/site` (`npx http-server dist/site -p 8080`) to test exactly what gets deployed.

Screenshots with Playwright (global install, Chromium preinstalled; never run `playwright install`):

```js
// shot.cjs - node shot.cjs <url> <out.png> <lon> <lat> <zoom> [waitMs]
const { chromium } = require("/opt/node22/lib/node_modules/playwright");
(async () => {
  const [url, out, lon, lat, zoom, wait] = [process.argv[2], process.argv[3], +process.argv[4], +process.argv[5], +process.argv[6], +(process.argv[7] ?? 4000)];
  const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  p.on("console", (m) => { if (m.type() === "error") console.log("console.error:", m.text().slice(0, 200)); });
  await p.goto(url, { waitUntil: "networkidle" });
  await p.waitForFunction(() => window.__etbm && window.__etbm.map.loaded(), null, { timeout: 60000 });
  await p.evaluate(([lo, la, z]) => window.__etbm.map.jumpTo({ center: [lo, la], zoom: z }), [lon, lat, zoom]);
  await p.waitForTimeout(wait);
  await p.screenshot({ path: out });
  await b.close();
})();
```
The app exposes `window.__etbm = { app, map, net }` (packages/web/src/main.ts), so the script can jump the
camera (the URL hash only carries selection state, not the view). WebGL works headless through SwiftShader.
Example: `node shot.cjs http://localhost:5173/ /tmp/x.png -7.95 52.49 11`. Keep scripts outside the repo.

## 6. Inspecting the data

- `core.json` -> `unpackCore` (packages/shared/src/netmap.ts) gives all cities; `geo/<shard>.json` -> `unpackGeo`
  gives stations, corridors (with segment ids, cats, tpd, snapped) and segment polylines for the shard
  (`City.shard` says which); `shard/<n>.json` has the timetable patterns.
- `tiles/{z}/{x}/{y}.pbf.gz` are gzipped MVTs: gunzip + `@mapbox/vector-tile` (in `node_modules/.pnpm`); layer `seg`
  properties `l{k}` (LOD level index into LEVELS), `w{k}` (width), `u` (unsnapped), `hop`, `term`.
- Test routing on the prebuilt graphs: `deserializeRailGraph(readFileSync(".../rail-graph-v1.bin"))` + `new Router(graph, opts)`
  from `packages/etl/src/geometry/` (do not import `geometry/index.ts` from a script: ERR_REQUIRE_ASYNC_MODULE; copy `MAX_DETOUR`).
- The deployed site's `/data/<build>/...` files (core, geo, shard, tiles) are public, handy to look at the live build without building.

## Status of checks (last run)

`pnpm typecheck` passes (shared, etl, web); `pnpm test` passes (etl 88 tests, web 39 tests, ~10 s each). `wrangler whoami` works with the env token;
`wrangler deploy --dry-run` succeeded on the assembled `dist/site` (1781 files). Expected harmless build warnings: a few feeds with
"no trips within the horizon" (it-regional-bus lombardia/liguria, es-feve, navarra bus, ba-zfbih), stop-names "not found within 1500 m",
"Berlin is missing station Berlin Ostbahnhof".

## Gotchas

- `--reuse-db` also refuses (and silently rebuilds from scratch = re-download) when `packages/etl/feeds.json` changed at all,
  because its length and hash are part of the key in `work/db-state.json`. After a change that does not affect loading
  (e.g. removing an option that is only read at build time), rewrite `key.cfgLen` / `key.cfgHash` in that file
  (`cfgHash = text.split("").reduce((h,c)=>(Math.imul(h,31)+c.charCodeAt(0))|0, 7)`) instead of reloading.
- Screenshots: while `vite` runs, editing web sources hot-reloads the page and resets the camera, so do not edit
  during a screenshot run; wait for `map.loaded()` after each `jumpTo`, and never run two Playwright jobs at once
  (SwiftShader makes each view take ~25 s). Do not `pkill -f` / `pgrep -f` a pattern that also appears in your own
  command line (it kills or matches the calling shell).

- `node --import tsx ...` fails ("Cannot find package 'tsx'") outside `packages/etl`.
- The workflow's cleanup step (`rm -rf work/etl.duckdb ...`) defeat `--reuse-db`; skip it locally.
- Measured full build (147 feeds, 0 failed): download+load 742 s, cities 35 s, stations 99 s, calendars 13 s, dedup 26 s, patterns 87 s,
  corridors 10 s, geometry 63 s, output 44 s, segments 147 s, mapdata 52 s, total 22 min; peak RSS ~6 GB; output 1.1 GB / 1692 files
  (assembled dist/site: 1781 files, 1.1 GB, no file over 25 MiB). The build id is the Berlin date of the day before the start date + time (e.g. `20261015-1428`).
  Download+load is the slow part (several 300-600 MB zips); geometry routing and the line graph are single-threaded.
- Clock/timestamps in the cloud sandbox can look inconsistent between tool calls; trust the `[ MmSSs]` prefix in `work/build.log`.
- The build holds up to ~6 GB RSS (`--max-old-space-size=8192` is set by the `build-data` script), so do not run other heavy jobs in parallel on a 15 GB machine.
- `wrangler deploy` prints a proxy warning ("Proxy environment variables detected") - harmless.
- `wrangler whoami` shows the account e-mail; do not paste it or the token into reports.
- Helper scripts outside the repo must be `.mts` (top-level await; `.ts` is treated as CJS) and import repo code by absolute path
  (`/home/user/EuroTrainBusMap/packages/shared/src/index.ts`; `@etbm/shared` does not resolve from the scratchpad). Run them with
  `cd packages/etl && node --import tsx <script.mts>`.
- Never `pkill -f <pattern>` where the pattern appears in your own command line (it killed the calling shell); find the pid with `ps aux | grep "[p]attern"`.
- Tiles now go up to z9 (TILE_MAXZOOM): ~4100 tile files (~20 MB gz), full build ~5400 files / 1.2 GB; Cloudflare allows 20k files, so z10
  (~+9k files) would still fit but leaves little headroom. A `mapdata`-only run takes ~2 min.
- A foreground command is moved to the background after 120 s; for long waits use `Monitor` (until-loop) or poll with `timeout 110 bash -c 'until ...'`.
- Preview symlink `packages/web/public/data` is excluded via `.git/info/exclude`; remove it before deploying.
