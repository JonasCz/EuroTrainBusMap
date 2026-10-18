import { describe, expect, it } from "vitest";
import type { City, Station } from "@etbm/shared";
import { stationBySlug, stationSlug, type Net } from "../data/net.ts";
import { applyPatch, extendLegPatch, parseHash, removeLegPatch, toHash } from "./state.ts";
import { joinStay, tripIn } from "../logic/journey.ts";
import type { CityFile } from "@etbm/shared";

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

describe("the journey so far opened from the connections (trip=sofar)", () => {
  const legs = "legs=4.20261019.1.3,7.20261019.0.2";
  it("keeps it and the connections' scope in the URL", () => {
    const t = parseHash(net, `#from=paris&to=lyon&${legs}&trip=sofar&onward=city`);
    expect([t.schedule, t.review, t.journey, t.wholeCity]).toEqual([true, true, undefined, true]);
    expect(toHash(net, t)).toBe(`#from=paris&to=lyon&${legs}&trip=sofar&onward=city`);
    // a plain trip schedule has no onward scope
    expect(parseHash(net, `#from=paris&to=lyon&${legs}&trip=1&onward=city`).wholeCity).toBeUndefined();
  });
  it("opens from the connections and goes back to them with their scope; another step drops it", () => {
    const conns = parseHash(net, `#from=paris&to=lyon&${legs}&onward=city`);
    const so = applyPatch(conns, { schedule: true, review: true, wholeCity: conns.wholeCity });
    expect(toHash(net, so)).toBe(`#from=paris&to=lyon&${legs}&trip=sofar&onward=city`);
    expect(toHash(net, applyPatch(so, { schedule: undefined, wholeCity: so.wholeCity }))).toBe(`#from=paris&to=lyon&${legs}&onward=city`);
    // a stop chosen (another alighting point): the connections from there, no review left
    const stop = applyPatch(so, { legs: conns.legs.slice(0, 1), schedule: undefined });
    expect([stop.review, stop.wholeCity, stop.schedule]).toEqual([undefined, undefined, undefined]);
    // the plain schedule (back from the connections) keeps no review
    expect(applyPatch(conns, { schedule: true }).review).toBeUndefined();
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
    expect(parseHash(net, "#from=paris").xfer).toEqual({ transfers: 0, minTransfer: 10, maxWait: null, changeBy: "walk" });
    const s = parseHash(net, "#from=paris&changes=1&mintransfer=15&wait=180");
    expect(s.xfer).toEqual({ transfers: 1, minTransfer: 15, maxWait: 180, changeBy: "walk" });
    expect(toHash(net, s)).toBe("#from=paris&changes=1&mintransfer=15&wait=180");
    expect(toHash(net, parseHash(net, "#from=paris&changes=2&wait=day"))).toBe("#from=paris&changes=2");
    // out of range values are clamped
    expect(parseHash(net, "#from=paris&changes=9&mintransfer=999").xfer).toEqual({ transfers: 2, minTransfer: 120, maxWait: null, changeBy: "walk" });
    // settings without changes stay out of the URL
    expect(toHash(net, parseHash(net, "#from=paris&mintransfer=15"))).toBe("#from=paris");
  });
  it("keeps changes by bike (also without changes: onward connections from a whole city use them)", () => {
    const s = parseHash(net, "#from=paris&changes=1&xfer=bike");
    expect(s.xfer.changeBy).toBe("bike");
    expect(toHash(net, s)).toBe("#from=paris&changes=1&xfer=bike");
    expect(toHash(net, parseHash(net, "#from=paris&xfer=bike"))).toBe("#from=paris&xfer=bike");
    expect(parseHash(net, "#from=paris&xfer=car").xfer.changeBy).toBe("walk");
    const t = parseHash(net, "#from=paris&changes=1&xfer=transit");
    expect(t.xfer.changeBy).toBe("transit");
    expect(toHash(net, t)).toBe("#from=paris&changes=1&xfer=transit");
    expect(toHash(net, parseHash(net, "#from=paris&xfer=walk"))).toBe("#from=paris");
  });
});

describe("state changes", () => {
  const base = parseHash(net, "#from=paris&station=bercy");
  it("keeps the origin station when the destination or the date changes", () => {
    expect(base.station).toBe("bercy");
    const withDest = applyPatch(base, { dest: 1, legs: [] });
    expect(withDest.station).toBe("bercy");
    expect(applyPatch(withDest, { date: "2026-10-20" }).station).toBe("bercy");
    expect(applyPatch(withDest, { dest: undefined }).station).toBe("bercy");
  });
  it("drops the station with its city", () => {
    expect(applyPatch(base, { city: 1, dest: undefined, legs: [] }).station).toBeUndefined();
    expect(applyPatch(base, { city: undefined }).station).toBeUndefined();
    // the same city again, or a station named with it: kept / replaced
    expect(applyPatch(base, { city: 0, dest: undefined, legs: [] }).station).toBe("bercy");
    expect(applyPatch(base, { city: 1, station: "part-dieu" }).station).toBe("part-dieu");
  });
});

