---
name: refresh-geometry-assets
description: Rebuild the prebuilt routing graphs used to draw corridors along real infrastructure. These are the rail graph (rail/rail-graph-v1.bin, for trains), the major-road graph (road/road-graph-v1.bin, for coaches and buses) and the tram / metro track graph (rail/urbanrail-graph-v1.bin, aligns local-transport lines that come without shapes). Both are built from Overture Maps and stored in R2. Use when Overture publishes a new release, when lines look wrong or miss new track or roads, after changing the graph format, costs, or road classes in packages/etl/src/geometry, or when the weekly build warns "no rail graph" or "no road graph".
---

# Refresh geometry assets (rail + road graphs)

Corridor lines are routed on two graphs built from Overture Maps transportation segments.
Extracting each one from Overture takes about 30 min, so they are built monthly and stored in R2.
The bucket is `eurotrainbusmap-assets`:

| key | content | size |
|---|---|---|
| `rail/rail-graph-v1.bin` | standard, narrow and unknown gauge rail (disused / abandoned / under-construction kept at ×4 / ×6 / ×3 cost), 20 m geometry, gaps < 300 m bridged, fragments < 3 km dropped | ~27 MB |
| `rail/urbanrail-graph-v1.bin` | Overture rail classes `tram`, `subway`, `light_rail`, `funicular`, `monorail` (the other graphs drop them), 20 m geometry, dead ends within 60 m of other track joined, fragments < 600 m dropped; ~2 MB (23 MB extract, ~23 min to extract, 5 s to build). Used only by the local-transport layer (`packages/etl/src/urban/align.ts`), `ETBM_URBAN_RAIL_GRAPH` overrides | ~2 MB |
| `road/road-graph-v1.bin` | motorway, trunk, primary, secondary and tertiary roads plus their `_link` ramps, 30 m geometry, fragments < 20 km dropped | ~114 MB (3.5 M nodes, ~530 MB RAM) |

`v1` is `RAIL_FORMAT` in `packages/etl/src/geometry/railbin.ts`. The file format is shared and
`header.kind` says whether a file is rail or road. If you change the binary layout, bump the
format. That changes the keys, so builds using the old keys keep working.

The weekly build (`build-deploy.yml`) downloads every key in the R2 `manifest.json` into
`work/assets/` and exports `ETBM_RAIL_GRAPH` and `ETBM_ROAD_GRAPH`. If neither is set,
`buildGeometries` also looks in `<work>/geometry/` and `<work>/assets/<kind>/`. If a graph is
missing, the corridors become unsnapped curves and the log shows a `WARNING`.

## Normal refresh (CI)

Run the **refresh-assets** workflow: Actions → "Refresh build assets (R2)" → Run workflow. It
also runs monthly on the 4th.
- `only` takes a comma-separated subset of `geonames,basemap,tiles,rail,urbanrail,road`. Use `rail,road` to rebuild only the graphs.
- It runs `packages/etl/src/assets.ts`. That calls `buildRailAsset` / `buildRoadAsset` from
  `packages/etl/src/geometry/refresh-rail.ts`, then uploads the results and `manifest.json` (last).
- The Overture extracts are kept in the Actions cache (`overture-v2-*`). A re-run on the same
  release skips the S3 scan; a new release is detected through the STAC catalog and re-extracted.
- The Actions cache key is `overture-v3-*`: bump it whenever the extract definition (classes, flags) changes, or an old extract of the same release is reused.
- Check the log for these lines: `rail: wrote …`, `road: wrote … (NN MB, release …)`, and `pruned … components`.

## Local build / debugging

```sh
cd packages/etl
pnpm rail:refresh ../../work            # -> ../../work/geometry/rail-graph-v1.bin
pnpm rail:refresh ../../work --road     # -> ../../work/geometry/road-graph-v1.bin
pnpm assets -- --out ../../work/assets --work ../../work --only urbanrail   # -> work/assets/rail/urbanrail-graph-v1.bin
# all assets, like CI:
pnpm assets -- --out ../../work/assets --work ../../work --only rail,road
```

