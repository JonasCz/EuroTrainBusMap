import { defineOperator } from "../src/operators/types.ts";

/** European Sleeper night trains: their own feed is the source; copies in national feeds (NS, SNCB) are skipped. */
export default defineOperator({
  id: "european-sleeper",
  description: "European Sleeper night trains come from the European Sleeper feed only.",
  appliesTo: { feeds: ["eu-european-sleeper"] },
  exclusive: { pattern: "european sleeper", feeds: ["eu-european-sleeper"] },
});
