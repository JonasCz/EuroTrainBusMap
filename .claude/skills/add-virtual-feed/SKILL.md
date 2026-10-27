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
2. **Never guess a position.** Stops come from `data/geocodes/<id>.json`. A stop that is not there – or is there but
   `checked: null` – fails the source with `NeedsGeocodingError` listing ALL such stops of the run and the command to
   run. That failure is intended: a new stop needs an agent to geocode and check it. A stop that disappears from the
   timetable is not an error (its entry just stays unused).
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
  every stop (use a placeholder stop on a miss and keep going), then `geo.assertComplete()` before returning so all
  new stops are reported at once.
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

What `geocode` does: runs the generator, takes the missing stops, searches Nominatim (1 request / 2 s, restricted to
the file's `country` and to the box of the stops already known), prefers place nodes (town/village) over
municipality-boundary centroids, writes `checked: null, source "osm-auto"` entries with a note saying why it is
unsure, re-runs the generator with unchecked entries allowed, and re-searches a stop near its neighbours (±0.3°) when
its legs are implausible. Then it prints the legs that look wrong (> 90 or < 20 km/h, same place, flagged "too fast"),
`? name: note` lines for unsure picks, stops NOT FOUND, and entries the timetable no longer uses.

**You (the agent) must review before `--accept`**:
- every `? …` and every flagged leg: open the entry in `data/geocodes/<id>.json` and correct it (`source "manual"`);
  an obscure hamlet may need an estimate from the road order (`"approx": true, "source": "estimate"`, ±3 km) – OSM
  often returns a same-named place elsewhere (El Prado → Madrid, Alcudia → Valencia);
- prefer the bus station for cities; Nominatim gives centroids for municipalities (Baza, Guadix were 10–20 km off
  when picked from a boundary relation);
- a place with no certain position at all: `{ "skip": true, "lat": 0, "lon": 0, "source": "none", "note": why }`
  – the stop is left out of the trips (reviewed decision);
- rerun `geocode -- <id>` until nothing is flagged, then `--accept`, run the tests, commit the JSON.
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

## 8. When the weekly build reports a failure

`WARN generator <id> FAILED …` / GitHub error "Stops to geocode (<id>)": run `geocode -- <id>`, review, `--accept`,
commit. Other failures: rerun `generate -- <id>`, diff the page against the header's samples, update text, rule and
fixtures together. The previous data is not used while a generator fails, so fix promptly.
