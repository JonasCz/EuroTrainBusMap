import { defineOperator } from "../src/operators/types.ts";

/**
 * Entur (Norway) runs its rail-replacement buses ("buss for tog") under the train's line (route_type 100, e.g. F6
 * Trondheim – Oslo on a day of engineering works) with no replacement wording, but they call only at bus stops:
 * stops.txt `vehicle_type` (the extended route type of the stop) is a bus type at every stop of the trip. Such rail
 * trips are dropped like the named replacement buses.
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
