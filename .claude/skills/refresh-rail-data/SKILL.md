---
name: refresh-rail-data
description: Rebuild the prebuilt rail routing graph (Overture Maps rail -> pruned graph -> rail/rail-graph-v1.bin in R2) used to draw rail corridors along real tracks. Use when Overture publishes a new release, when routes look wrong/missing because of outdated track data, after changing the graph format or costs in packages/etl/src/geometry, or when the weekly build warns "no rail graph".
---

# Refresh rail data

Rail corridors are routed on a graph built from Overture Maps rail segments. Extracting Overture
takes 15-30 min, so the graph is built rarely and stored in R2:

- bucket `eurotrainbusmap-assets`, key `rail/rail-graph-v<FORMAT>.bin` (FORMAT = `RAIL_FORMAT` in
  `packages/etl/src/geometry/railbin.ts`, currently 1). About 19 MB, zstd-compressed.
- The weekly build downloads it to `work/geometry/` and points `ETBM_RAIL_GRAPH` at it.
  `buildGeometries` loads it in about 1 s.

## Normal refresh (CI)

Run the **refresh-assets** workflow (Actions → refresh-assets → Run workflow). It also runs
monthly. It calls `packages/etl/src/assets.ts`, which calls
`buildRailAsset(workDir, outFile, log)` from `packages/etl/src/geometry/refresh-rail.ts`
and uploads the result together with the other assets. Check the log for the line
`rail: wrote … (NN MB, release YYYY-MM-DD.N)`.

## Local build / debugging

```sh
cd packages/etl
pnpm rail:refresh ../../work            # -> ../../work/geometry/rail-graph-v1.bin
# reuse an existing Overture extract instead of downloading again:
ETBM_RAIL_PARQUET=/path/rail-europe-<release>.parquet pnpm rail:refresh ../../work
```

- It resolves the latest Overture release from https://stac.overturemaps.org/catalog.json.
  Set `ETBM_OVERTURE_RELEASE` to pin one. The extract is cached as
  `<workDir>/overture/rail-europe-<release>.parquet`.
- DuckDB is capped by `ETBM_GEOMETRY_DUCKDB_MEMORY` (default 4GB) and runs 4 threads, so peak RSS is about 2.8 GB. `AWS_*`
  env vars are hidden from DuckDB because sending credentials to the public bucket returns 403.
- If you change the binary layout, bump `RAIL_FORMAT`. That changes the key name, so old builds keep
  working until the new file is uploaded and the build is updated.

## Verify

```sh
cd packages/etl
npx vitest run src/geometry
node --no-warnings --import tsx src/geometry/demo.ts ../../work /tmp/geom-demo
```

The demo loads the graph file, routes 10 reference pairs and prints `success 11/11`. Examples:
Köln–Frankfurt on the high-speed line, London–Paris through the Channel Tunnel,
København–Malmö over the Øresund bridge. It also writes `demo.png`. Open it and check that
the coloured lines follow the grey tracks. Then run the data build and check the
`geometry: … rail N (routed X, …, fallback Y)` log line. Fallbacks should be a small fraction.
