---
name: add-virtual-feed
description: Add a "virtual" GTFS feed for an operator that publishes only a web timetable (HTML tables, PDF-derived pages, a private JSON API), as a feed generator script in packages/etl/generators that the weekly build runs. Covers checking that the operator's routes are not already in our data, geocoding stops, strict parsing that fails instead of producing wrong data, stale-data handling, fixtures, tests and the feeds.json entry. Use when asked to "add the routes of <operator>", "parse the timetable at <URL>", or when an operator has no GTFS in Transitous / Mobility Database.
---

# Add a virtual feed (feed generator) for an operator without GTFS

Worked examples: `packages/etl/generators/ba-zfbih.ts` (HTML table + form), `ba-redvoznje.ts` (JSON API),
`es-busbam.ts` (several HTML pages, three table layouts). Read `packages/etl/generators/README.md` first (how
generators run, the required header comment, rules) and copy `generators/_template.ts`.

The idea: the script runs in every weekly data build, fetches the operator's pages, and returns a GTFS feed that
goes through the normal pipeline. It is never "fetch once and commit the output". Nothing is stored between builds.

## 0. Work on a branch, build only

New branch (e.g. `add-routes-<country>`), no PR or merge unless asked. Run `pnpm install` once.

## 1. Confirm the routes are not already in our data

Do this before writing anything; a duplicate feed wastes build time and shows lines twice.

1. **Our config**: `grep -in "<operator>\|<town A>\|<town B>" packages/etl/feeds.json data/feeds.draft.json`. Check
   the country's aggregate feeds (`es-regional-bus` matches Transitous files by regex, `es-alsa`, rail feeds…) and
   the operator adapters (`packages/etl/operators/`).
2. **Transitous / Mobility Database**: the Transitous index `https://api.transitous.org/gtfs/` (files
   `<cc>_<name>.gtfs.zip`) and `license.json` (operator names, source URLs). Search the operator and the line
   codes. Mobility Database: `https://files.mobilitydatabase.org/` catalogue by country/operator name. A national
   or regional open-data portal (e.g. Spain NAP, Andalucía consortium) may hold the concession; search
   "<operator> GTFS" and the line code (BusBam: `VAC-216`, `VJA-158`).
3. **Real data check, not only names**: if a candidate feed exists, download it (or `unzip -p … routes.txt stops.txt`
   via remote-zip reads, see `docs/data-sources.md`) and look for the operator's agency name and for the
   stops/terminals of its lines. A feed that has the agency but only some lines still leaves gaps: list which lines
   are missing and generate those only, or all of them with a lower dedup `priority`.
4. With a local build (`local-build-deploy` skill) you can query the loaded db for the stop names.
5. Write the outcome into the generator header and `docs/data-sources.md` (what was checked, date). If the routes
   are already covered, stop and tell the user instead of adding a feed.

## 2. Read the source by hand, completely

