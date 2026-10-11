# geometry

Corridor geometries for the map: `buildGeometries(reqs, { workDir, log })` (see `index.ts`).

- **rail**: shortest path on a rail graph built from Overture Maps rail segments, between the
  stations of the corridor's representative hop (first hop that routes; up to 3 tried). A feed
  `shape` is used instead when the routed path is >1.3× longer than a plausible shape, or when
  routing fails. Otherwise a straight great-circle line (`snapped: false`).
- **road**: plausible feed shape, else a gentle curve bulging 5 % to the left of west→east
  (`snapped: false`).
- Lines are attached to the city points (trimmed to the closest approach; Bézier lead-in when
  the city dot is behind the station), smoothed with adaptive Chaikin and rounded to 5 decimals.

## Files

| file | |
|---|---|
| `overture.ts` | resolves the latest Overture release (STAC), extracts Europe rail to `<workDir>/overture/rail-europe-<release>.parquet` (cached; ~13 min, ~220 MB), loads it into a graph |
| `graph.ts` | typed-array graph: vertices shared between segments = junctions, degree-2 chains contracted, edge geometry Douglas-Peucker simplified (20 m), grid index over edge sub-segments |
| `route.ts` | multi-candidate station snapping (≤1.5 km) + A* with detour bound |
| `geo.ts` | haversine, simplify, smoothing, curves |
| `demo.ts` | routes 10 well-known pairs, writes GeoJSON + PNG preview |

Kept Overture classes: `standard_gauge`, `narrow_gauge`, `unknown` (tram, subway, light_rail,
funicular, monorail dropped); segments flagged `is_abandoned` / `is_disused` /
`is_under_construction` dropped. Overture has no service/siding or speed attributes, so costs are
tuned by name: high-speed line names (LGV, alta velocità, HS1, …) ×0.85, German
Schnellfahrstrecke/Neubaustrecke ×0.93, freight-only ×1.4, unknown gauge ×1.05.

Env: `ETBM_RAIL_PARQUET` (use a given extract), `ETBM_OVERTURE_RELEASE` (pin a release),
`ETBM_GEOMETRY_DUCKDB_MEMORY` (DuckDB memory_limit, default 4GB; 4 threads, spills to
`<workDir>/duckdb-tmp`, external file cache off — extraction RSS ≈ 2.5–2.8 GB, ~28 min via proxy).
AWS_* env vars are hidden from DuckDB during extraction (the bucket is public; sending
credentials gives 403). DuckDB extensions are cached in `<workDir>/duckdb-ext`; if `INSTALL`
fails (DuckDB fetches extensions over plain http), they are downloaded over https.

## Dependencies

`@duckdb/node-api` (in packages/etl/package.json). `demo.ts` needs `playwright` (uses the
global install when it is not a local dependency).

```sh
cd packages/etl
npx vitest run src/geometry
node --experimental-strip-types src/geometry/demo.ts <workDir> <outDir>
```

## Prebuilt rail graph (R2)

Extraction is slow, so the routing graph is built rarely, by the refresh-assets workflow (monthly or manual), with
`buildRailAsset(workDir, outFile, log)` from `refresh-rail.ts` (CLI: `pnpm rail:refresh [workDir] [outFile]`).
It runs extract → graph (20 m geometry) → drop fragments < 3 km of track → `railbin.ts` binary.

- R2: bucket `eurotrainbusmap-assets`, key `rail/rail-graph-v1.bin` (`RAIL_GRAPH_KEY`).
- Local default: `<workDir>/geometry/rail-graph-v1.bin` (`railGraphPath(workDir)`), or env `ETBM_RAIL_GRAPH`.
- `buildGeometries(reqs, { workDir, log, railGraph?, noExtract? })` loads it. If it is missing, the module
  extracts Overture (slow), or with `noExtract: true` uses unsnapped curves, and logs a WARNING either way.
- File: `ETBM` magic + JSON header (format, Overture release, bbox, created, counts, sections), then a
  zstd (or gzip) payload. The payload holds int32/float32 sections: edgeU, edgeV, edgeLen, edgeCost, geoCount, and geoDX/geoDY
  (1e-6° deltas). Node coordinates come from edge end vertices. Size is about 19 MB (0.92 M nodes, 1.15 M edges).
  Loading takes about 1.2 s and uses about 110 MB of arrays (process RSS about 0.3 GB).
- Skill: `.claude/skills/refresh-rail-data/SKILL.md`.
