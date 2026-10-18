import { defineOperator } from "../src/operators/types.ts";

/** BlaBlaCar Bus (formerly Ouibus): its own feed is the source; copies in other feeds are skipped. */
export default defineOperator({
  id: "blablacar",
  description: "BlaBlaCar Bus services come from the BlaBlaCar feed only.",
  appliesTo: { feeds: ["eu-blablacar-bus"] },
  exclusive: { pattern: "blablacar|ouibus", feeds: ["eu-blablacar-bus"] },
});
