---
name: basemap
description: Rebuild or debug the basemap (coastline, lakes, borders) of EuroTrainBusMap. Land and lakes are gzipped vector tiles built from OSM land polygons + Natural Earth 10m lakes and stored in R2 as one tar (basemap/tiles-v2.tar); borders and country labels are small GeoJSON files. Use when the coastline looks coarse or wrong, when OSM publishes new land polygons, after changing tile zooms / simplification in packages/etl/src/basemap, or when the file count of the site gets close to the 20k limit.
---

# Basemap (land, lakes, borders)

| what | source | where it ends up |
|---|---|---|
| land | OSM land polygons, `land-polygons-complete-4326.zip` from https://osmdata.openstreetmap.de/download/ (923 MB, ODbL; reachable through the session proxy; 1.3 GB `.shp`, 334k polygons / 24 M points inside the Europe bbox) | vector tiles, layer `land` |
| lakes | Natural Earth 10m `ne_10m_lakes` + `ne_10m_lakes_europe` (GitHub mirror nvkelso/natural-earth-vector, raw.githubusercontent.com) | vector tiles, layer `lake` |
| borders | Natural Earth 10m `admin_0_boundary_lines_land`, 4 decimals (11 m), 308 KB | `data/<build>/basemap/borders.json` (GeoJSON) |
| country labels | Natural Earth 50m countries | `data/<build>/basemap/labels.json` |

The OSM *land* polygons are the complement of the coastline: sea is the map background, inland lakes are
NOT removed from them (hence the NE lakes). The "split" variant (`land-polygons-split-4326`) was not used: its
pieces cause hairline seams between neighbouring polygons; the "complete" one has islands as separate
polygons and no artificial cuts. `simplified-land-polygons-complete-3857` is not needed: per-zoom simplification
(Douglas–Peucker with 0.35 px tolerance, 0.02 px ≈ 3 m at z9 and geojson-vt tolerance 0 there, islands below 0.8 px dropped; at 0.12 px the coast showed visible facets at z13) is done by the tiler.

## Build

```sh
# all slow-changing basemap assets into work/assets (basemap/borders.json, labels.json, tiles-v2.tar)
pnpm --filter @etbm/etl run assets -- --out $PWD/work/assets --work $PWD/work --only basemap,tiles
# only the tiles, with an unpacked copy for inspection:
cd packages/etl && node --max-old-space-size=8192 --import tsx src/basemap/tiles.ts --out /tmp/x --cache $PWD/../../work/cache/basemap-src --unpacked /tmp/x/unpacked
```
About 3 min and 3.6 GB RSS on 4 cores, after the 923 MB download (cached in `work/cache/basemap-src`; the
`.shp` is unzipped next to the zip). Result: `basemap/tiles-v2.tar` = 30.9 MB: `index.json` (46 KB) + 4900 tile files.

| zoom | tile files | gz size | all-land tiles (no file) |
|---|---|---|---|
| 2–5 | 4 / 9 / 18 / 46 | 0.03–0.25 MB | 0 |
| 6 | 136 | 0.55 MB | 0 |
| 7 | 417 | 1.2 MB | 25 |
| 8 | 1197 | 2.5 MB | 335 |
| 9 | 3072 | 22.3 MB (largest tile 318 KB) | 2396 |

z9 uses extent 8192 (≈ 6 m, MapLibre's internal precision), tiles are 512 px, so z9 data is overzoomed up to z15
(z14 ≈ 2 px per unit; still crisp). z10 would add ~8k files: too many for the 20k-file limit (builds are ~5.4k files + 4.9k tiles).

## Design

- Files are the scarce resource (20k per deployment), so a tile is only written when it carries information:
  no land → no file (sea); land only and completely covering the tile (a single rectangle) → no file either, the
  tile is listed in `index.json` `land` (topmost such tile per branch; descendants inherit). The web protocol
  `etbmbase://` (`packages/web/src/map/basemap.ts`) loads `index.json`, fetches files, answers all-land tiles with a
  37-byte constant MVT and sea with an empty tile. Tiles with a lake are always files.
- Memory: z2–z5 are cut from all polygons at once, z6–z9 block by block (one z5 tile + 12 % margin at a time), polygons
  are quantised to 1e-5° (1 m) when read.
- R2 gets ONE object (`basemap/tiles-v2.tar`, plain ustar written by `src/basemap/tar.ts`) instead of 4.9k keys
  (wrangler uploads one key per call). Every build unpacks it to `<out>/basemap-v2-<coverage>/` (`installBasemapTiles`), next to
  `manifest.json`, and adds `Manifest.basemap` (`dir`, zooms, bounds). So the tiles live at the stable path
  `data/basemap-v2-<coverage>/…`, not in the build directories, are not re-uploaded by `wrangler deploy` when unchanged (content hash)
  and have their own cache rule in `packages/web/public/_headers` (1 week, not immutable; the `! Cache-Control` line detaches the
  `/data/:build/*` immutable header that would otherwise match too). The directory name carries `COVERAGE_ID` because the tiles are cached for a week under a stable URL (a new coverage = a new path, else browsers keep the old index and draw the new area as sea). Bump `BASEMAP_DIR` / `BASEMAP_TILES_KEY` (v3) for a
  format change; old builds keep working.
- Without the tar in the assets the build warns and the app draws the coarse 1:50m `land.json` / `lakes.json` (generated on the
  fly by `web/scripts/basemap.ts` with `legacyLayers`; also used by `make-fixture.ts`).

## Checking

Preview as in the `local-build-deploy` skill; jump to coasts at z12/z13 (Genoa 8.93/44.41, Bergen 5.32/60.39, Dubrovnik 18.09/42.65,
Dublin Bay -6.15/53.33). Rail lines (Overture/OSM geometry) and the OSM coastline come from the same source, so they match; stations
on piers or in harbours sit on the water side where OSM maps land as water.

## Upload to R2

Normally nothing to do: after a change to `packages/etl/src/basemap` bump `ASSETS_VERSION` (and update
`ASSETS_SOURCE_HASH`) in `packages/etl/src/assets-version.ts`; the next build-deploy finds R2's `version.json` out of
step and runs refresh-assets (all parts) before building. By hand, after `assets` finished locally (the refresh-assets
workflow does it itself; it also writes `version.json`, which a manual upload does not):
```sh
B=eurotrainbusmap-assets
npx -y wrangler@4 r2 object put $B/basemap/tiles-v2.tar --file work/assets/basemap/tiles-v2.tar --remote
npx -y wrangler@4 r2 object put $B/basemap/borders.json --file work/assets/basemap/borders.json --remote
npx -y wrangler@4 r2 object put $B/manifest.json --file work/assets/manifest.json --content-type application/json --remote   # last
```
