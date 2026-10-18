import { defineOperator } from "../src/operators/types.ts";

/** FlixBus / FlixTrain: their own feeds are the source; copies in regional and national feeds are skipped. */
export default defineOperator({
  id: "flixbus",
  description: "FlixBus and FlixTrain services come from the FlixBus feeds only.",
  appliesTo: { feeds: ["eu-flixbus", "gb-flixbus", "tr-flixbus"] },
  exclusive: { pattern: "flix", feeds: ["eu-flixbus", "gb-flixbus", "tr-flixbus"] },
});
