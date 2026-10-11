/**
 * Export coach/bus stop-name review candidates (JSONL), see core/stopnames.ts.
 *   pnpm --filter @etbm/etl run stops:candidates -- --out <file> [--work <dir>] [other build-data flags]
 * Runs the build up to the station stage, re-using the DuckDB database of the last build
 * (--reuse-db) when its inputs are unchanged.
 */
import { resolve } from "node:path";

const a = process.argv.slice(2).filter((x) => x !== "--");
const i = a.indexOf("--out");
const out = i >= 0 ? a[i + 1]! : "stop-candidates.jsonl";
if (i >= 0) a.splice(i, 2);
process.argv = [process.argv[0]!, process.argv[1]!, "--stop-candidates", resolve(out), ...(a.includes("--reuse-db") ? [] : ["--reuse-db"]), ...a];
await import("./cli.ts");
