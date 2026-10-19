import { defineOperator } from "../src/operators/types.ts";

/**
 * ZOU! Intermétropoles: Marseille – Toulon – Nice regional trains run by Transdev, missing from the SNCF feed.
 *
 * Source: feed fr-paca-zou-intermetropole (added by this adapter) = Transitous
 * https://api.transitous.org/gtfs/fr_zou.gtfs.zip, fallback transport.data.gouv.fr
 * https://www.data.gouv.fr/api/1/datasets/r/764d6d5b-d04e-4aa7-94b7-f8b2274d2964.
 *
 * Shape (checked 2026-10-19):
 *   agency.txt  "5241,TransDev RAIL_5241,https://www.transdev.com,Europe/Paris,fr"   (an internal code as the name)
 *   routes.txt  "Nice - Marseille,SUD_IV15,5241,100,SUD_IV15,999999,FFFFFF"
 *   trips.txt   "SUD_IV15,U_Q65we+xPScPISzh69Gy2REuqNHs=_Fri_2026-10-09,17467,0,17467@2026-10-09,1"
 * The trains have been run by Transdev (Transdev Rail Sud) since 2025; the SNCF feed only has SNCF's own TER pieces
 * (Marseille – Toulon, Toulon – Les Arcs, Les Arcs – Nice, each its own train).
 *
 * What it does: `extraFeeds` – adds the feed right after fr-transilien (so the feed order of the build stays as it
 * was) with railCat Regional, category name "TER" and the operator name "Transdev Rail Sud Intermétropole".
 *
 * Known quirks: no shapes; trip_short_name is the train number.
 * Fails on purpose: never; a download failure is a failed feed like any other.
 * Re-check / update: `unzip -p work/cache/feeds/fr-paca-zou-intermetropole.zip agency.txt routes.txt`; when the
 * agency_name becomes readable, drop agencyName.
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