- The latest release comes from https://stac.overturemaps.org/catalog.json. To pin one, set
  `ETBM_OVERTURE_RELEASE`. Extracts are cached as `<work>/overture/{rail,road}-europe-<release>.parquet`.
  To reuse an existing file, set `ETBM_RAIL_PARQUET` / `ETBM_ROAD_PARQUET`.
- DuckDB memory is capped by `ETBM_GEOMETRY_DUCKDB_MEMORY` (default 4GB). It uses 4 threads, spills to disk and
  keeps no external file cache. `AWS_*` env vars are hidden from DuckDB, because the bucket is public and
  sending credentials gives a 403.
- Measured times are in `packages/etl/src/geometry/README.md`.
  - Rail: ~28 min to extract, ~1 min to build.
  - Road: ~28 min to extract (994 MB), ~4 min to build. Peak RSS ≈ 1.2 GB for the graph, 2–3 GB for DuckDB.

## Verify

```sh
cd packages/etl
npx vitest run src/geometry
node --no-warnings --import tsx src/geometry/demo.ts ../../work /tmp/geom-demo
```

The demo loads both graphs and should print `success 14/14`. It checks 10 rail pairs, for
example Köln–Frankfurt on the high-speed line and London–Paris through the Channel Tunnel. It
also checks 3 coach pairs (Berlin–Praha via Dresden, Wien–Budapest via Győr, Madrid–Valencia)
and one ferry (Bari–Igoumenitsa), which must stay an unsnapped curve. Open `demo.png` and check
that each coloured line follows the grey network.

After a data build, look at the log line
`geometry: … rail N (routed X, …, fallback Y), road M (routed R, shape S, fallback F; T s)`.
Fallbacks should be a small fraction.

## Gotchas learned

- The road extract with `tertiary` is 1.99 GB / ~30 min (4 classes: 1 GB); `pnpm rail:refresh ../../work --road` then needs ~2 GB RSS
  for the graph and ~8 min for build + zstd-19. The graph geometry tolerance (`ROAD_SIMPLIFY_TOL`) caps road accuracy: 50 m was too coarse.
- Rebuilding a graph from a cached parquet takes 1-8 min, so tolerance / bridging / cost experiments are cheap. Run the rail and road
  extracts in the background with `NODE_USE_ENV_PROXY=1`; two at once work (they share the proxy; ~1 h for both).
- Why a corridor does not route: snap the stations (`Router.snap`), compare components, route with a huge `maxLen`. Typical causes:
  OSM tags a piece of an operating line `is_disused` (now kept at a cost), a siding ends 100-200 m short of the main line (bridged),
  station > 1.5 km from heavy-rail track (tram / light rail, not in the graph).
- Fast geometry iteration: run the build once with `ETBM_DUMP_GEOM_REQS=work/geom-reqs.json`, then call `buildWithRouter(reqs, rail, log, road)`
  from a `.mts` script (about 1 min for all 69k corridors).
- Overture rail segments carry no usage / service / maxspeed / electrification / track-count information: in release
  2026-09-23.1 `subclass`, `speed_limits` and `routes` are empty for every rail segment (checked around Pardubice), only
  `rail_flags` (is_passenger, is_freight, is_bridge, is_tunnel, is_covered, is_disused, is_abandoned) and names. So
  "which line do trains really take" is not a graph cost question: it is solved at routing time in
  `packages/etl/src/geometry/guide.ts` (feed shapes guide the route; hops ≥ 25 km are re-routed by the trains/day of
  all other hops per edge). Tune it on a geometry dump (`ETBM_DUMP_GEOM_REQS`, requests carry `tpd` / `tpdLong`) with
  shaped hops as ground truth: route them without the shape and count how often the result covers < 80 % of the shape.
