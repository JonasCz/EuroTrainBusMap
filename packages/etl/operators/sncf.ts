import { Flag } from "@etbm/shared";
import { defineOperator } from "../src/operators/types.ts";

/**
 * SNCF national feed (TGV INOUI, OUIGO, Intercités, TER).
 *  - The train category is only in trip_id ("OCESN…F:OUI:…"), the train number in trip_headsign: feed options.
 *  - SNCF puts its TER coaches ("CTE", Car TER) and reservation coaches ("CRE", car à réservation, e.g. an
 *    Intercités line run by coach during engineering works) on the rail routes of the lines they serve: such trips
 *    are buses. A CRE coach is sold on request and often missing from the usual booking sites ("Car 60003"
 *    Paris – Cahors on a holiday weekend while the line's trains run as usual), so it gets the booking caveat
 *    Flag.ReservationOnly. CRE trips on bus routes (TGV station shuttles) are sold with the train: no caveat.
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
