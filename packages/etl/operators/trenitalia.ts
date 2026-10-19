import { Cat, endpointsName } from "@etbm/shared";
import { defineOperator } from "../src/operators/types.ts";

/**
 * Trenitalia (France, and its trains in the Austrian / German feeds): end-station-named Frecciarossa trains.
 *
 * Source: feed fr-trenitalia = MDB https://files.mobilitydatabase.org/tdg-81653/latest.zip (Trenitalia France);
 * the same agency name appears in at-rail and de-gtfsde-fv.
 *
 * Shape (checked 2026-10-19):
 *   agency.txt  "TI,Trenitalia,https://www.trenitalia.com/,UTC"
 *   routes.txt  "6147,TI,Paris-Gare-de-Lyon/Marseille-St-Charles,Paris-Gare-de-Lyon/Marseille-St-Charles,2"
 *               "6650,TI,Lyon-Perrache-Voyageurs/Paris-Gare-de-Lyon,Lyon-Perrache-Voyageurs/Paris-Gare-de-Lyon,2"
 * – no brand word in any name.
 *
 * What it does: `route` – such long-distance trains get the brand "Frecciarossa" (Route.brand, shown instead of the
 * end stations); routes of the agency "Trenitalia" are high-speed services (rail geometry keeps them on the LGV).
 *
 * Known quirks: agency_timezone is UTC (handled by the loader).
 * Fails on purpose: never.
 * Re-check / update: `unzip -p work/cache/feeds/fr-trenitalia.zip routes.txt | head`; if the names gain a brand
 * ("FR 9241"), the brand part can go.
 */
export default defineOperator({
  id: "trenitalia",
  description: "Trenitalia's end-station-named long-distance trains are Frecciarossa high-speed services.",
  appliesTo: { agencies: [/^trenitalia(\s+france)?$/i] },
  route(r) {
    const brand = r.cat === Cat.LongDistance && endpointsName(r.name) ? "Frecciarossa" : undefined;
    const highSpeed = r.agency === "Trenitalia" ? true : undefined;
    return brand || highSpeed ? { brand, highSpeed } : undefined;
  },
});
