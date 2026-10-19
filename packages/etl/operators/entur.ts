import { defineOperator } from "../src/operators/types.ts";

/**
 * Entur (Norway): rail-replacement buses hidden under train lines.
 *
 * Source: feed no-entur = Transitous https://api.transitous.org/gtfs/no_Entur.gtfs.zip (fallback MDB
 * https://files.mobilitydatabase.org/mdb-1078/latest.zip), the national aggregate.
 *
 * Shape (checked 2026-10-19): Entur runs its rail-replacement buses ("buss for tog") under the train's line
 * (route_type 100, e.g. F6 Trondheim – Oslo on a day of engineering works) with no replacement wording, but they call
 * only at bus stops. stops.txt has the extended column `vehicle_type` (the route type serving the stop):
 *   "stop_name,parent_station,stop_id,stop_desc,stop_lat,stop_lon,location_type,wheelchair_boarding,platform_code,vehicle_type"
 *   "2. Strøm terrasse 23,,NSR:StopPlace:17001,,59.73413,10.191253,1,2,,700"
 *
 * What it does: `onLoad` – rail trips whose every stop has a bus vehicle_type (3, 200–209, 700–716) are dropped,
 * like the replacement buses that say so in their headsign.
 *
 * Known quirks: a stop without vehicle_type counts as not-a-bus-stop (the trip is kept).
 * Fails on purpose: never; without the vehicle_type column the hook does nothing.
 * Re-check / update: `unzip -p work/cache/feeds/no-entur.zip stops.txt | head -2` must still show vehicle_type; the
 * build log line "operator entur: N trips dropped" (and `operators.entur` in the build report) shows it still acts.
 */
export default defineOperator({
  id: "entur",
  description: "Entur: rail trips calling only at bus stops (stops.txt vehicle_type) are rail-replacement buses and are dropped.",
  appliesTo: { feeds: ["no-entur"] },
  async onLoad(api) {
    if (!api.columns("stops.txt")?.has("vehicle_type")) return;
    await api.dropTrips(
      `SELECT st.trip_key FROM t_st st JOIN t_kt kt USING (trip_key) JOIN t_stops_all s USING (stop_id)
        WHERE kt.cls = 'rail' GROUP BY st.trip_key
        HAVING bool_and(coalesce(s.vehicle_type = 3 OR s.vehicle_type BETWEEN 200 AND 209 OR s.vehicle_type BETWEEN 700 AND 716, false))`,
      "rail trips calling only at bus stops: rail-replacement buses",
    );
  },
});
