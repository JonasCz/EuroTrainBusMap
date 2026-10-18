import { defineOperator } from "../src/operators/types.ts";

/**
 * ZOU! Intermétropoles: the regional trains Marseille – Toulon – Nice have been run by Transdev (Transdev Rail Sud)
 * since 2025 and are not in the SNCF feed, which only has SNCF's own TER pieces (Marseille – Toulon, Toulon –
 * Les Arcs, Les Arcs – Nice, each its own train). Adds the operator's feed (right after fr-transilien, so the feed
 * order of the build stays as it was) and shows the trains as "TER" of "Transdev Rail Sud Intermétropole" (the feed's
 * agency_name is an internal code, "TransDev RAIL_5241").
 */
export default defineOperator({
  id: "zou",
  description: "Adds the Transdev ZOU! Intermétropoles feed (Marseille – Toulon – Nice regional trains) with a readable operator name.",
  appliesTo: { feeds: ["fr-paca-zou-intermetropole"] },
  extraFeeds: [
    {
      after: "fr-transilien",
      def: {
        id: "fr-paca-zou-intermetropole",
        country: "FR",
        name: "ZOU! Intermétropoles Marseille – Toulon – Nice (Transdev Rail Sud)",
        tier: "core",
        keep: ["rail"],
        sources: [{ transitous: "fr_zou.gtfs.zip" }, { url: "https://www.data.gouv.fr/api/1/datasets/r/764d6d5b-d04e-4aa7-94b7-f8b2274d2964" }],
        notes:
          "Regional trains Marseille - Toulon - Nice run by Transdev since 2025; not in the SNCF feed (which only has the SNCF TER pieces Marseille - Toulon, Toulon - Les Arcs, Les Arcs - Nice). route_type 100, route SUD_IV15, trip_short_name = train number. No shapes.",
        approxMB: 0.2,
        license: "etalab-2.0",
        licenseUrl: "https://transport.data.gouv.fr/datasets/zou",
        options: { railCat: "Regional", prefixNames: { "": "TER" }, agencyName: "Transdev Rail Sud Intermétropole" },
      },
    },
  ],
});
