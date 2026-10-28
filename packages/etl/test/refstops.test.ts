import { describe, expect, it } from "vitest";
import { pickRefStop, snapModeOf, type RefStop } from "../src/generators/refstops.ts";

const stop = (name: string, lat: number, lon: number, trips = 10, rail = false, feed = "es-regional-bus"): RefStop => ({ name, lat, lon, feed, trips, rail });

describe("pickRefStop: a generated stop goes on the existing stop of the same place", () => {
  // OSM town node of Mazarrón; the regional feed's stop "Mazarrón" lies ~1 km away
  const osm = [37.5996, -1.3146] as const;
  it("same name (accents and case ignored), within 3 km", () => {
    const s = pickRefStop("MAZARRON", ...osm, [stop("Mazarrón", 37.6062, -1.3215), stop("Calle Mayor", 37.5998, -1.3147, 50)]);
    expect(s?.ref.name).toBe("Mazarrón");
    expect(s?.why).toBe("same name");
  });
  it("bus stop before rail station of the same name, busiest first", () => {
    const s = pickRefStop("Lorca", 37.67, -1.70, [stop("Lorca", 37.671, -1.701, 100, true), stop("Lorca", 37.672, -1.699, 5), stop("Lorca", 37.673, -1.698, 20)]);
    expect(s?.ref).toMatchObject({ rail: false, trips: 20 });
  });
  it("the bus station of the place, else the busiest stop named after it", () => {
    expect(pickRefStop("Murcia", 37.99, -1.13, [stop("Murcia Plaza", 37.991, -1.131, 300), stop("Murcia Estación de Autobuses", 37.985, -1.14, 50)])?.ref.name).toBe("Murcia Estación de Autobuses");
    expect(pickRefStop("Murcia", 37.99, -1.13, [stop("Murcia Plaza", 37.991, -1.131, 300), stop("Murcia Ronda", 37.992, -1.131, 30)])?.ref.name).toBe("Murcia Plaza");
  });
  it("a bus station named without its town", () => {
    expect(pickRefStop("Águilas", 37.41, -1.58, [stop("Estación de Autobuses", 37.405, -1.578, 40), stop("Paseo", 37.41, -1.58, 2)])?.why).toBe("bus station");
    expect(pickRefStop("La Mata", 38.026, -0.654, [stop("Estacion de Autobuses (Torrevieja)", 38.0279, -0.6539)])).toBeNull();
  });
  it("only stops of the feed's mode", () => {
    const refs = [stop("Fiñana", 37.16, -2.83, 4, true), stop("Hadžići P", 43.823, 18.2, 40)];
    expect(pickRefStop("Fiñana", 37.17, -2.84, refs, "bus")).toBeNull(); // the railway station 1.5 km out of town
    expect(pickRefStop("Fiñana", 37.17, -2.84, refs, "rail")?.ref.rail).toBe(true);
    expect(pickRefStop("Hadžići", 43.82, 18.2, refs, "rail")).toBeNull();
    expect([snapModeOf(["rail"]), snapModeOf(["coach", "bus"]), snapModeOf(["rail", "bus"])]).toEqual(["rail", "bus", "any"]);
  });
  it("same name: station words and particles aside, nothing more", () => {
    expect(pickRefStop("MADRID Estación Autobuses SUR", 40.395, -3.678, [stop("Madrid-Estacion Sur", 40.3953, -3.6784)])?.why).toBe("same name");
    expect(pickRefStop("Bruck an der Mur", 47.41, 15.27, [stop("Bruck/Mur Bahnhof", 47.415, 15.275)])?.why).toBe("same name");
    expect(pickRefStop("E. Armuña", 37.1, -2.5, [stop("Armuña", 37.101, -2.5)])?.why).toBe("same name");
    expect(pickRefStop("Odense", 55.396, 10.388, [stop("Odense Zoo (Odense Kommune)", 55.38, 10.37)])).toBeNull(); // 2 km, another place in town
  });
  it("nothing for other names or too far away", () => {
    expect(pickRefStop("Puerto de Mazarrón", ...osm, [stop("Mazarrón", 37.6062, -1.3215)])).toBeNull();
    expect(pickRefStop("Mazarrón", ...osm, [stop("Mazarrón", 37.65, -1.3215)])).toBeNull();
    expect(pickRefStop("Mazarrón", ...osm, [stop("Mazarrón Avenida", 37.615, -1.3146)])).toBeNull(); // 1.7 km, only the town name
    expect(pickRefStop("Alcúdia", 39.84, 3.13, [stop("Port d'Alcúdia 1", 39.835, 3.135, 99)])).toBeNull();
  });
});
