import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFeedsConfig } from "../feeds.ts";
import { readFile } from "node:fs/promises";
import { gatherFeeds } from "./feeds.ts";
import { todayIn } from "../core/time.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const work = resolve(process.argv[2] ?? join(here, "../../../../work"));
const cfg = await loadFeedsConfig(join(here, "../../feeds.json"));
const extra = JSON.parse(await readFile(join(here, "../../urban-feeds.json"), "utf8"));
const feeds = await gatherFeeds({
  cfg, urbanFeeds: extra.feeds, workDir: work, assetsDir: join(work, "assets"),
  startDate: todayIn("Europe/Berlin", new Date(Date.now() - 86_400_000)), download: true,
});
let lines = 0;
for (const f of feeds) lines += f.lines.length;
console.log("feeds", feeds.length, "lines", lines);
