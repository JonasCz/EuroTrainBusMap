import { defineOperator } from "../src/operators/types.ts";

/**
 * Supratours (ONCF's coach arm, Morocco): "(suprat.)" in trip headsigns.
 *
 * Source: feed ma-oncf = Transitous https://api.transitous.org/gtfs/ma_oncf.gtfs.zip (unofficial, scraped from
 * oncf-voyages.ma by https://github.com/orhazal/oncf-gtfs-unofficial, ODbL; feed_info 2026-08-18 – 2028-08-18).
 *
 * Shape (checked 2026-10-19): the Supratours coach stops are named after the town with a marker, and the headsigns
 * copy the stop name –
 *   agency.txt  "SUPRATOURS,Supratours,https://www.supratours.ma/,Africa/Casablanca,fr"
 *   stops.txt   "Agadir (suprat.),,9300745,745,30.416502,-9.565763,,"
 *   trips.txt   "1000_110_745,S0224,Agadir (suprat.),N1070S2,0,,N1070S2_S0224,,1"
 *               "1000_110_744,S0225,Agadir Tassila (suprat.),N1074,0,,N1074_S0225,,1"
 *   variants in the headsigns today: "(suprat.)", "(suprat)" (Inezgane), "(supra.)" (Fnideq).
 * The stop names are renamed in data/stop-names.json ("Agadir (suprat.)" → "Agadir Supratours"); headsigns are not
 * stop names and kept the marker ("to Agadir (suprat.)").
 *
 * What it does: `onLoad` – removes the trailing marker from the headsigns of Supratours trips ("Agadir (suprat.)" →
 * "Agadir"), via LoadApi.setHeadsigns.
 *
 * Known quirks: Supratours trip_short_name is a code ("N1074", "N1070S2"), not a public line number.
 * Fails on purpose: never; a new marker spelling simply stays in the headsign.
 * Re-check / update: `unzip -p work/cache/feeds/ma-oncf.zip trips.txt | cut -d, -f3 | grep "(" | sort -u` lists the
 * headsigns with a bracket; extend MARKER when a new spelling shows up. `operators.ma-oncf` in the build report
 * counts the changed headsigns (about all Supratours trips).
 */
/** "(suprat.)", "(suprat)", "(supra.)" at the end of a headsign (SQL regex). */
export const MARKER = "\\s*\\((suprat|supra)\\.?\\)\\s*$";

export default defineOperator({
  id: "ma-oncf",
  description: "ONCF / Supratours (Morocco): the \"(suprat.)\" marker of the coach stops is removed from trip headsigns.",
  appliesTo: { feeds: ["ma-oncf"], agencies: [/^supratours$/i] },
  async onLoad(api) {
    await api.setHeadsigns(
      `SELECT trip_key, regexp_replace(headsign, '${MARKER}', '', 'i') AS headsign FROM t_kt WHERE regexp_matches(headsign, '${MARKER}', 'i')`,
      'Supratours "(suprat.)" marker in headsigns',
    );
  },
});
