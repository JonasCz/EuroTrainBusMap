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
- Skill: `.claude/skills/refresh-geometry-assets/SKILL.md`.

## Road graph (coach / bus corridors)

Coach and bus corridors (mode `road`) are routed on a major-road graph using the same machinery as rail.

- **Extract:** Overture `subtype='road'`, classes `motorway, trunk, primary, secondary`. Their `_link`
  ramps are included because they have the same class with `subclass='link'`. Segments flagged
  abandoned or under construction are dropped. The bbox is Europe plus Turkey, the same as rail.
  - Columns: `class, subclass, connectors, geometry`.
  - Result: 6.17 M segments, 994 MB parquet, ~28 min through the proxy. DuckDB RSS stays at ~0.6 GB with the 4 GB limit.
- **Topology:** roads join and cross in the middle of segments, so nodes come from the Overture
  connector ids (64-bit hash). Shared coordinates are not used. Each segment is cut at its
  connectors, so a bridge over a road does not become a junction.
  - Chains through degree-2 nodes are contracted.
  - Geometry is simplified to 50 m.
  - Components with less than 20 km of road are dropped. That leaves 1.85 M nodes, 2.74 M edges and 186 components.
- **Cost:** length × (110 km/h ÷ class speed). Class speeds are motorway 110, trunk 90, primary 70, secondary 60 and links 50 km/h.
- **Asset:** `road/road-graph-v1.bin`, the same `railbin.ts` format with `header.kind = 'road'`. It is 53.3 MB.
  Without `secondary` it would be 27.4 MB, but regional buses mostly use secondary roads, so they stay in.
  - Building it takes ~4 min from the cached extract, with peak RSS 1.2 GB.
  - Loading it takes ~4–8 s and uses 263 MB of arrays.
- **Routing:**
  - A plausible feed shape is used first.
  - Otherwise the corridor is routed between the hop's stops. Snapping reaches up to 5 km, because rural stops are often a few km from the nearest secondary road. The route must be at most 2.2× the straight-line distance plus 5 km.
  - Otherwise it falls back to the gentle curve, with `snapped: false`. That covers ferries (Bari–Igoumenitsa, Helsinki–Tallinn, Dover–Calais), islands, and short local hops where only minor roads exist.
  - Road-routed lines are `snapped: true`.
- **Loader:** `opts.roadGraph`, then env `ETBM_ROAD_GRAPH`, then `<work>/geometry/road-graph-v1.bin`, then
  `<work>/assets/road/road-graph-v1.bin`. A missing graph gives curves with a WARNING, the same as rail.

### Route cache: not needed (measured)

Full-Europe build, 4 vCPU sandbox, single thread:

| | |
|---|---|
| Road corridors routed | 37,585 in **39.7 s** |
| Routed on roads | 36,103 (96.1 %) |
| From feed shapes | 18 |
| Fallback curves | 1,464 |
| Graph load | 8 s |

That is far below the 2–3 min threshold. The expensive part is the monthly graph build, so there is no persistent
route cache, and nothing needs to go to R2 between weekly builds. An in-run cache already reuses repeated
stop pairs. If routing ever gets slow, the plan was a cache keyed by graph sha + endpoint pair rounded to ~100 m,
stored as `road/route-cache-v1.bin`.

### Output size

`build.ts` simplifies road-routed corridors to **300 m (coach) / 500 m (bus)**. Unsnapped curves stay at 400 / 800 m.
`network.json` grows from 8.94 MB to **10.16 MB raw** (4.37 MB gzip).
