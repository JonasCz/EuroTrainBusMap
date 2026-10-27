# Feed generators

Some operators publish no GTFS at all, only a timetable on their website. A **feed generator** is one script per
such source: on every data build it fetches the operator's page, parses it and returns a GTFS feed, which then goes
through the normal pipeline (load, stations, dedup, patterns, …) like a downloaded feed. Where the operators adapters
(`../operators/`) fix feeds that exist, generators make the ones that do not.

| file | feed | source | what it reads |
| --- | --- | --- | --- |
| `ba-zfbih.ts` | ba-zfbih | <https://www.zfbh.ba/en/time-table/> | ŽFBiH (Federation of Bosnia and Herzegovina) trains: the timetable table, its asterisk footnotes (exact texts mapped to hard-coded calendar rules) and the page's station form for the intermediate stops |
| `ba-redvoznje.ts` | ba-redvoznje | <https://redvoznje.ba/api/> | Intercity buses of Bosnia and Herzegovina (and the diaspora coaches leaving it): the JSON API's city-pair files (their `lines`: full runs with stops), deduplicated, coordinates from the API's stations or a table in the script; freshness from `health.json` |
| `es-busbam.ts` | es-busbam | <https://www.busbam.com/horarios/> | BusBam (Almería) coaches and buses: the index and its four line pages (Almería – Cartagena – Alicante, Almería – Madrid, Murcia – Torrevieja, Almería / Granada / Jaén / Baza area); three TablePress layouts (stops down, both directions side by side, one trip per row), calendar labels mapped to exact rules, stop coordinates from a table in the script |

## How it runs

