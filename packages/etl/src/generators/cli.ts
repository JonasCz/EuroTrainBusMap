/**
 * Run feed generators on their own (packages/etl/generators), e.g. while writing or fixing one:
 *
 *   pnpm --filter @etbm/etl run generate -- ba-zfbih [--out feed.zip] [--start YYYY-MM-DD] [--days 60]
 *
 * Fetches the live source, validates the feed, writes the zip (default: work/generated/<id>.zip, never the build's
 * feed cache) and prints a summary of the trips. Without an id, every generator runs. Exit code 1 when one fails.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { todayIn } from "../core/time.ts";
import { loadFeedsConfig } from "../feeds.ts";
import { runGenerator } from "./registry.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const argv = process.argv.slice(2).filter((x) => x !== "--");
const get = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ids = argv.filter((x, i) => !x.startsWith("--") && !(i > 0 && argv[i - 1]!.startsWith("--")));
const startDate = get("--start") ?? todayIn("Europe/Berlin", new Date(Date.now() - 86_400_000));
const days = Number(get("--days") ?? 60);

const cfg = await loadFeedsConfig(join(here, "../../feeds.json"));
const gens = cfg.generators!.generators;
const todo = ids.length ? ids : [...gens.keys()];
let failed = 0;
for (const id of todo) {
  const g = gens.get(id);
  if (!g) {
    console.error(`no generator "${id}" (have: ${[...gens.keys()].join(", ")})`);
    process.exit(2);
  }
  const feedKey = cfg.feeds.find((f) => f.sources.some((s) => "generated" in s && s.generated === id))?.id ?? id;
  const out = resolve(get("--out") && todo.length === 1 ? get("--out")! : join(repoRoot, "work", "generated", `${id}.zip`));
  const { report, feed } = await runGenerator(g, feedKey, { userAgent: cfg.userAgent, startDate, days, dest: out, tmpDir: join(dirname(out), "tmp"), ...(cfg.staleMaxDays ? { staleMaxDays: cfg.staleMaxDays } : {}) });
  console.log(JSON.stringify(report, null, 1));
  if (!feed) {
    failed++;
    continue;
  }
  console.log(`\n${id}: ${out}`);
  const stopName = new Map(feed.stops.map((s) => [s.stop_id, s.stop_name]));
  const route = new Map(feed.routes.map((r) => [r.route_id, r]));
  const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  for (const t of feed.trips) {
    const st = feed.stopTimes.filter((s) => s.trip_id === t.trip_id).sort((a, b) => a.stop_sequence - b.stop_sequence);
    const dates = feed.services.get(t.service_id)!;
    console.log(
      `${route.get(t.route_id)!.route_short_name} ${t.trip_short_name ?? t.trip_id}  ${stopName.get(st[0]!.stop_id)} ${hm(st[0]!.dep)} → ${stopName.get(st[st.length - 1]!.stop_id)} ${hm(st[st.length - 1]!.arr)}  ${st.length} stops  ${dates.length} days (${dates[0]} … ${dates[dates.length - 1]})`,
    );
  }
}
process.exit(failed ? 1 : 0);
