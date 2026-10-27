// Template for a new feed generator: copy to <id>.ts (the id below must equal the file name), add the feed to
// feeds.json with "sources": [{ "generated": "<id>" }] and fill in every section of the doc comment (README of this
// directory, "The header comment"). Files starting with "_" are not loaded.
import { defineGenerator, GeneratorError } from "../src/generators/types.ts";
import type { GtfsFeed } from "../src/generators/gtfs.ts";
import { serviceWindow } from "../src/generators/registry.ts";
import { GeocodeStore } from "../src/generators/geocodes.ts";
import { mapLimit } from "../src/generators/pool.ts";

const SOURCE_URL = "https://operator.example/timetable";

/**
 * <Operator / area>: what the feed is, in one or two sentences (and why it is generated: no GTFS exists).
 *
 * SOURCE
 *   <URL(s)> – publisher, licence / terms, robots.txt if relevant.
 *
 * SHAPE OF THE SOURCE (live, checked YYYY-MM-DD)
 *   Copy real samples here: the table header and two or three rows, the exact footnote / legend texts, a JSON object
 *   with its field names, the form fields – whatever the parser relies on.
 *
 * WHAT THIS SCRIPT DOES
 *   1. … 2. … (requests and their number, filters, calendar rules, coordinates, the service window)
 *
 * KNOWN QUIRKS
 *   - Oddities of the source and how they are handled, with an example each.
 *
 * FAILS ON PURPOSE (the build skips the feed and keeps going) when
 *   - every condition that throws: changed header, unknown footnote text, a page that makes no sense, …
 *   - (not a failure) an outdated timetable / stale data that still parses: the feed is returned with `info.stale`
 *     (valid-until date and reason) and service on the weeks before that date; the build keeps it labelled
 *     "Timetables out of date" (see the README, "Out of date is not an error").
 *
 * HOW TO RE-CHECK / UPDATE
 *   - `pnpm --filter @etbm/etl run generate -- <id>` runs it against the live source;
 *   - how to look at the source by hand (curl …) and what to update when a check fails;
 *   - tests: test/generators.test.ts with fixtures in test/fixtures/<id>/.
 */
export default defineGenerator({
  id: "template",
  description: "One sentence for the build log and the README table.",
  sourceUrl: SOURCE_URL,
  async generate(ctx) {
    const geo = await GeocodeStore.load("template"); // data/geocodes/<id>.json; geo.resolve(name, where) per stop, geo.assertComplete() before returning
    // With an index page: fetch it, follow every linked line page (mapLimit(links, 2, …)), parse them all the same way and
    // hand each page's tables + notes to ctx.observe(key, content). New pages / timetables then need no code change.
    void mapLimit;
    const html = await ctx.fetchText(SOURCE_URL, { expect: /<\/html>/i });
    // 1. parse strictly: expected headers / columns, known categories and footnote texts, else
    if (!html.includes("<table")) throw new GeneratorError("no timetable table on the page");
    // 2. check the timetable is current (if not: info.stale + staleServiceWindow(until));
    // 3. compute service dates within the window (and the page's validity)
    const { from, to } = serviceWindow(ctx.startDate, ctx.days);
    ctx.log(`window ${from} … ${to}`);
    // 4. build the feed: stops with coordinates from a table in this file, one trip per train, explicit dates
    const feed: GtfsFeed = {
      agency: [{ agency_id: "op", agency_name: "Operator", agency_url: "https://operator.example/", agency_timezone: "Europe/Berlin" }],
      stops: [],
      routes: [],
      trips: [],
      stopTimes: [],
      services: new Map(),
      info: { publisher: "EuroTrainBusMap (generated from the operator's timetable page)", publisherUrl: SOURCE_URL, lang: "en", sourceUrl: SOURCE_URL },
    };
    return feed;
  },
});
