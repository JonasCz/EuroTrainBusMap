# geometry

Corridor geometries (rail routed on Overture rail segments, road as smooth curves).

## Dependencies needed in packages/etl/package.json

- `@duckdb/node-api` (dependency) — Overture extraction + reading the cached GeoParquet
- `vitest` (devDependency, root already has it) — `src/geometry/*.test.ts`
- `playwright` (devDependency, optional) — only for `demo.ts` PNG preview (falls back to the global install)
