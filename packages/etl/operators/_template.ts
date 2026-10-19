// Template for a new operator adapter: copy to <id>.ts (the id below must equal the file name), keep only the parts
// you need and fill in every section of the doc comment (README of this directory, "The header comment"). Files
// starting with "_" are not loaded.
import { defineOperator } from "../src/operators/types.ts";

/**
 * <Operator> (<feed id>): what its data does differently, in one sentence.
 *
 * Source: feed <id> = <Transitous / Mobility Database / origin URL>.
 *
 * Shape (checked YYYY-MM-DD): rows copied from the live feed that show the quirk –
 *   agency.txt  "…"
 *   routes.txt  "…"
 *   trips.txt   "…"     (and copies in other feeds, if the adapter is about them)
 *
 * What it does: <part / hook> – its effect.
 *
 * Known quirks: other oddities of the data, handled or deliberately left alone.
 * Fails on purpose: what makes it fail (config check, conflict), or "never" and how a stale adapter shows up.
 * Re-check / update: the commands that show whether the quirk is still there (`unzip -p work/cache/feeds/<id>.zip …`),
 * what to change when the data changed, and when this adapter can be removed.
 */
export default defineOperator({
  id: "template",
  description: "One sentence for the build log and the README table.",
  // feeds and / or countries, optionally narrowed by agency names; at least one of the three
  appliesTo: { feeds: ["xx-feed"], agencies: [/^My Operator\b/i] },

  // Declarative parts (applied when feeds.json is loaded):
  // feedOptions: { railCatDefault: "Regional" },                    // needs appliesTo.feeds only
  // extraFeeds: [{ after: "xx-other-feed", def: { id: "xx-feed", country: "XX", name: "…", tier: "core", keep: ["rail"], sources: [{ url: "…" }] } }],
  // exclusive: { pattern: "my operator", feeds: ["xx-feed"] },     // the operator's own feed is its only source

  // Hooks (called only for rows in scope):
  // classify: {
  //   before: (r, mode) => (mode === "rail" && r.tripPrefix === "BUS" ? { mode: "bus" } : undefined),
  //   after: (r, cl) => (cl.cls === "bus" ? null : undefined),
  // },
  // async onLoad(api) {
  //   if (!api.columns("stops.txt")?.has("some_column")) return;
  //   await api.dropTrips(`SELECT trip_key FROM t_kt WHERE …`, "why these trips go");
  // },
  // route: (r) => (r.cat === Cat.LongDistance ? { brand: "My Brand" } : undefined),
});
