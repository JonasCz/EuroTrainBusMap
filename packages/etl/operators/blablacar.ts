import { defineOperator } from "../src/operators/types.ts";

/**
 * BlaBlaCar Bus (formerly Ouibus): its own feed is the only source of its coaches.
 *
 * Source: feed eu-blablacar-bus = Transitous https://api.transitous.org/gtfs/eu_blablacar-bus.gtfs.zip (fallback MDB
 * https://files.mobilitydatabase.org/tdg-52605/latest.zip), the operator's own GTFS (route_type 3).
 *
 * Shape (checked 2026-10-19): agency.txt names the operator "BlaBlaCar Bus"; no other feed of the build carries a
 * copy today (agency.txt of every cached feed searched for "blablacar|ouibus"), but French regional aggregates have
 * listed Ouibus / BlaBlaCar lines in the past.
 *
 * What it does: `exclusive` – routes of any other feed whose agency, route short or long name matches
 * "blablacar|ouibus" are skipped while eu-blablacar-bus is in the build (their stop restrictions are kept as hints).
 *
 * Known quirks: none in the feed itself.
 * Fails on purpose: never at run time; the config check fails if eu-blablacar-bus disappears from feeds.json.
 * Re-check / update: `unzip -p work/cache/feeds/<feed>.zip agency.txt | grep -i -E "blablacar|ouibus"` over the
 * cached feeds shows where copies appear; the build report's `operators.blablacar` counts nothing for `exclusive`
 * (skips are logged per feed as "left to a dedicated operator's feed").
 */
export default defineOperator({
  id: "blablacar",
  description: "BlaBlaCar Bus services come from the BlaBlaCar feed only.",
  appliesTo: { feeds: ["eu-blablacar-bus"] },
  exclusive: { pattern: "blablacar|ouibus", feeds: ["eu-blablacar-bus"] },
});