describe("removing the first or last leg of a journey", () => {
  // Sainte-Foy (0) → Bordeaux (1) → Marmande (2) → Agen (3)
  const four = ["sainte-foy", "bordeaux", "marmande", "agen"];
  const jnet = {
    cities: four.map((n, i) => city(i, n, [i])),
    slug: four,
    bySlug: new Map(four.map((n, i) => [n, i])),
    file: { stations: four.map((n, i) => st(i, i, n)), timezones: [] },
  } as unknown as Net;
  const legs = "legs=1.20261019.2.8,715.20261019.0.8,33.20261019.1.2";
  const ends = [1, 2, 3];
  const remove = (hash: string, end: "first" | "last", date?: string) => {
    const s = parseHash(jnet, hash);
    const p = removeLegPatch(s, end, ends.slice(0, s.legs.length), date);
    return p && applyPatch(s, p);
  };

  it("ends the journey where its last leg started", () => {
    const s = remove(`#from=sainte-foy&to=agen&date=2026-10-19&${legs}&trip=all`, "last")!;
    expect(toHash(jnet, s)).toBe("#from=sainte-foy&to=marmande&date=2026-10-19&legs=1.20261019.2.8,715.20261019.0.8&trip=all");
    // reload restores it
    expect(toHash(jnet, parseHash(jnet, toHash(jnet, s)))).toBe(toHash(jnet, s));
  });
  it("starts the journey where its second leg boards: the origin and its date follow", () => {
    const s = remove(`#from=sainte-foy&station=gare&to=agen&date=2026-10-19&${legs}&trip=all`, "first", "2026-10-20")!;
    expect(s.city).toBe(1);
    expect(s.station).toBeUndefined();
    expect(s.legs[0]!.from).toBe(1);
    expect(toHash(jnet, s)).toBe("#from=bordeaux&to=agen&date=2026-10-20&legs=715.20261019.0.8,33.20261019.1.2&trip=all");
    const r = parseHash(jnet, toHash(jnet, s));
    expect(r.legs.map((l) => l.trip)).toEqual([715, 33]);
    expect(r.legs[0]!.from).toBe(1);
  });
  it("leaves a single trip's schedule with one leg left", () => {
    const two = "legs=1.20261019.2.8,715.20261019.0.8";
    const a = remove(`#from=sainte-foy&to=marmande&${two}&trip=all`, "last")!;
    expect(toHash(jnet, a)).toBe("#from=sainte-foy&to=bordeaux&legs=1.20261019.2.8&trip=1");
    const b = remove(`#from=sainte-foy&to=marmande&${two}&trip=all`, "first")!;
    expect(toHash(jnet, b)).toBe("#from=bordeaux&to=marmande&legs=715.20261019.0.8&trip=1");
  });
  it("keeps the journey so far (back to the connections) and its onward scope when the end stays", () => {
    const h = `#from=sainte-foy&to=bordeaux&${legs}&trip=sofar&onward=city`;
    expect(toHash(jnet, remove(h, "first")!)).toBe("#from=bordeaux&to=agen&legs=715.20261019.0.8,33.20261019.1.2&trip=sofar&onward=city");
    expect(toHash(jnet, remove(h, "last")!)).toBe("#from=sainte-foy&to=marmande&legs=1.20261019.2.8,715.20261019.0.8&trip=sofar");
  });
  it("shifts or drops the joined parts and the continuation", () => {
    const h = `#from=sainte-foy&to=agen&${legs}&trip=all&parts=2`;
    expect(remove(h, "first")!.parts).toEqual([1]);
    expect(remove(h, "last")!.parts).toBeUndefined();
    expect(remove(`#from=sainte-foy&to=agen&${legs}&trip=all&parts=1`, "first")!.parts).toBeUndefined();
  });
  it("needs two legs and a schedule", () => {
    expect(remove("#from=sainte-foy&to=bordeaux&legs=1.20261019.2.8&trip=1", "last")).toBeNull();
    expect(remove(`#from=sainte-foy&to=agen&${legs}`, "last")).toBeNull(); // the connections view
  });
  it("never ends the journey where it starts", () => {
    // Bordeaux → Marmande → Bordeaux → Agen without its first leg would end... at Agen; without the last at Bordeaux = origin
    const s = parseHash(jnet, `#from=bordeaux&to=agen&legs=1.20261019.0.1,2.20261019.0.1,3.20261019.0.1&trip=all`);
    const p = removeLegPatch(s, "last", [2, 1, 3])!;
    expect(applyPatch(s, p).dest).toBe(2);
  });
});

