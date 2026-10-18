import { Cat } from "@etbm/shared";
import { defineOperator } from "../src/operators/types.ts";

/**
 * British train operators that run both regional and long-distance trains under one name (GWR, EMR, ScotRail,
 * Transport for Wales): a route matched as regional only by such an operator name is left to the per-trip distance
 * heuristic (category null) instead.
 */
const MIXED = /\b(gwr|emr|scotrail|transport for wales|tfw)\b/i;

export default defineOperator({
  id: "gb-mixed-rail",
  description: "GB: routes of mixed regional / long-distance operators (GWR, EMR, ScotRail, TfW) are classified per trip.",
  appliesTo: { countries: ["GB"] },
  classify: {
    after(r, cl) {
      if (cl.cls !== "rail" || cl.cat !== Cat.Regional) return undefined;
      return MIXED.test(`${r.agency} ${r.shortName} ${r.longName} ${r.desc}`) ? { ...cl, cat: null } : undefined;
    },
  },
});
