import { describe, expect, it } from "vitest";
import type { City, Station } from "@etbm/shared";
import { stationBySlug, stationSlug, type Net } from "../data/net.ts";
import { parseHash, toHash } from "./state.ts";

const city = (id: number, name: string, stations: number[]): City => ({ id, name, country: "FR", lon: 0, lat: 0, population: 1, importance: 0.5, cats: 3, stations, tz: 0 });
const st = (id: number, c: number, name: string): Station => ({ id, city: c, name, lon: 0, lat: 0, cats: 3 });
const cities = [city(0, "Paris", [0, 1, 2]), city(1, "Lyon", [3])];
const stations = [st(0, 0, "Paris Gare du Nord"), st(1, 0, "Paris Gare de Lyon"), st(2, 0, "Paris Bercy"), st(3, 1, "Lyon Part-Dieu")];
const net = {
  cities,
  slug: ["paris", "lyon"],
  bySlug: new Map([["paris", 0], ["lyon", 1]]),
  file: { stations, timezones: [] },
} as unknown as Net;

describe("station selection in the URL", () => {
  it("names a station by the slug of its short name", () => {
    expect(stationSlug("Paris", "Paris Gare de Lyon")).toBe("gare-de-lyon");
    expect(stationSlug("Paris", "Paris Bercy")).toBe("bercy");
    expect(stationSlug("Lyon", "Lyon Part-Dieu")).toBe("part-dieu");
    // already short (map labels): the same slug
    expect(stationSlug("Paris", "Gare de Lyon")).toBe("gare-de-lyon");
  });
  it("finds the station of the city again", () => {
    expect(stationBySlug(net, 0, "gare-de-lyon")).toBe(1);
    expect(stationBySlug(net, 0, "part-dieu")).toBeUndefined(); // a station of another city
    expect(stationBySlug(net, 1, "part-dieu")).toBe(3);
    expect(stationBySlug(net, 0, undefined)).toBeUndefined();
  });
  it("round-trips through the hash and ignores a station without a city", () => {
    const s = parseHash(net, "#from=paris&station=gare-de-lyon&to=lyon");
    expect(s.city).toBe(0);
    expect(s.station).toBe("gare-de-lyon");
    expect(toHash(net, s)).toBe("#from=paris&station=gare-de-lyon&to=lyon");
    expect(parseHash(net, "#station=gare-de-lyon").station).toBeUndefined();
    expect(parseHash(net, "#from=paris&station=<script>").station).toBeUndefined();
    expect(toHash(net, parseHash(net, "#from=paris"))).toBe("#from=paris");
  });
});

describe("journey steps in the URL", () => {
  it("keeps the trip schedule step and the whole-city onward scope", () => {
    const legs = "legs=4.20261019.1.3";
    const t = parseHash(net, `#from=paris&to=lyon&${legs}&trip=1`);
    expect(t.schedule).toBe(true);
    expect(toHash(net, t)).toBe(`#from=paris&to=lyon&${legs}&trip=1`);
    const w = parseHash(net, `#from=paris&to=lyon&${legs}&onward=city`);
    expect(w.wholeCity).toBe(true);
    expect(w.schedule).toBeUndefined();
    expect(toHash(net, w)).toBe(`#from=paris&to=lyon&${legs}&onward=city`);
    expect(parseHash(net, "#from=paris&to=lyon&trip=1").schedule).toBeUndefined(); // no legs, no trip
  });
});
