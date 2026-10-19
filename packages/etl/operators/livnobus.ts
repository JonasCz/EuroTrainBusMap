import { defineOperator } from "../src/operators/types.ts";

/**
 * Li-Bus Livno (Turistička agencija Li-Bus d.o.o.): its own GTFS is the only source of its coaches.
 *
 * Source: feed ba-livnobus = Transitous https://api.transitous.org/gtfs/ba_livnobus.gtfs.zip (the operator's
 * https://livnobus.com/gtfs/google-transit, also the fallback).
 *
 * Shape (checked 2026-10-19):
 *   agency.txt  "LivnoBus,Turistička agencija Li-Bus d.o.o.,https://livnobus.com/hr,Europe/Sarajevo,hr,+387 34 206 501,…"
 *   routes.txt  "Livno - Sarajevo - Livno,Livno-Bus,LivnoBus,3,rid-68-livno-sarajevo,FF9B08,F5F5F5,tdl-livnobus"
 *               (also Livno – Mostar, Mostar – Frankfurt am Main, Mostar – Zagreb, Sarajevo – Split)
 *   feed_info   "…,20261018,20261202,"LivnoBus 2026-10-18 - 2026-12-02, version 20261018",…" (a rolling six weeks)
 *   copies:     the redvoznje.ba boards (generated feed ba-redvoznje) list the same coaches as operator
 *               "Li Bus Livno" with fewer stops: Sarajevo 12:25 → Split 19:00, Sarajevo 17:15 → Livno 20:41.
 *
 * What it does: `exclusive` – routes of other feeds whose agency or route names match "Li Bus" / "Li-Bus" /
 * "Livno Bus" are skipped while ba-livnobus is in the build (the cross-feed dedup would catch most of them too, but
 * the operator name says it for sure).
 *
 * Known quirks: route_short_name is the brand "Livno-Bus" on every route.
 * Fails on purpose: never at run time; the config check fails if ba-livnobus leaves feeds.json.
 * Re-check / update: `unzip -p work/cache/feeds/ba-livnobus.zip agency.txt routes.txt feed_info.txt`; the operator
 * names of the generated redvoznje feed: `unzip -p work/cache/feeds/ba-redvoznje.zip agency.txt | grep -i livno`.
 */
export default defineOperator({
  id: "livnobus",
  description: "Li-Bus Livno coaches come from the operator's own feed (ba-livnobus) only.",
  appliesTo: { feeds: ["ba-livnobus"] },
  exclusive: { pattern: "\\bli[- ]?bus\\b|livno ?bus", feeds: ["ba-livnobus"] },
});
