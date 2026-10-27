/**
 * Condense the weekly build's result into a small file an agent can read quickly (build-deploy.yml uploads it to R2
 * next to the log, see "Run logs" in .claude/skills/add-virtual-feed/SKILL.md):
 *
 *   node --import tsx src/run-summary.ts --report work/build-report.json --log work/build.log --out work/run-summary
 *
 * writes <out>.json and <out>.txt: the run (GitHub run id / commit from the environment), the generated feeds with
 * their status, what needs geocoding (stops, routes left out, the command), failed / stale / expired feeds, changed
 * and removed timetable pages, and the last lines of the log if the build never wrote a report (it crashed).
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface GenReport {
  id: string;
  feed: string;
  ok: boolean;
  error?: string;
  warnings?: string[];
  seconds?: number;
  stale?: { until: string; reason: string };
  needsGeocoding?: { stops: { name: string; context: string; unchecked?: boolean }[]; dropped: string[] };
  pages?: { key: string; changed: boolean; isNew: boolean; lastChanged: string }[];
  removedPages?: string[];
  counts?: { trips: number; stops: number; routes: number };
}
export interface RunSummary {
  generatedAt: string;
  run: { id?: string; url?: string; sha?: string; ref?: string };
  buildFinished: boolean;
  build?: string;
  stats?: unknown;
  failedFeeds: unknown[];
  expiredFeeds: unknown[];
  staleFeeds: unknown[];
  generators: {
    id: string;
    feed: string;
    status: "ok" | "failed";
    error?: string;
    trips?: number;
    stale?: { until: string; reason: string };
    needsGeocoding?: { stops: { name: string; context: string; unchecked?: boolean }[]; dropped: string[]; command: string };
    changedPages: string[];
    newPages: string[];
    removedPages: string[];
    warnings: string[];
  }[];
  /** What an agent should do, one line each. */
  todo: string[];
  logTail?: string[];
}

export function summarize(report: any | null, logTail: string[], env: Record<string, string | undefined> = process.env): RunSummary {
  const gens: GenReport[] = report?.generated ?? [];
  const todo: string[] = [];
  const generators: RunSummary["generators"] = gens.map((g) => {
    const command = `pnpm --filter @etbm/etl run geocode -- ${g.id}`;
    if (g.needsGeocoding?.stops.length)
      todo.push(`GEOCODE ${g.id}: ${g.needsGeocoding.stops.length} stop(s) (${g.needsGeocoding.stops.slice(0, 10).map((s) => s.name).join(", ")}${g.needsGeocoding.stops.length > 10 ? ", …" : ""}); routes left out: ${g.needsGeocoding.dropped.length} – run \`${command}\`, review (MUST FIX first), \`--accept\`, commit data/geocodes/${g.id}.json`);
    if (!g.ok && !g.needsGeocoding) todo.push(`FIX generator ${g.id} (feed ${g.feed} skipped): ${g.error}`);
    if (g.stale) todo.push(`STALE ${g.id}: ${g.stale.reason} (valid until ${g.stale.until}) – kept, labelled out of date`);
    return {
      id: g.id,
      feed: g.feed,
      status: g.ok ? "ok" : "failed",
      ...(g.error ? { error: g.error } : {}),
      ...(g.counts ? { trips: g.counts.trips } : {}),
      ...(g.stale ? { stale: g.stale } : {}),
      ...(g.needsGeocoding ? { needsGeocoding: { ...g.needsGeocoding, command } } : {}),
      changedPages: (g.pages ?? []).filter((p) => p.changed).map((p) => p.key),
      newPages: (g.pages ?? []).filter((p) => p.isNew).map((p) => p.key),
      removedPages: g.removedPages ?? [],
      warnings: (g.warnings ?? []).slice(0, 60),
    };
  });
  for (const f of report?.failedFeeds ?? []) todo.push(`FEED failed to load: ${typeof f === "string" ? f : JSON.stringify(f)}`);
  if (!report) todo.push("BUILD did not finish (no build report): read logTail / build.log");
  const server = env.GITHUB_SERVER_URL ?? "https://github.com", repo = env.GITHUB_REPOSITORY;
  return {
    generatedAt: new Date().toISOString(),
    run: { ...(env.GITHUB_RUN_ID ? { id: env.GITHUB_RUN_ID } : {}), ...(env.GITHUB_RUN_ID && repo ? { url: `${server}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` } : {}), ...(env.GITHUB_SHA ? { sha: env.GITHUB_SHA } : {}), ...(env.GITHUB_REF_NAME ? { ref: env.GITHUB_REF_NAME } : {}) },
    buildFinished: !!report,
    ...(report?.build ? { build: report.build } : {}),
    ...(report?.stats ? { stats: report.stats } : {}),
    failedFeeds: report?.failedFeeds ?? [],
    expiredFeeds: report?.expiredFeeds ?? [],
    staleFeeds: report?.staleFeeds ?? [],
    generators,
    todo,
    ...(report ? {} : { logTail }),
  };
}

export function renderText(s: RunSummary): string {
  const l: string[] = [`Build run ${s.run.id ?? "(local)"} ${s.run.url ?? ""} commit ${s.run.sha?.slice(0, 8) ?? "-"} – ${s.buildFinished ? `finished, build ${s.build}` : "DID NOT FINISH"}`, ""];
  l.push(s.todo.length ? "TO DO:" : "Nothing to do.");
  for (const t of s.todo) l.push(`  - ${t}`);
  l.push("", "Generated feeds:");
  for (const g of s.generators) {
    l.push(`  ${g.id}: ${g.status}${g.trips !== undefined ? `, ${g.trips} trips` : ""}${g.error ? ` – ${g.error}` : ""}`);
    if (g.needsGeocoding) {
      for (const st of g.needsGeocoding.stops) l.push(`      needs geocoding: ${st.name}${st.unchecked ? " (looked up, not reviewed)" : ""} – ${st.context}`);
      for (const d of g.needsGeocoding.dropped) l.push(`      left out: ${d}`);
    }
    if (g.changedPages.length) l.push(`      timetable changed since last build: ${g.changedPages.join(", ")}`);
    if (g.newPages.length) l.push(`      new pages: ${g.newPages.join(", ")}`);
    if (g.removedPages.length) l.push(`      pages gone: ${g.removedPages.join(", ")}`);
  }
  if (s.logTail?.length) l.push("", "End of the log:", ...s.logTail.map((x) => `  ${x}`));
  return l.join("\n") + "\n";
}

async function main() {
  const a = process.argv.slice(2).filter((x) => x !== "--");
  const get = (n: string) => (a.indexOf(n) >= 0 ? a[a.indexOf(n) + 1] : undefined);
  const reportPath = resolve(get("--report") ?? "work/build-report.json"), logPath = resolve(get("--log") ?? "work/build.log"), out = resolve(get("--out") ?? "work/run-summary");
  const report = existsSync(reportPath) ? JSON.parse(await readFile(reportPath, "utf8")) : null;
  const tail = existsSync(logPath) ? (await readFile(logPath, "utf8")).split("\n").slice(-60) : [];
  const s = summarize(report, tail);
  await writeFile(out + ".json", JSON.stringify(s, null, 1) + "\n");
  await writeFile(out + ".txt", renderText(s));
  console.log(renderText(s));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
