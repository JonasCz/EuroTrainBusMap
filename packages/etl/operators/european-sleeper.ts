import { defineOperator } from "../src/operators/types.ts";

/**
 * European Sleeper night trains (Brussels / Amsterdam – Berlin – Prague): their own feed is the only source.
 *
 * Source: feed eu-european-sleeper = Transitous https://api.transitous.org/gtfs/eu_european-sleeper.gtfs.zip
 * (fallback MDB https://files.mobilitydatabase.org/mdb-3107/latest.zip).
 *
 * Shape (checked 2026-10-19): copies of the trains are in the German feeds – de-delfi agency.txt
 * "14302,European Sleeper,https://www.delfi.de,Europe/Berlin,," and de-gtfsde-rv
 * "97,European Sleeper,https://www.bahn.de,Europe/Berlin,de" – with German stops only and without the
 * boarding / alighting restrictions of the operator's feed.
 *
 * What it does: `exclusive` – routes of other feeds matching "european sleeper" are skipped while
 * eu-european-sleeper is in the build; their stop restrictions are kept as hints for the operator's trips.
 *
 * Known quirks: the national copies sometimes carry a different train number format ("ES 452" vs "452").
 * Fails on purpose: never at run time; the config check fails if eu-european-sleeper leaves feeds.json.
 * Re-check / update: grep the cached feeds' agency.txt for "sleeper"; if the operator renames itself, update the
 * pattern. A night train that disappears from the map while the operator still sells it means its own feed is stale.
 */
export default defineOperator({
  id: "european-sleeper",
  description: "European Sleeper night trains come from the European Sleeper feed only.",
  appliesTo: { feeds: ["eu-european-sleeper"] },
  exclusive: { pattern: "european sleeper", feeds: ["eu-european-sleeper"] },
});
