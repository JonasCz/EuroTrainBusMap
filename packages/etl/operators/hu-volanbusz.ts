import { defineOperator } from "../src/operators/types.ts";

/**
 * Hungarian state buses (MÁV-Volánbusz, now MÁV Személyszállítási Zrt.): every line is a "coach".
 *
 * Source: feed hu-volanbusz = Transitous https://api.transitous.org/gtfs/hu_volanbusz.gtfs.zip (fallback MDB
 * https://files.mobilitydatabase.org/tld-5862/latest.zip).
 *
 * Shape (checked 2026-10-19): routes.txt uses route_type 200 (coach) for 2,797 of 3,485 routes – regional and even
 * local lines – and 3 for the rest:
 *   agency.txt  "hkir_V,MÁV Személyszállítási Zrt. - Helyközi busz,https://www.mavcsoport.hu/,Europe/Budapest,hu,…"
 *   routes.txt  "(Mobilis -) Egyetem - Városrét - Belváros - Kollégium - Adyváros - Iparkamara,9,hkir_V-25584,3,…,local"
 * Treated as coaches they would skip the short-bus filter and draw every village line as an intercity coach.
 *
 * What it does: feed option `coachTypesAsBus` – route_type 200–209 count as ordinary buses (the short-bus filter
 * and the bus category apply); real long-distance coaches of other operators are unaffected.
 *
 * Known quirks: the feed's `route_network` column ("local", …) is not used.
 * Fails on purpose: never.
 * Re-check / update: `unzip -p work/cache/feeds/hu-volanbusz.zip routes.txt | cut -d, -f4 | sort | uniq -c` (the
 * route_type column may move: check the header). If the feed starts using 3 / 700 for local lines and 200 only for
 * real coaches, remove this adapter.
 */
export default defineOperator({
  id: "hu-volanbusz",
  description: "Volánbusz (Hungary) marks nearly every line route_type 200: its coach types count as ordinary buses.",
  appliesTo: { feeds: ["hu-volanbusz"] },
  feedOptions: { coachTypesAsBus: true },
});
