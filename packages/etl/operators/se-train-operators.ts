import { defineOperator } from "../src/operators/types.ts";

/**
 * Swedish train operators in the Trafiklab feed (SJ, Mälartåg, Tåg i Bergslagen, …): their bus routes, named by train
 * number ("SJ 60629 Karlstad - Oslo", "Tåg i Bergslagen 68128 Borlänge - Mora" on one day), are their rail-replacement
 * buses (ersättningsbussar) and are dropped; their trains are kept.
 */
export default defineOperator({
  id: "se-train-operators",
  description: "Trafiklab: the bus routes of Swedish train operators are rail-replacement buses and are dropped.",
  appliesTo: {
    feeds: ["se-trafiklab"],
    agencies: [/^(SJ|VR Snabbtåg|Öresundståg|Mälartåg|Vy Tåg|Tåg i Bergslagen|Tågåkeriet i Bergslagen|Snälltåget|Norrtåg|Krösatåg|Krösatågen Öst)$/i],
  },
  classify: {
    after: (_r, cl) => (cl.cls !== "rail" ? null : undefined),
  },
});
