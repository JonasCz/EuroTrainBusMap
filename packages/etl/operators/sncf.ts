import { Flag } from "@etbm/shared";
import { defineOperator } from "../src/operators/types.ts";

/**
 * SNCF national feed (TGV INOUI, OUIGO, Intercités, TER).
 *
 * Source: feed fr-sncf-national = MDB https://files.mobilitydatabase.org/tdg-83582/latest.zip (transport.data.gouv.fr
 * "horaires-sncf"; fallback Transitous fr_horaires-sncf.gtfs.zip).
 *
 * Shape (checked 2026-10-19):
 *   agency.txt  "1187,SNCF VOYAGEURS,http://www.sncf.com,Europe/Paris,fr"
 *   routes.txt  "FR:Line::fc526a2c-d3e0-4ae0-b8cd-782f83e16cdd:,1187,560A,Paris - Brive,,2,,,"
 *   trips.txt   category only in trip_id, train number in trip_headsign:
 *     "…,000041,OCESN12100F1187_F:OUI:FR:Line::4F3E7D7E-…::87212027:87113001:2:905:20270102,12100,1,115,"  (TGV INOUI 12100)
 *     "FR:Line::fc526a2c-…:,000207,OCESN60000R1187_R:CRE:FR:Line::fc526a2c-…::87594002:87547000:4:1800:20261018,60000,1,14515,"
 *       (a "car à réservation" coach 60000 on the rail route Paris – Brive)
 *     "FR:Line::02534A5F-…:,001027,OCESN30000R1187_R:CTE:FR:Line::02534A5F-…::87743716:87696013:4:740:20270226,30000,0,5504,"
 *       (a Car TER on the rail route P13 Ambérieu – Mâcon)
 *
 * What it does: feed options – category from trip_id (`_[A-Z]:([^:]+):`), number in the headsign, display names of the
 * categories; `classify.before` – CTE / CRE trips on rail routes are buses, CRE gets Flag.ReservationOnly (sold on
 * request, often missing from booking sites). CRE trips on bus routes (TGV station shuttles) are sold with the train:
 * no caveat.
 *
 * Known quirks: the headsign is a number; the loader derives the headsign from the last stop.
 * Fails on purpose: never; an unknown category is shown as its code (e.g. "NAV").
 * Re-check / update: `unzip -p work/cache/feeds/fr-sncf-national.zip trips.txt | cut -d, -f3 | grep -o "_[A-Z]:[^:]*:" | sort | uniq -c`
 * lists the categories in use – a new one may need a name in prefixNames.
 */
export default defineOperator({
  id: "sncf",
  description: "SNCF national feed: categories from trip_id, numbers in headsigns, Car TER / car à réservation trips on rail routes are buses.",
  appliesTo: { feeds: ["fr-sncf-national"] },
  feedOptions: {
    tripPrefixRegex: "_[A-Z]:([^:]+):",
    headsignIsNumber: true,
    prefixNames: {
      OUI: "TGV INOUI",
      OGO: "OUIGO",
      LYR: "TGV Lyria",
      IC: "Intercités",
      ICN: "Intercités de Nuit",
      TER: "TER",
      TT: "Tram-train",
      ICE: "ICE",
      TRN: "Train",
      CTE: "Car TER",
      CRE: "Car",
    },
  },
  classify: {
    before(r, mode) {
      if (mode !== "rail") return undefined;
      const p = r.tripPrefix.toLowerCase();
      if (p === "cte") return { mode: "bus" };
      if (p === "cre") return { mode: "bus", flags: Flag.ReservationOnly };
      return undefined;
    },
  },
});
