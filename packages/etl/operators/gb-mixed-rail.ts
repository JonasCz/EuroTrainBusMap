import { Cat } from "@etbm/shared";
import { defineOperator } from "../src/operators/types.ts";

/**
 * British train operators that run regional and long-distance trains under one name.
 *
 * Source: feed gb-great-britain = Transitous https://api.transitous.org/gtfs/gb_great-britain.gtfs.zip (from
 * aubin.app: Network Rail CIF + BODS; fallback https://beta.aubin.app/gtfs/great_britain_gtfs.zip).
 *
 * Shape (checked 2026-10-19): one route per operator, named by the operator –
 *   agency.txt "=GW" GWR, "=EM" EMR, "=SR" ScotRail, "=AW" Transport for Wales
 *   routes.txt "GW" short "GWR", long "Great Western Railway", route_type 2
 * so the route name cannot tell an InterCity Express (London – Penzance) from a branch-line stopper.
 *
 * What it does: `classify.after` – a rail route classified Regional only because of such an operator name gets
 * category null, so the per-trip distance / speed heuristic (build.ts) decides each trip.
 *
 * Known quirks: other GB operators are single-category and need nothing.
 * Fails on purpose: never.
 * Re-check / update: `unzip -p work/cache/feeds/gb-great-britain.zip agency.txt | grep -E "^=(GW|EM|SR|AW),"`; if
 * the feed starts naming routes per service group, this adapter may become unnecessary.
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
