---
name: add-virtual-feed
description: Add or repair a "virtual" GTFS feed for an operator that publishes only a web timetable (HTML tables, a private JSON API), as a feed generator in packages/etl/generators that every weekly build runs. Covers checking that the routes are not already in our data, index-driven parsing that copes with new/changed/removed lines, the geocode store and geocode tool (new stops must be geocoded and reviewed by an agent), strict failure rules, stale data, content-hash state, tests and the feeds.json entry. Use when asked to "add the routes of <operator>", "parse the timetable at <URL>", when an operator has no GTFS in Transitous / Mobility Database, or when a generator fails with "stop(s) need geocoding".
---

# Virtual feeds: generators, geocode store, content state

Examples: `generators/es-busbam.ts` (index → many pages, 3 table layouts – the reference), `ba-zfbih.ts` (one page +
form), `ba-redvoznje.ts` (JSON API). Read `packages/etl/generators/README.md` (how generators run, the required
header comment, rules) and copy `generators/_template.ts`. All paths below are under `packages/etl/`.

The operator has no GTFS, so a script in the weekly build fetches its pages, parses them and returns a GTFS feed.
Nothing is committed from the build; what must survive between builds is (a) the reviewed coordinates, in git, and
(b) the content hashes of the timetable pages, in R2.

## The contract

1. **Fetch the index, follow every linked line page, parse all of them with the same code.** Added lines, removed
   lines and changed times then need no code change. Layout differences are explicit if/else variants; an unknown
   layout throws.
2. **Never guess a position, never fail the build for it.** Stops come from `data/geocodes/<id>.json`. A stop that is
   not there – or is there but `checked: null` – is collected (`geo.resolve`), the routes / trains / lines that call
   there are LEFT OUT (the smallest unit that would be wrong: a route = one direction of a table, a train, a line) and
   everything else is built. `geo.finish(ctx, droppedLabels, keptCount)` reports ALL missing stops and what was
   dropped (`ctx.needsGeocoding` → log WARN, `needsGeocoding` in `work/build-report.json`, run summary in R2); only if
   nothing is left does the generator throw `NeedsGeocodingError`. Either way the weekly build goes on (a failed
   generator only skips its own feed). A stop that disappears from the timetable is not an error (entry stays unused).
3. **Never be wrong quietly.** Unknown calendar label, unknown marker/footnote, unreadable cell, unknown layout →
   throw, naming table and cell. Old data is acceptable (the build skips a failed generator and the app shows no
   data of it; a stale-but-parsable timetable is kept and labelled), wrong data is not.
4. **Record what you read.** Hand each page's normalised timetable (tables + notes only) to `ctx.observe(key, content)`.

## 0. Branch, setup

Work where the user says (default: a feature branch, no PR unless asked). `pnpm install` once.

## 1. Are the routes already in our data?

Do this first. A duplicate feed wastes build time and shows lines twice.

1. `grep -in "<operator>\|<town>" packages/etl/feeds.json data/feeds.draft.json`; check the country's aggregate
   feeds (e.g. `es-regional-bus` is a Transitous regex, `es-alsa`) and `operators/`.
2. Transitous index `https://api.transitous.org/gtfs/` (`<cc>_<name>.gtfs.zip`, `license.json` lists operator names
   and source URLs), Mobility Database, national open-data portals; search the operator AND its line codes.
3. If a candidate exists, download it and look at `agency.txt`, `routes.txt`, `stops.txt` for the operator's stops
   and line codes: an aggregate feed with the agency but only some lines still leaves gaps (generate those, or all
   with a lower dedup `priority`). With a local build (`local-build-deploy` skill) query the loaded db.
4. Write the outcome (what was checked, date) into the header and `docs/data-sources.md`. If it is all covered, stop
   and tell the user.

## 1b. Before any code: is the source usable at all?

Region sweeps (2026-10) showed most "empty" areas were not missing a scraper but a line in `feeds.json`: Menorca, Ibiza,
Corsica, Aragón and La Mancha all had GTFS in Transitous that no regex matched. So per region: list the Transitous index
for the country prefix (`curl https://api.transitous.org/gtfs/ | grep -o 'es_[^"<]*gtfs.zip'`) and compare with the
`transitousMatch` regexes before looking for web timetables. Add GTFS first (several files of one country go into one
`transitousMatch` feed; a `url` source cannot be mixed into a feed that has `transitousMatch`, make it its own feed).

Only if no GTFS exists, check the site itself, and stop (documenting the outcome in `docs/data-sources.md`) if:

- **Terms forbid it.** Fetch `/terms`, `/robots.txt` (and the locale-prefixed one, `/el/robots.txt`; a redirect to a 404
  page means no rules), grep for copy / reproduce / scrape clauses in the local language. ktelherlas.gr (Crete) forbids
  any copying without written permission: not built.
- **The data is too thin.** A generator needs the times the source publishes at every stop (or arrival and a published
  duration). Origin-only departure lists need guessed arrivals: not buildable, `GtfsStopTime` has no estimate mode.
- **The host is unreachable from the sandbox.** A proxy 502 / connection reset is indistinguishable from the origin being
  down (ktelbus.com, e-ktel.com); say so in the report rather than assuming the site is gone.

Next.js sites: the data is often already in the first HTML response (or the `self.__next_f.push` payload); try plain `curl`
before a browser. Playwright from the scratchpad: `NODE_PATH=/opt/node-tools/node_modules node script.js`.

## 2. Read the source by hand

`curl -A "Mozilla/5.0" <url>`; save pages in a scratch dir; linearise the tables and read every one. Find the index
and its link pattern (follow ALL links, not just the example URL), every table layout, calendar labels, footnotes and
markers, validity dates, stops present in only some rows, times past midnight, typos. List what the pages do NOT say
(validity, what "laborables"/"festivos" mean) – each gap becomes a documented assumption (KNOWN QUIRKS), never a
silent guess.

## 3. Write the generator

- `generate(ctx)`: `const geo = await GeocodeStore.load(id)`; fetch the index; derive the page list from its links
  (fail if none); `mapLimit(pages, 2, …)` (polite, parallel); parse each; `ctx.observe(slug, contentOf(page))`;
  warn for pages `ctx.knownPages()` had that the index no longer links; build trips; `geo.resolve(name, where)` for
  every stop (use a placeholder stop on a miss and keep going), drop the routes that contain a placeholder, collect
  their labels, and call `geo.finish(ctx, dropped, feed.routes.length)` before returning so all new stops are
  reported at once.
- Parse strictly: expected header, cell counts, cell content (time or explicit "no stop" marker), calendar labels and
  footnotes matched exactly (normalised) against lists mapped to hard-coded rules. Dispatch on the detected layout.
- Times: a drop of ≥ 12 h is midnight (+24 h); a smaller backward step is a source typo → drop that trip with a
  `ctx.warn`; if more than ~10 % of trips are dropped, the layout was misread → throw.
- Service: explicit dates inside `serviceWindow(ctx.startDate, ctx.days)` and inside any validity dates the page
  gives. What the page cannot confirm (seasonal exceptions, regional holidays) is left out with a warning.
- Out of date but parsable (timetable year before the current one, validity in the past): do NOT throw – return the
  feed with `info.stale = { until, reason }` and service on `staleServiceWindow(until)`; the app labels it "Timetables
  out of date". No validity info on the page at all: say so in the header, don't invent a staleness rule.
- `route_type` 200 for long-distance coach lines, 3 for local/rural bus.
- Header comment (README "The header comment"): SOURCE, SHAPE (real samples + check date), WHAT IT DOES, KNOWN
  QUIRKS, FAILS ON PURPOSE, HOW TO RE-CHECK.
- Register: `feeds.json` feed with `"sources": [{ "generated": "<id>" }]` (every generator needs exactly one feed or
  the whole build refuses to start); `generators/README.md` row; `docs/data-sources.md` note.

## 4. Geocoding (the store and the tool)

First run of a new generator: the store file does not exist, every stop is "new", it fails listing them. Then:

```sh
cd packages/etl
pnpm run geocode -- <id>            # lookup + review output
pnpm run geocode -- <id> --accept   # after review: marks unchecked entries as checked (today)
```

(The weekly build does none of this itself: it leaves the routes out and tells you in the run summary, see "Run logs".)