describe("extending a journey on its own vehicles", () => {
  // Sainte-Foy (0) → Bordeaux (1) → Marmande (2) → Agen (3)
  const four = ["sainte-foy", "bordeaux", "marmande", "agen"];
  const jnet = {
    cities: four.map((n, i) => city(i, n, [i])),
    slug: four,
    bySlug: new Map(four.map((n, i) => [n, i])),
    file: { stations: four.map((n, i) => st(i, i, n)), timezones: [] },
  } as unknown as Net;
  const ext = (hash: string, end: "first" | "last", stop: number, c: number, date?: string) => {
    const s = parseHash(jnet, hash);
    const p = extendLegPatch(s, end, stop, c, date);
    return p && applyPatch(s, p);
  };

  it("rides the last leg on to a later stop: the destination follows, the view stays", () => {
    const s = ext("#from=bordeaux&to=marmande&legs=715.20261019.0.4&trip=1", "last", 8, 3)!;
    expect(toHash(jnet, s)).toBe("#from=bordeaux&to=agen&legs=715.20261019.0.8&trip=1");
    expect(toHash(jnet, parseHash(jnet, toHash(jnet, s)))).toBe(toHash(jnet, s));
    const j = ext("#from=sainte-foy&to=marmande&legs=1.20261019.2.8,715.20261019.0.4&trip=all&parts=1", "last", 8, 3)!;
    expect(toHash(jnet, j)).toBe("#from=sainte-foy&to=agen&legs=1.20261019.2.8,715.20261019.0.8&trip=all&parts=1");
    // the journey so far keeps returning to the connections, now from the new end (the onward scope was the old end's)
    expect(toHash(jnet, ext("#from=bordeaux&to=marmande&legs=715.20261019.0.4&trip=sofar&onward=city", "last", 8, 3)!)).toBe("#from=bordeaux&to=agen&legs=715.20261019.0.8&trip=sofar");
  });
  it("boards the first leg earlier: the origin and its date follow", () => {
    const s = ext("#from=bordeaux&station=st-jean&to=agen&legs=715.20261019.3.8&trip=1", "first", 1, 0, "2026-10-18")!;
    expect(s.legs[0]!.from).toBe(0);
    expect(toHash(jnet, s)).toBe("#from=sainte-foy&to=agen&date=2026-10-18&legs=715.20261019.1.8&trip=1");
  });
  it("only extends: not to an earlier stop, the origin, the destination or without a schedule", () => {
    expect(ext("#from=bordeaux&to=agen&legs=715.20261019.0.4&trip=1", "last", 3, 2)).toBeNull();
    expect(ext("#from=bordeaux&to=agen&legs=715.20261019.0.4&trip=1", "last", 6, 1)).toBeNull();
    expect(ext("#from=bordeaux&to=agen&legs=715.20261019.2.4&trip=1", "first", 1, 3)).toBeNull();
    expect(ext("#from=bordeaux&to=agen&legs=715.20261019.2.4&trip=1", "first", 3, 0)).toBeNull();
    expect(ext("#from=bordeaux&to=agen&legs=715.20261019.0.4", "last", 6, 3)).toBeNull();
  });
  it("finds the trip of a leg in the CityFile of an earlier stop (boarding there)", () => {
    const pat = (stations: number[], start = 0) => ({ route: 0, stations, arr: stations.map((_, i) => start + i * 10), dep: stations.map((_, i) => start + i * 10), corridors: [], headsign: "" });
    const file = (patterns: ReturnType<typeof pat>[], trips: [number, number, number][]) => ({ patterns, trips, routes: [{ name: "IC", agency: "", cat: 1, flags: 0 }] }) as unknown as CityFile;
    const src = file([pat([1, 2, 3])], [[0, 480, 0]]);
    const dst = file([pat([0, 1, 2]), pat([1, 2, 3])], [[0, 480, 0], [1, 420, 0], [1, 480, 1], [1, 480, 0]]);
    expect(tripIn(src, { from: 2, trip: 0, date: "2026-10-19", board: 1, alight: 2 }, dst)).toBe(3);
    expect(tripIn(src, { from: 2, trip: 0, date: "2026-10-19", board: 1, alight: 2 }, file([pat([0, 1, 2])], [[0, 480, 0]]))).toBe(-1);
  });
  it("joins a continuation that stays on board into the last leg", () => {
    const legs = [{ from: 0, trip: 1, date: "2026-10-19", board: 2, alight: 5 }, { from: 1, trip: 715, date: "2026-10-19", board: 0, alight: 4 }];
    // stays on board to stop 8, then changes to trip 33
    const route = [{ from: 2, trip: 90, date: "2026-10-19", board: 4, alight: 8 }, { from: 3, trip: 33, date: "2026-10-19", board: 0, alight: 2 }];
    expect(joinStay(legs, route)).toEqual([legs[0], { ...legs[1], alight: 8 }, route[1]]);
    expect(joinStay(legs, route.slice(0, 1))).toEqual([legs[0], { ...legs[1], alight: 8 }]);
  });
});
