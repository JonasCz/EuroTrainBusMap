import { Cat, endpointsName } from "@etbm/shared";
import { defineOperator } from "../src/operators/types.ts";

/**
 * Trenitalia (France, and its trains in the Austrian / German feeds): the Paris – Lyon – Milano trains are named only
 * after their end stations ("Paris-Gare-de-Lyon/Marseille-St-Charles"), with no brand in any name.
 *  - brand: such long-distance trains are "Frecciarossa" (Route.brand, shown instead of the end stations).
 *  - high speed: routes of the agency "Trenitalia" are high-speed services (rail geometry keeps them on the LGV).
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