- `feeds.json` lists the feed like any other, with one source `{ "generated": "<id>" }` (the generator's file name);
  tier, kept modes, options, licence and attribution are set there as usual. The config loader
  (`src/feeds.ts` → `src/generators/registry.ts`) checks that every `generated` source names a generator file and that
  every generator is used by exactly one feed, and sets the feed's `timetableUrl` to the generator's `sourceUrl`.
- `build-data` starts every generator right at the beginning of the download stage, in parallel with each other and
  beside the downloads (`pnpm run generate` without an id runs all of them at once as well; each generator limits its
  own requests to the site, 2 at a time)
  (`src/cli.ts`). The result is validated (`validateGtfs` in `src/generators/gtfs.ts`: ids and references, times never
  going backwards, coordinates, at least one trip in the build window) and written as a zip to
  `work/cache/feeds/<feed>.zip`, where the loader and the later stages (local transport, transit transfers) pick it up.
- **Out of date is not an error.** A source that still parses but whose timetable is old (ŽFBiH: the page still shows
  last year's timetable; redvoznje.ba: a line source not re-confirmed for 60 days) returns its feed flagged stale
  (`info.stale = { until, reason }`, service on the six weeks up to `until`: `staleServiceWindow` in the registry). The
  zip's `feed_info` end date is `until`, so the build treats it like any expired GTFS feed (`src/gtfs/validity.ts`):
  its last weekly pattern is repeated over the build window and the app shows "Timetables out of date — expired
  {until}" next to "Timetable: zfbh.ba · retrieved …". The build report's `generated` entry carries `stale`. A source
  stale for longer than feeds.json `staleMaxDays` (2 years) fails in the registry. Nothing is stored between builds:
  the generator reads the (old) page on every build, so a source that disappears or stops parsing drops out.
- **On error the source is skipped, the build goes on.** A generator throws (a `GeneratorError` with a message
  saying what changed, or any network error after the retries); the build logs
  `WARN generator <id> FAILED, feed <feed> skipped: <reason>`, deletes the zip of an earlier run (so no stage uses
  stale data) and lists the feed under `failedFeeds`; `work/build-report.json` has a `generated` entry per generator
  (ok, error, warnings, counts, seconds). Nothing of a failed source is published: fix the script and rebuild.
- The app shows where such data comes from and when it was read: the registry stamps the feed with the time the
  generator started (`feed_info.txt` `feed_version`, e.g. `2026-10-19T17:53:12Z`; `retrievedAt` in the build report);
  every route of the feed carries `Route.src` (the timetable page) and `Route.srcAt` (that time), shown as
  "Timetable: zfbh.ba · retrieved 19 Oct 2026" in the trip schedule and the journey legs, and the data sources dialog
  links the feed's name to the page with "· retrieved 19 Oct 2026" (`retrieved` in `attribution.json`). With
  `--reuse-db` the time is read back from the cached zip.
- The generators' source text and the geocode files are part of the `--reuse-db` key (`gens` in `work/db-state.json`); with `--reuse-db` the
  load stage, and so the generators, do not run at all.

## The header comment (required)

Every generator starts with a doc comment that lets another agent (or you, months later) re-run, check and repair it
without reverse-engineering the site. Sections, in this order:

1. **SOURCE** – the page / API and its URL(s), who publishes it, licence and robots rules if any.
2. **SHAPE OF THE SOURCE** – the structure the script relies on, with *concrete examples copied from the live source*
   and the date they were checked: table header and sample rows, the exact footnote texts, JSON field names with a real
   object, form fields. When the source changes, a diff against this section shows what moved.
3. **WHAT THIS SCRIPT DOES** – the steps from source to GTFS (requests, filters, calendar rules, coordinates).
4. **KNOWN QUIRKS** – oddities of the source and how they are handled (with examples: dates, train / line numbers).
5. **FAILS ON PURPOSE** – every condition that makes the generator throw (so the build skips the feed), and when
   it flags the feed stale instead (kept, labelled "out of date").
6. **HOW TO RE-CHECK / UPDATE** – the commands to run it live (`generate -- <id>`), to look at the source by hand, what
   to update when a check fails (texts, tables, thresholds) and where the tests and fixtures are.

Keep the examples current: when you update a rule, update the copied source text in the header in the same change.

## Writing one

Copy `_template.ts` to `<id>.ts` (lower case, digits, `-`; usually `<country>-<operator>`, the feed id) and add the
feed to `feeds.json` with `"sources": [{ "generated": "<id>" }]`.

```ts
export default defineGenerator({
  id: "xx-operator",
  description: "What the source is and how it becomes GTFS.",
  sourceUrl: "https://operator.example/timetable",   // linked from the app
  async generate(ctx) {
    const html = await ctx.fetchText(this.sourceUrl, { expect: /<\/html>/ }); // UA, timeout, retries; POST with { form }
    // parse, check, build a GtfsFeed (src/generators/gtfs.ts); throw new GeneratorError("…") on anything unexpected
    return feed;
  },
});
```

Rules that keep generated data honest:

- **Strict parsing.** Check the structure you rely on (table headers, column count, time formats, the known train
  types / categories) and throw on anything else. A page that changed must fail the source, not produce a plausible
  but wrong timetable. Fail before slow follow-up requests when the main page is already wrong.
- **Known texts only.** Free-text rules (footnotes such as "does not operate on weekends and public holidays") are
  matched *exactly* against a list in the script, each mapped to a hard-coded calendar rule; an unknown or changed
  text fails the source, and someone updates text and rule together.
- **Is the timetable current?** Check what the page says about its validity (ŽFBiH: the heading "Timetable for
  2025/2026" must be the current annual timetable, the footnotes' dates must not all lie before it) and generate
  service only within what the page covers (ŽFBiH: up to the December timetable change) and the build window
  (`ctx.startDate − 1` … `ctx.startDate + ctx.days`, `serviceWindow` in the registry). A source without its own validity
  dates needs a freshness rule (ba-redvoznje: `health.json`; a line source is valid for 60 days after it was last
  re-confirmed, service is generated up to `last_confirmed + 60 days`). When the page is out of date, do not throw:
  flag the feed stale (`info.stale`, see "How it runs") with the last day its timetable is valid for, and generate the
  weeks before that day (`staleServiceWindow(until)`); the build repeats and labels them. Throw only when the page no
  longer parses or makes no sense (a later timetable year than the build's, unknown footnotes).
- **Coordinates** come from the reviewed geocode file `data/geocodes/<id>.json` (`src/generators/geocodes.ts`), never
  from a table in the script and never guessed. A stop that is not in the file fails the source with a
  `NeedsGeocodingError` that lists *all* new stops of the run at once; `pnpm --filter @etbm/etl run geocode -- <id>`
  looks them up on OSM (restricted to the country and to the area of the stops already known, re-searched near the
  neighbouring stops when the leg speeds are implausible), writes them as unchecked entries (`checked: null`; the
  build refuses these as well) and prints the legs that look wrong; an agent corrects entries by hand, reruns, and
  `geocode -- <id> --accept` marks them reviewed; commit the file. Stops that disappear from the timetable need nothing
  (their entries stay unused). A place that can never be located gets `"skip": true` (left out, reviewed).
- **Follow the index.** When the operator has an index page linking the individual line pages, read the index and
  parse every linked page with the same code (variants as explicit if / else on the layout; an unknown layout fails),
  so that new lines and new timetables need no change in the script. A page that disappears is just gone.
- **Know when a timetable changed.** Pass the normalised content of each timetable page (tables and notes, nothing
  else of the page) to `ctx.observe(key, content)`: the build keeps the hashes between runs in
  `work/generator-state.json` (R2 object `generator-state.json`, build-deploy.yml) and reports
  `changed` / `removedPages` in the build report.
- **Prefer accuracy.** Use only stops and times the source publishes. Where a detail (intermediate stops) comes from a
  second, less certain part of the source, check it against the main table and fall back to what is certain (ŽFBiH:
  a train whose stops disagree keeps only its end stations, with a warning).
- **Be polite.** `ctx.fetchText` sends the build's User-Agent, has a timeout and retries with backoff; keep parallel
  requests to one or two.

Test it with a fixture copy of the page (`test/fixtures/<id>/`, see `test/generators.test.ts`): the happy path and
each failure (changed text, new footnote, changed header, unreadable row). Run it against the live site with

```sh
pnpm --filter @etbm/etl run generate -- <id> [--out /tmp/<id>.zip] [--start YYYY-MM-DD] [--days 60]
```

which prints the report and one line per trip (end stations, stops, service days) and writes the zip (default
`work/generated/<id>.zip`, never the build's feed cache). Load it in a small build to see it on the map:
`pnpm --filter @etbm/etl run build-data -- --out <dir> --work <scratch dir> --feeds <id>,<neighbour feeds> --no-urban --no-transit`.