`curl -A "Mozilla/5.0" <url>` (the build's UA is set by `ctx.fetchText`). Save the pages to a scratch dir. Linearise
the tables to text and read every table. Find: the index of all lines (a "see /horarios/" page: follow its links, do
not trust the one example URL), every table layout, calendar labels, footnotes and markers, validity dates, stops that
appear in only some rows, times past midnight, typos. Note the page's `article:modified_time` / `Last-Modified`.
List what the page does NOT say (validity, meaning of "laborables"/"festivos"); each such gap becomes a documented
assumption in the header (KNOWN QUIRKS), never a silent guess.

## 3. Geocoding the stops

Coordinates live in a table in the script (a stop missing from it fails the source).

- Nominatim: `https://nominatim.openstreetmap.org/search?q=<name>, <province>&format=json&limit=3&countrycodes=<cc>`
  with a descriptive User-Agent, **max 1 request per 2 s** (it answers 429 otherwise; retry after a pause). Open-Meteo
  geocoding (`geocoding-api.open-meteo.com/v1/search`) is a fine second opinion. Run it from a scratch script, not
  from the generator.
- Prefer the **bus station** (`q=Estación de autobuses <city>`) over the municipality centroid for cities. Nominatim
  returns municipality centroids for towns (Baza, Guadix, Orihuela were 10–20 km off) and can pick a same-named place
  in another province (Murcia → Jumilla, Jaén → Úbeda): always add the province/region and sanity-check.
- **Verify with the timetable**: dump consecutive stops of every trip and compute km / minutes. Anything above
  ~110 km/h or a zigzag against the road order is a wrong coordinate (or a typo in the source). Fix coordinates; if
  the source times are the problem, handle it in parsing (below).
- Hamlets that cannot be found: estimate from the road order and neighbouring stops, mark them `~` in the table, log
  them on every run, and list them in the header. Never leave a guess unmarked.
- Normalise stop keys (no accents, case, punctuation) and list aliases for spelling variants within the source.

## 4. Parsing: fail rather than be wrong

The rule: **a page that changed must fail the source, not produce a plausible but wrong timetable.** A failed
generator is skipped by the build (`WARN generator <id> FAILED …`, feed dropped, listed under `failedFeeds`); old
data is acceptable, wrong data is not.

- Parse structure strictly: expected header cells, column counts per row, cell contents (a time or an explicit "no
  stop" marker, anything else throws), known stop names, known calendar labels. Dispatch on the layout detected from
  the header; an unknown layout throws.
- **Known texts only**: calendar labels and footnotes are matched against exact lists (normalised) and mapped to
  hard-coded rules. Unknown label, unknown marker (`*`), a marker without its known note, a "validity" column without
  its validity note → throw naming the table and cell. Someone then updates text and rule together.
- Minimum structure checks per page (at least N tables, a line code present) and index checks (every expected page
  still linked: missing → fail; a new unknown page → warn and skip).
- Times: monotonic within a trip; a big drop (≥ 12 h) is midnight (+24 h), a small backward step is a source typo.
  Drop only that trip with a warning; if more than ~10 % of trips are dropped, the layout was misread → fail.
- Check against `validateGtfs` (the registry does): ids, stops, times, at least one trip in the build window.
- Generate explicit service dates inside `serviceWindow(ctx.startDate, ctx.days)` only, and inside any validity dates
  the page gives. Data the page cannot confirm (summer-season exceptions, regional holidays) is left out with a
  warning, not guessed.
- Keep every judgement visible: `ctx.warn(...)` per left-out call/trip (they reach `work/build-report.json`).
- Be polite: few requests, sequential, via `ctx.fetchText` (UA, timeout, retries).

## 5. Old data: stale, not failed

If the page still parses but its timetable is out of date (a timetable year before the current one, validity dates in
the past, a source not re-confirmed for N days), **do not throw**: return the feed with `info.stale = { until, reason }`
and service on the weeks before `until` (`staleServiceWindow(until)`). The build repeats that pattern and the app
shows "Timetables out of date — expired {until}"; a source stale for more than `staleMaxDays` (2 years) fails. If the
page has no validity information at all (BusBam), say so in the header and log the page's modified date; do not
invent a staleness rule that would flag stable rural timetables. Throw only when the page no longer parses or makes
no sense (e.g. a later timetable year than the build's).

## 6. Files to create / change

1. `packages/etl/generators/<cc>-<operator>.ts` – default export `defineGenerator({ id, description, sourceUrl,
   generate })`, with the full header comment: SOURCE, SHAPE OF THE SOURCE (real samples + check date), WHAT THIS
   SCRIPT DOES, KNOWN QUIRKS, FAILS ON PURPOSE, HOW TO RE-CHECK / UPDATE. `id` = file name. Export the pure parsing
   functions for tests.
2. `packages/etl/feeds.json` – feed with `"sources": [{ "generated": "<id>" }]`, tier, `keep`, licence text,
   `attribution`, notes. Every generator must be used by exactly one feed or the whole build refuses to start.
   Route types: 200 for long-distance coach lines, 3 for local/rural bus; `options.allCoach` / `priority` only if
   dedup against another feed matters.
3. `packages/etl/test/<id>.test.ts` + `packages/etl/test/fixtures/<id>/` – trimmed copies of the pages (the `<main>`
   part). Tests: parsing, happy path with a fake `fetchText` (specific trips, dates, midnight rollover, qualifiers),
   one failing test per FAILS-ON-PURPOSE condition (mutate the fixture HTML), misread-layout threshold, registry
   loads the generator and feeds.json uses it.
4. `packages/etl/generators/README.md` table row; `docs/data-sources.md` note (what, checked date, assumptions).

## 7. Verify

```sh
cd packages/etl
pnpm run generate -- <id> --start YYYY-MM-DD       # live; prints warnings and one line per trip
pnpm exec vitest run && pnpm exec tsc --noEmit -p .
```

Read the printed trips against the website for 3–4 lines (first/last stop, times, days). Run the speed check from
section 3 on the output zip. Optionally load it in a small build (README of the generators, last paragraph). Commit
on the feature branch; push; open a PR only if asked.

## 8. Maintenance expectations

The weekly build is the monitor: a failed generator shows up as a WARN and in `failedFeeds`. When it fails, re-run
`generate`, diff the page against the header's samples, and update text, tables and rule together (and the fixtures).
