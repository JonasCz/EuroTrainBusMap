import { defineOperator } from "../src/operators/types.ts";

/**
 * Swedish train operators' rail-replacement buses in the Trafiklab feed.
 *
 * Source: feed se-trafiklab = Transitous https://api.transitous.org/gtfs/se_Trafiklab.gtfs.zip (origin needs a key;
 * fallback MDB https://files.mobilitydatabase.org/mdb-2939/latest.zip).
 *
 * Shape (checked 2026-10-19): train operators (SJ, Mälartåg, Tåg i Bergslagen, …) have bus routes named by the
 * train number they replace –
 *   agency.txt "313,Mälartåg,https://www.malardalstrafik.se/,Europe/Stockholm,sv"
 *   routes.txt "route_short_name 52111, agency 313, route_type 700, route_id 870000000000000006-52111" (no long name)
 * (earlier: "SJ 60629 Karlstad - Oslo", "Tåg i Bergslagen 68128 Borlänge - Mora" on one day).
 *
 * What it does: `classify.after` – every non-rail route of these agencies is dropped; their trains are kept.
 *
 * Known quirks: the agency list is by exact name; a new operator name is not covered.
 * Fails on purpose: never.
 * Re-check / update: list the agencies of rail routes in se-trafiklab (`agency.txt` + `routes.txt` route_type 1xx)
 * and compare with the regex below; `operators.se-train-operators` in the build report counts dropped routes.
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