What `geocode` does: runs the generator, takes the missing stops, searches Nominatim (1 request / 2 s, restricted to
the file's `country` and to the box of the stops already known), prefers place nodes (town/village) over
municipality-boundary centroids, writes `checked: null, source "osm-auto"` entries with a note saying why it is
unsure, re-runs the generator with unchecked entries allowed, and re-searches a stop near its neighbours (±0.3°) when
its legs are implausible. The output has two lists:

- **MUST FIX** – stops NOT FOUND on OSM, positions OUTSIDE the known area, "name differs", several similar hits,
  re-searched ones, and every stop on a leg that is too fast / too slow / "same place?". "Manual work" means exactly
  this: an agent has to look at each one (OSM link is printed; neighbours' positions, road order, other maps, the
  operator's own site) and write the correct position into `data/geocodes/<id>.json` (`"source": "manual"`). An
  obscure hamlet may only allow an estimate from the road order (`"approx": true, "source": "estimate"`, ±3 km).
  OSM often returns a same-named place elsewhere (El Prado → Madrid museum, Alcudia → Valencia). A place with no
  certain position at all: `{ "skip": true, "lat": 0, "lon": 0, "source": "none", "note": why }` (left out of the
  trips, a reviewed decision).
- **QUICK CHECK** – everything else. Less effort, but not none: glance at each (right place for the line? right
  province? bus station rather than the municipality centroid for a city – Baza and Guadix were 10–20 km off when
  taken from a boundary relation). Nominatim hits that look fine are usually fine; the leg speeds are the safety net.

Rerun `geocode -- <id>` until MUST FIX is empty, then `--accept`, run the tests, commit the JSON. Never `--accept`
with MUST FIX entries you did not resolve.
Other spellings of a stop in the source go in the entry's `aliases`. Sanity check yourself: speeds between
consecutive stops in `pnpm run generate -- <id>` output, and a look at the coordinates against the road order.

Store format and rules: `src/generators/geocodes.ts` (header). The store is in git, not R2: every position is a
reviewed fact that needs a diff. R2 is only for state that the build writes itself (below).

## 5. Content state (when did a timetable change?)

`ctx.observe(key, content)` hashes the normalised timetable of a page. The build keeps `work/generator-state.json`
(first seen / last changed / last seen per page); `build-deploy.yml` restores it from and saves it to the R2 object
`generator-state.json` around the build. It only informs (log line "timetable changed", `changed` / `removedPages` in
`work/build-report.json`, GitHub notices); it never decides whether the feed is built. Content = tables and notes
only, so ads, dates and menus on the page never count as changes. Locally the file is `work/generator-state.json`
(`generate --state <file>`).

## 6. Tests

`test/<id>.test.ts` + `test/fixtures/<id>/` (trimmed copies of the pages, the `<main>` part): parsing, happy path with
a fake `fetchText` (specific trips/dates, midnight rollover, qualifiers), one failing test per FAILS ON PURPOSE
condition (mutate the fixture HTML), a new stop → `NeedsGeocodingError` naming all new stops, unreviewed entry →
error, unused entry → fine, a new linked page parsed like the others, removed page → warning, changed content →
state reports it, misread layout threshold, registry loads the generator. See `test/busbam.test.ts`.

## 7. Verify

```sh
cd packages/etl
pnpm run generate -- <id> --start YYYY-MM-DD   # live, all generators in parallel when no id; one line per trip
pnpm exec vitest run && pnpm exec tsc --noEmit -p .
```
Compare 3–4 lines with the website (first/last stop, times, days). Commit.

## 8. Run logs: what did the last weekly build do?

The weekly workflow (`.github/workflows/build-deploy.yml`) never fails because of a generator: a failed generator
skips its own feed, missing stops drop single routes. After every build (also a crashed one) it uploads to R2 bucket
`eurotrainbusmap-assets`, prefix `logs/latest/`:

| object | content |
| --- | --- |
| `summary.txt` | start here: TO DO list (stops to geocode per generator with the dropped routes and the command, failed generators with their error, stale feeds), per-generator status, changed / new / removed timetable pages; the end of the log if the build crashed |
| `summary.json` | the same, structured (`todo`, `generators[].needsGeocoding`, `changedPages`, …) |
| `build-report.json` | the complete build report (`generated[]` per generator: warnings, counts, pages, needsGeocoding) |
| `build.log.gz` | the last ~8 MB of the build log, gzipped |

```sh
mkdir -p /tmp/runlog && cd /tmp/runlog
for f in summary.txt summary.json build-report.json build.log.gz; do
  npx -y wrangler@4 r2 object get "eurotrainbusmap-assets/logs/latest/$f" --remote --file "$f"
done   # needs CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID; cat summary.txt; zcat build.log.gz | grep -i "generator"
```
No Cloudflare access: the same warnings are GitHub annotations ("Stops to geocode (<id>)") and in the job log of the
run (GitHub MCP `actions_list` / `get_job_logs` on `build-deploy.yml`). Run `pnpm --filter @etbm/etl run run-summary`
locally on a `work/build-report.json` to produce the same files.

Then act on the TO DO lines: `GEOCODE <id>` → section 4; `FIX generator <id>` → rerun `generate -- <id>`, diff the page
against the header's samples, update text, rule and fixtures together (the feed stays missing from the site until
fixed); `STALE` → nothing to fix, the data is old.
