import { defineOperator } from "../src/operators/types.ts";

/**
 * Eurostar (and the former Thalys): its own feed is the source of its trains. The copies in other feeds (NS in
 * nl-openov, SNCB, SNCF) are skipped; their boarding / alighting restrictions (no domestic travel Rotterdam –
 * Amsterdam) are kept as hints for the Eurostar feed's trips (gtfs/load.ts limit_hints). Its routes are named by
 * station codes ("FRPNO -> GBSPX"), so they are high-speed services by agency.
 */
export default defineOperator({
  id: "eurostar",
  description: "Eurostar / Thalys trains come from the Eurostar feed only; its routes are high-speed services.",
  appliesTo: { agencies: [/^eurostar\b/i] },
  exclusive: { pattern: "eurostar|thalys", feeds: ["eu-eurostar"] },
  route: () => ({ highSpeed: true }),
});
