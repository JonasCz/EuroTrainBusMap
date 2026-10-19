// Template for a new feed generator: copy to <id>.ts (the id below must equal the file name), add the feed to
// feeds.json with "sources": [{ "generated": "<id>" }] and describe the source in the doc comment. Files starting
// with "_" are not loaded. See the README of this directory.
import { defineGenerator, GeneratorError } from "../src/generators/types.ts";
import type { GtfsFeed } from "../src/generators/gtfs.ts";
import { serviceWindow } from "../src/generators/registry.ts";

const SOURCE_URL = "https://operator.example/timetable";

/**
 * <Operator> publishes no GTFS: what the page shows (with a real example row), how it becomes GTFS and when the
 * generator fails.
 */
export default defineGenerator({
  id: "template",
  description: "One sentence for the build log and the README table.",
  sourceUrl: SOURCE_URL,
  async generate(ctx) {
    const html = await ctx.fetchText(SOURCE_URL, { expect: /<\/html>/i });
    // 1. parse strictly: expected headers / columns, known categories and footnote texts, else
    if (!html.includes("<table")) throw new GeneratorError("no timetable table on the page");
    // 2. check the timetable is current; 3. compute service dates within the window (and the page's validity)
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
      info: { publisher: "EuroTrainBusMap (generated from the operator's timetable page)", publisherUrl: SOURCE_URL, lang: "en", version: ctx.startDate, sourceUrl: SOURCE_URL },
    };
    return feed;
  },
});
