# geometry

Corridor geometries for the map: `buildGeometries(reqs, { workDir, log })` (see `index.ts`).

- **rail**: route on a rail graph built from Overture Maps rail segments, between the stations
  of the corridor's representative hop (first hop that routes; up to 3 tried), in two passes
  (`guide.ts`):
  1. A plausible feed `shape` that lies on the track (≥ 90 % within 150 m, `onTrack`) *guides*
     the route: edges away from it cost up to ×4 (`shapeEdgeMult`), so the line follows the real
     path but keeps the graph's track geometry (if the guided route does not cover the shape, the
     shape itself is drawn). Without such a shape: shortest path, as before (a crude shape is still used when the routed path is
     >1.3× longer than the shape, or when routing fails).
  2. **Track usage**: the trains per day of every hop routed in pass 1 are summed per graph edge
     (long-distance and regional separately, copied onto parallel track of double-track lines
     mapped as two ways). Hops of ≥ 25 km without a guiding shape are routed again with lightly
     used track up to ×2 more expensive (`usageMult`: log scale, 1 at 1000 trains/day; a
     long-distance hop counts regional trains at 25 %; its own pass-1 trains count by its
     confidence, 1 up to 60 km then 60 km / length). Non-stop trains then stay on the main line
     the stopping trains mark instead of the shortest branch line.
  3. **High-speed lines** (`guide.ts`, no extra asset): edges whose cost per metre is below 0.985 lie on a
     line *named* as a high-speed line (the ×0.85 / ×0.93 multipliers below; every other multiplier is ≥ 1).
     Each rail request carries `tpdHs` (trains/day of high-speed services: TGV, OUIGO, ICE, AVE, Frecciarossa,
     Eurostar…, route_type 101; `isHighSpeedService` in `core/classify.ts`) and the fastest scheduled time
     between its stations of high-speed (`minHs`) and other trains (`minConv`). A hop whose trains are mostly
     conventional (night trains, Intercités, TER, IC, RE) and whose route uses ≥ 2 km / 10 % of high-speed
     track (end edges not counted) is routed again with high-speed edges ×4; the new route is kept unless the
     timetable would mean > 140 km/h on it (then the train must be on the high-speed line: Belgian IC on HSL 2,
     TER GV, Southeastern on HS1). A high-speed service slower than 90 km/h along its high-speed route is
     moved off it the same way. Pass two keeps the ×4 for hops moved in pass one.
  4. **No reversing at junctions** (`route.ts`): the A* runs on directed edges, and passing from one branch of
     a fork onto the other (edge directions at the node, taken 150 m along each edge, within 45°) costs
     half the hop's straight-line distance, at most 50 km (`RAIL_ROUTER_OPTS`). Before, a stop next to a fork
     could back onto the other branch (Libourne → Angoulême over LGV SEA via Ambarès, Paris → Sens reversing
     near Montereau). Road and tram graphs keep `reversalCost` 0.
  Otherwise a straight great-circle line (`snapped: false`).
- **road**: plausible feed shape, else a gentle curve bulging 5 % to the left of west→east
  (`snapped: false`).
- Lines are attached to the city points (trimmed to the closest approach; Bézier lead-in when
  the city dot is behind the station), smoothed with adaptive Chaikin and rounded to 5 decimals.

## Files

| file | |
|---|---|
| `overture.ts` | resolves the latest Overture release (STAC), extracts Europe rail to `<workDir>/overture/rail-europe-<release>.parquet` (cached; ~13 min, ~220 MB), loads it into a graph |
| `graph.ts` | typed-array graph: vertices shared between segments = junctions, degree-2 chains contracted, edge geometry Douglas-Peucker simplified (20 m), grid index over edge sub-segments |
| `route.ts` | multi-candidate station snapping (≤1.5 km) + A* over directed edges with detour bound and an optional reversal cost at forks; optional per-query edge cost multipliers (`RouteOptions.edgeMult`), returns the path's edges |
| `guide.ts` | steering rail routes: feed shapes on the track (`onTrack`, `shapeEdgeMult`, `coverage`), track usage (`TrackUsage`, `usageMult`) and high-speed lines (`highSpeedEdges`, `avoidHighSpeed`) |
| `geo.ts` | haversine, simplify, smoothing, curves |
| `demo.ts` | routes 10 well-known pairs, writes GeoJSON + PNG preview |

Kept Overture classes: `standard_gauge`, `narrow_gauge`, `unknown` (tram, subway, light_rail,
funicular, monorail dropped); segments flagged `is_abandoned` / `is_disused` /
`is_under_construction` dropped. Overture has no service/siding or speed attributes, so costs are
tuned by name: high-speed line names (LGV, alta velocità, HS1, …) ×0.85, German
Schnellfahrstrecke/Neubaustrecke ×0.93, freight-only ×1.4, unknown gauge ×1.05.

