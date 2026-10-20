/** Fill the per-feed extraction cache of the local-transport layer: node --import tsx src/urban/cli-extract.ts [work] [start YYYY-MM-DD] */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFeedsConfig } from "../feeds.ts";
import { gatherFeeds } from "./feeds.ts";
import { loadUrbanFeedDefs } from "./index.ts";
import { todayIn } from "../core/time.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const work = resolve(process.argv[2] ?? join(here, "../../../../work"));
const cfg = await loadFeedsConfig(join(here, "../../feeds.json"));
const extra = { feeds: await loadUrbanFeedDefs() };
let lines = 0;
const { feeds } = await gatherFeeds(
  { cfg, urbanFeeds: extra.feeds, workDir: work, assetsDir: join(work, "assets"), startDate: process.argv[3] ?? todayIn("Europe/Berlin", new Date(Date.now() - 86_400_000)), download: true },
  (f) => void (lines += f.lines.length),
);
console.log("feeds", feeds.length, "lines", lines);
