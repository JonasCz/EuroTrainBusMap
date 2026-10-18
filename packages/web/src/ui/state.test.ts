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

  it("keeps a journey picked from the journeys list (trip=all)", () => {
    const legs = "legs=4.20261019.1.3,7.20261019.0.2";
    const t = parseHash(net, `#from=paris&to=lyon&${legs}&trip=all`);
    expect([t.schedule, t.journey]).toEqual([true, true]);
    expect(toHash(net, t)).toBe(`#from=paris&to=lyon&${legs}&trip=all`);
    expect(parseHash(net, `#from=paris&to=lyon&${legs}&trip=1`).journey).toBeUndefined();
  });
});

describe("journeys joined end to end in the URL", () => {
  const legs = "legs=4.20261019.1.3,7.20261019.0.2,9.20261019.0.5";
  it("keeps the continuation target and where the joined journeys end", () => {
    const t = parseHash(net, `#from=paris&to=lyon&${legs}&trip=all&parts=2&next=paris`);
    expect(t.extend).toBeUndefined(); // the origin is no continuation
    const u = parseHash(net, `#from=lyon&to=paris&${legs}&trip=all&parts=2&next=paris`);
    expect([u.parts, u.extend]).toEqual([[2], 0]);
    expect(toHash(net, u)).toBe(`#from=lyon&to=paris&${legs}&trip=all&parts=2&next=paris`);
  });
  it("drops invalid part boundaries and a continuation without legs", () => {
    expect(parseHash(net, `#from=paris&to=lyon&${legs}&parts=1,1`).parts).toEqual([1]);
    expect(parseHash(net, `#from=paris&to=lyon&${legs}&parts=3`).parts).toBeUndefined(); // not before the last leg
    expect(parseHash(net, `#from=paris&to=lyon&${legs}&parts=0,2`).parts).toBeUndefined();
    expect(parseHash(net, "#from=paris&to=lyon&next=lyon").extend).toBeUndefined();
  });
});

describe("connection settings in the URL", () => {
  it("keeps changes, minimum transfer and maximum wait only when they differ from the defaults", () => {
    expect(parseHash(net, "#from=paris").xfer).toEqual({ transfers: 0, minTransfer: 10, maxWait: null });
    const s = parseHash(net, "#from=paris&changes=1&mintransfer=15&wait=180");
    expect(s.xfer).toEqual({ transfers: 1, minTransfer: 15, maxWait: 180 });
    expect(toHash(net, s)).toBe("#from=paris&changes=1&mintransfer=15&wait=180");
    expect(toHash(net, parseHash(net, "#from=paris&changes=2&wait=day"))).toBe("#from=paris&changes=2");
    // out of range values are clamped
    expect(parseHash(net, "#from=paris&changes=9&mintransfer=999").xfer).toEqual({ transfers: 2, minTransfer: 120, maxWait: null });
    // settings without changes stay out of the URL
    expect(toHash(net, parseHash(net, "#from=paris&mintransfer=15"))).toBe("#from=paris");
  });
});
