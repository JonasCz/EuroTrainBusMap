import { defineOperator } from "../src/operators/types.ts";

/**
 * Eurostar (and the former Thalys): its own feed is the only source of its trains, which are high speed.
 *
 * Source: feed eu-eurostar = MDB https://files.mobilitydatabase.org/tdg-82199/latest.zip (fallback Transitous
 * eu_eurostar.gtfs.zip).
 *
 * Shape (checked 2026-10-19):
 *   agency.txt  "THALYS,Eurostar,https://www.eurostar.com,Europe/Brussels,en,…" (also EUROSTAR_CHANNEL,
 *               EUROSTAR_CONTINENTAL – all named "Eurostar")
 *   routes.txt  "BEBMI-FRPNO,EUROSTAR_CONTINENTAL,BEBMI -> FRPNO,Bruxelles-Midi -> Paris-Nord,2,B5273D,FFFFFF,0"
 *   copies:     de-gtfsde-rv agency "85,EUROSTAR,https://www.bahn.de,…", NS trains in nl-openov, SNCB, SNCF.
 * The copies carry the no-domestic-travel restrictions (Rotterdam – Amsterdam) that the operator feed lacks.
 *
 * What it does: `exclusive` "eurostar|thalys" on eu-eurostar (copies skipped, their restrictions kept as hints,
 * gtfs/load.ts limit_hints); `route` – every route of agency Eurostar is a high-speed service (its names are station
 * codes with no brand word, so the generic high-speed rule cannot see it).
 *
 * Known quirks: route names are UIC-style station codes ("FRPNO -> GBSPX").
 * Fails on purpose: never at run time.
 * Re-check / update: `unzip -p work/cache/feeds/eu-eurostar.zip agency.txt routes.txt | head`; the build report's
 * `operators.eurostar` must count `route.highSpeed`.
 */
export default defineOperator({
  id: "eurostar",
  description: "Eurostar / Thalys trains come from the Eurostar feed only; its routes are high-speed services.",
  appliesTo: { agencies: [/^eurostar\b/i] },
  exclusive: { pattern: "eurostar|thalys", feeds: ["eu-eurostar"] },
  route: () => ({ highSpeed: true }),
});
