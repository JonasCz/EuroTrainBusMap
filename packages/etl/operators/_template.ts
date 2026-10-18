// Template for a new operator adapter: copy to <id>.ts (the id below must equal the file name), keep only the parts
// you need and describe the operator's quirk in the doc comment. Files starting with "_" are not loaded.
import { defineOperator } from "../src/operators/types.ts";

/**
 * <Operator> (<feed id>): what its data does differently (with a real example: route, trip, date) and what the
 * adapter does about it.
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