Sources checked for better high-speed / usage tags (2026-10): Overture rail segments carry no maxspeed,
highspeed, usage or service (release 2026-09-23.1); OSM itself is not reachable in bulk from the build
sandbox (Overpass API and Geofabrik refused by the proxy, openrailwaymap.app tiles may not be bulk
downloaded by its usage policy, country extracts at download.openstreetmap.fr are 2.5-6 GB each). The OSM
line names kept by Overture cover the French and Spanish LGV/LAV network well (~6.5k km of track each),
German NBS (~2.4k km), Belgian HSL and HS1; Italian AV lines only partly (Italian feeds have shapes).
A timetable-derived label (track of hops averaging ≥ 200 km/h, minus track of short slow conventional
hops) was tried and dropped: it marked short classic pieces at junctions and in station throats, and
Swiss / Austrian new lines that conventional trains do use. Note: the graph also holds some OSM
*proposed* lines named as LGV (GPSO Bordeaux–Toulouse / Bordeaux–Dax) without the construction flag.

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


## Update: roads incl. tertiary, rail status flags, bridging, stubs

- Road classes: motorway, trunk, primary, secondary, **tertiary** (+ links). Extract 1.99 GB parquet (~30 min),
  graph 3.5 M nodes / 5.2 M edges, 30 m geometry, 114 MB file, ~530 MB in memory. Coach/bus fallbacks 1452 → 196
  (the rest: lakes, islands, ferries).
- Rail: `is_abandoned` / `is_disused` / `is_under_construction` segments are no longer dropped but cost ×6 / ×4 / ×3
  (OSM tags e.g. a 3.5 km piece of the operating Madrid–Cáceres line as disused). `bridgeGaps` (graph.ts) joins dead
  ends within 300 m to track of another component (splitting the edge there, cost ×3 per metre) before pruning.
  Rail fallbacks 130 → 87 (remaining: stations > 1.5 km from any heavy-rail track in Overture: tram / light rail / metro).
- `attach`: lines end at their own terminal; a straight stub to the city point only if ≤ `STUB_MAX_M` (1 km).
  Unsnapped curves start at the main hop's stations instead of the city points.
- Debug aid: `ETBM_DUMP_GEOM_REQS=<file>` makes build.ts write the geometry requests, so routing can be iterated on
  with `buildWithRouter` in ~1 min instead of a 10 min `--reuse-db` build.

## Update: routes follow the track trains use (shape guidance + track usage)

Problem: a hop without intermediate stops was drawn on the shortest track, often a slow branch line. Example: an
ÖBB NJ 457 variant (2 days, diversion) listed only Berlin Südkreuz → Brno; the shortest path ran Praha – Čerčany –
Sázava branch – Světlá – Havlíčkův Brod – Brno (515 km), while all other Berlin – Budapest trains ran via Kolín –
Pardubice – Česká Třebová. Overture has no usage / service / speed / electrification / track-count tags for rail
(the segment schema has `speed_limits` and `routes`, see the skill), so the data comes from the timetables:

- **Feed shapes guide the route** instead of only replacing it when routing detours >1.3×: 14.8 k of 49.8 k rail
  corridors are now routed along their shape (CZ, IT, PL, NL, DK, HR, RO, ES Cercanías … have shapes on the track;
  DE, AT, CH, FR, GB, BE, SE, NO, HU have none). On 1603 shaped hops ≥ 25 km the plain shortest path disagreed with the
  shape on 107 (< 80 % within 300 m); the guided route on 3.
- **Kept duplicates adopt shapes**: when cross-feed dedup keeps a trip without a shape (e.g. the ÖBB copy of a
  Railjet) it takes the shape of a dropped copy (the SŽ one), so its Czech hops follow the SŽ path (1866 trips in the
  full build).
- **Track usage** (pass 2) for the rest: measured on the shaped hops as ground truth (shape not used), usage-weighted
  routing reduced disagreement from 107 to 61 (54 fixed, 8 made worse — mostly diversion trips with < 0.5 trains/day
  whose shape is used anyway). ~150 long hops move, e.g. Lyon – Clermont-Ferrand via Roanne (not the closed Thiers line), Berlin Südkreuz – Brno via Kolín – Pardubice – Česká Třebová,
  Hamburg – København via Jutland (not over the Fehmarnbelt tunnel under construction), Madrid – Alicante on the HSL.
  Tuning (eval on the dumped requests, `ETBM_DUMP_GEOM_REQS`): ×3 max or a 200 trains/day full-usage point were worse;
  fully excluding a hop's own trains made single-corridor lines (Parma – Reggio Emilia) look unused; weighting regional
  trains 100 % for long-distance hops pulled Frecce off the Torino – Milano HSL onto the busier classic line.
- Cost: full-build geometry stage 165 s (was 110–130 s); usage incl. parallel-track spreading 15–25 s, pass 2 ≈ 9 s.
- No graph change was needed: `rail-graph-v1.bin` is unchanged (no new asset in R2).
