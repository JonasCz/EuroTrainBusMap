import { describe, expect, it } from "vitest";
import { GridIndex } from "../src/util/geo.ts";
import { adoptStationNames, assignStations, chooseCityName, foldKey, matchVillage, placeCore, placeRadius, resolveSatellites, townFromStopName, type Place, type StationPoint } from "../src/core/cities.ts";

const P = (id: number, name: string, lat: number, lon: number, population: number, fcode = "PPL", admin: [string, string, string, string] = ["", "", "", String(id)], country = "DE"): Place => ({
  id, name, lat, lon, population, fcode, admin, country, tz: "Europe/Berlin",
});

// Real GeoNames coordinates
const places: Place[] = [
  P(1, "Berlin", 52.52437, 13.41053, 3426354, "PPLC", ["16", "00", "11000", "11000000"]),
  P(2, "Spandau", 52.5511, 13.19921, 39653, "PPLX", ["16", "00", "11000", "11000000"]),
  P(3, "Potsdam", 52.39886, 13.06566, 184754, "PPLA", ["11", "00", "12054", "12054000"]),
  P(4, "Falkensee", 52.56014, 13.0927, 37468, "PPL", ["11", "00", "12063", "12063080"]),
  P(5, "Frankfurt am Main", 50.11552, 8.68417, 650000, "PPLA2", ["05", "064", "06412", "06412000"]),
  P(6, "Offenbach", 50.10061, 8.76647, 119192, "PPLA3", ["05", "064", "06413", "06413000"]),
  P(7, "Nürnberg", 49.45421, 11.07752, 515543, "PPLA2", ["02", "095", "09564", "09564000"]),
  P(8, "Fürth", 49.47593, 10.98856, 128497, "PPLA2", ["02", "095", "09563", "09563000"]),
  P(9, "München", 48.13743, 11.57549, 1505005, "PPLA", ["02", "091", "09162", "09162000"]),
  P(10, "Kleinmachnow", 52.40786, 13.22514, 20000, "PPL", ["11", "00", "12069", "12069304"]),
];
resolveSatellites(places);
const city = (lon: number, lat: number, name = "", strict = false) => {
  const pt: StationPoint = { lon, lat, names: name ? [foldKey(name)] : [], strict };
  const i = assignStations(places, [pt])[0]!;
  return i >= 0 ? places[i]!.name : null;
};

describe("satellites", () => {
  it("an agglomeration known only by its region absorbs nothing (Marne-la-Vallée ≠ Champigny, Chelles)", () => {
    const idf: Place[] = [
      P(1, "Paris", 48.85341, 2.3488, 2138551, "PPLC", ["11", "75", "751", "75056"], "FR"),
      P(2, "Marne La Vallée", 48.83584, 2.64241, 318325, "PPL", ["11", "", "", ""], "FR"),
      P(3, "Champigny-sur-Marne", 48.81642, 2.49366, 76726, "PPL", ["11", "94", "942", "94017"], "FR"),
      P(4, "Chelles", 48.88109, 2.59295, 46947, "PPL", ["11", "77", "775", "77108"], "FR"),
      P(5, "Bondy", 48.9018, 2.48931, 48268, "PPL", ["11", "93", "931", "93010"], "FR"),
    ];
    idf.push(P(6, "Chessy", 48.88333, 2.76667, 2582, "PPL", ["11", "77", "775", "77111"], "FR"));
    resolveSatellites(idf);
    expect(idf.map((p) => p.parent)).toEqual([-1, -1, -1, -1, -1, -1]);
    const at = (lon: number, lat: number, name: string, strict = true) => {
      const i = assignStations(idf, [{ lon, lat, names: [foldKey(name)], strict }])[0]!;
      return i >= 0 ? idf[i]!.name : null;
    };
    expect(at(2.4993, 48.8099, "Champigny")).toBe("Champigny-sur-Marne"); // RER A / coach stop, 11 km from the agglomeration's point
    expect(at(2.5853, 48.8775, "Chelles - Gournay")).toBe("Chelles");
    // the TGV station at the far end of the new town, 10.8 km away, carries its name
    expect(at(2.7826, 48.8701, "Marne-la-Vallée Chessy")).toBe("Marne La Vallée");
    // … and so does the coach station 470 m away (alone it belongs to Chessy)
    expect(at(2.7832, 48.8659, "Chessy South Bus Station", false)).toBe("Chessy");
    const both = assignStations(idf, [
      { lon: 2.7826, lat: 48.8701, names: [foldKey("Marne-la-Vallée Chessy")], strict: true },
      { lon: 2.7832, lat: 48.8659, names: [foldKey("Chessy South Bus Station")], strict: true },
    ]);
    expect([...both].map((i) => idf[i]!.name)).toEqual(["Marne La Vallée", "Marne La Vallée"]);
    // a capital known only by its region still groups its unit (Prague: region 52 = the city)
    const cz: Place[] = [
      P(1, "Prague", 50.08804, 14.42076, 1165581, "PPLC", ["52", "", "", ""], "CZ"),
      P(2, "Černý Most", 50.1069, 14.5745, 22000, "PPLX", ["52", "", "", ""], "CZ"),
    ];
    resolveSatellites(cz);
    expect(cz[1]!.parent).toBe(0);
  });
});

describe("city assignment", () => {
  it("radius grows with population", () => {
    expect(placeRadius(1000)).toBe(1500);
    expect(placeRadius(100_000)).toBeCloseTo(6500);
    expect(placeRadius(1e9)).toBe(16_500);
    expect(placeRadius(1e12)).toBe(18_000);
  });
  it("captures Berlin's main stations incl. Spandau", () => {
    expect(city(13.3695, 52.5251)).toBe("Berlin"); // Hbf
    expect(city(13.4347, 52.5108)).toBe("Berlin"); // Ostbahnhof
    expect(city(13.3884, 52.5487)).toBe("Berlin"); // Gesundbrunnen
    expect(city(13.3655, 52.4757)).toBe("Berlin"); // Südkreuz
    expect(city(13.1977, 52.5344)).toBe("Berlin"); // Spandau
  });
  it("keeps neighbouring towns separate", () => {
    expect(city(13.0667, 52.3917)).toBe("Potsdam"); // Potsdam Hbf
    expect(city(8.7616, 50.0995)).toBe("Offenbach"); // Offenbach Hbf
    expect(city(8.6631, 50.1071)).toBe("Frankfurt am Main"); // Frankfurt Hbf
    expect(city(10.9896, 49.4697)).toBe("Fürth"); // Fürth Hbf
    expect(city(11.0826, 49.4459)).toBe("Nürnberg"); // Nürnberg Hbf
  });
  it("München Hbf and München Ost belong to München", () => {
    expect(city(11.5584, 48.1402)).toBe("München");
    expect(city(11.6047, 48.1272)).toBe("München");
  });
  it("leaves remote stops unassigned", () => {
    expect(city(20, 60)).toBeNull();
  });
});

describe("station membership (rail / coach stations)", () => {
  // Meuse valley: Revin (pop 8k) and the village of Anchamps, 4 km away, which GeoNames (cities1000) does not list
  const meuse: Place[] = [
    P(20, "Revin", 49.94039, 4.63503, 7960, "PPL", ["44", "08", "081", "08363"], "FR"),
    P(21, "Deville", 49.87893, 4.7061, 1171, "PPL", ["44", "08", "081", "08139"], "FR"),
    P(22, "Tipperary", 52.47333, -8.15583, 4979, "PPL", ["M", "26", "", ""], "IE"),
    P(23, "Limerick", 52.66472, -8.62306, 94192, "PPLA", ["M", "27", "", ""], "IE"),
  ];
  resolveSatellites(meuse);
  const at = (lon: number, lat: number, name: string, strict = true) => {
    const i = assignStations(meuse, [{ lon, lat, names: [foldKey(name)], strict }])[0]!;
    return i >= 0 ? meuse[i]!.name : null;
  };
  it("a station in the town centre belongs to the town", () => {
    expect(at(4.6395, 49.9282, "Revin")).toBe("Revin");
  });
  it("a village 4 km away keeps its own station (→ a town of its own), a bus stop there does not", () => {
    expect(at(4.62, 49.915, "Anchamps")).toBeNull();
    expect(at(4.62, 49.915, "Anchamps", false)).toBe("Revin"); // bus-only stops keep the plain catchment rule
  });
  it("a station beyond the core belongs to the town if it carries the town's name", () => {
    expect(at(4.62, 49.915, "Revin - La Gare")).toBe("Revin");
    expect(at(4.7061, 49.8789, "Deville")).toBe("Deville");
  });
  it("Limerick Junction is not Tipperary", () => {
    expect(at(-8.2078, 52.4977, "Limerick Junction")).toBeNull();
    expect(at(-8.1596, 52.4733, "Tipperary")).toBe("Tipperary");
  });
  it("bus stops named like a rail station nearby join its place, other bus stops do not", () => {
    const st = [
      { lon: -8.1972, lat: 52.5037, norm: "limerick junction", strict: true }, // the rail station (its own town: -1)
      { lon: -8.2062, lat: 52.4986, norm: "limerick junction", strict: false }, // 900 m away, was Tipperary's
      { lon: -8.2062, lat: 52.4986, norm: "post office", strict: false },
      { lon: -8.19, lat: 52.55, norm: "limerick junction", strict: false }, // 5 km away
    ];
    const placeOf = Int32Array.from([-1, 0, 0, 0]);
    expect(adoptStationNames(st, placeOf)).toBe(1);
    expect([...placeOf]).toEqual([-1, -1, 0, 0]);
  });
  it("core radius grows with the population up to the whole catchment", () => {
    expect(placeCore(1000)).toBeLessThan(0.5 * placeRadius(1000) + 1);
    expect(placeCore(5000)).toBeCloseTo(0.45 * placeRadius(5000), 0);
    expect(placeCore(200_000)).toBeCloseTo(placeRadius(200_000), 0);
    expect(placeCore(3e6)).toBe(placeRadius(3e6));
  });
  it("big cities group their outlying stations (Berlin-Spandau, Munich-Ost)", () => {
    expect(city(13.1977, 52.5344, "Berlin-Spandau", true)).toBe("Berlin");
    expect(city(11.6047, 48.1272, "München Ost", true)).toBe("München");
  });
});

describe("city names", () => {
  it("chooses the local name matching stop names", () => {
    expect(chooseCityName(["München", "Munich"], ["München Hbf", "München Ost"])).toBe("München");
    expect(chooseCityName(["Genf", "Genève", "Geneva"], ["Genève", "Genève-Eaux-Vives"])).toBe("Genève");
    expect(chooseCityName(["Praha", "Prague"], [])).toBe("Praha");
  });
  it("derives town names from stop names", () => {
    expect(townFromStopName("Kleindorf, Kirche")).toBe("Kleindorf");
    expect(townFromStopName("Oberau Bahnhof")).toBe("Oberau");
    expect(townFromStopName("Musterhausen (Kr. X)")).toBe("Musterhausen");
    expect(townFromStopName("Gare de Laifour")).toBe("Laifour");
    expect(townFromStopName("Deville")).toBe("Deville");
    expect(townFromStopName("[Enschede] Voorzijde station, Stationsplein")).toBe("Enschede");
    expect(townFromStopName("[cadavéu Cadavedo] Rotonda Cadavéu [CTA 16975]")).toBe("Cadavéu Cadavedo");
  });
});

import { parsePlaces, serializePlaces } from "../src/geonames.ts";
describe("places asset", () => {
  it("round-trips the compact places file", () => {
    const p = [{ ...places[0]!, parent: undefined, altNames: ["Berlin", "Berlín"] }, { ...places[2]!, parent: undefined }];
    const back = parsePlaces(serializePlaces(p));
    expect(back[0]).toEqual({ id: 1, name: "Berlin", lat: 52.52437, lon: 13.41053, population: 3426354, fcode: "PPLC", admin: ["16", "00", "11000", "11000000"], country: "DE", tz: "Europe/Berlin", altNames: ["Berlin", "Berlín"] });
    expect(back[1]!.altNames).toBeUndefined();
  });
});

describe("matchVillage", () => {
  // GeoNames: Scarriff (alternate name Scariff, 770), Tuamgraney (0), Tulla (661), Feakle (113)
  const villages: Place[] = [
    { ...P(2961574, "Scarriff", 52.90872, -8.53316, 770, "PPL", ["", "", "", ""], "IE"), altNames: ["An Scairbh", "Scariff"] },
    P(2961000, "Tuamgraney", 52.89722, -8.53861, 0, "PPL", ["", "", "", ""], "IE"),
    P(2961001, "Tulla", 52.86472, -8.76056, 661, "PPL", ["", "", "", ""], "IE"),
    P(2961002, "Feakle", 52.92637, -8.64772, 113, "PPL", ["", "", "", ""], "IE"),
    P(2961003, "Ae", 52.91, -8.531, 0, "PPL", ["", "", "", ""], "IE"),
  ];
  const idx = new GridIndex(villages.map((v) => v.lon), villages.map((v) => v.lat), 0.1);
  const m = (name: string, lon: number, lat: number) => {
    const r = matchVillage(name, lon, lat, villages, idx);
    return r ? `${villages[r.village]!.name}:${r.name}` : null;
  };
  it("matches a stop cluster to the village whose name it carries, in the operator's spelling", () => {
    expect(m("Scariff", -8.531182, 52.910934)).toBe("Scarriff:Scariff");
    expect(m("Tulla West", -8.772, 52.865)).toBe("Tulla:Tulla");
  });
  it("needs the name, not just the proximity, and a name of at least 3 letters", () => {
    expect(m("Drewsborough", -8.535, 52.905)).toBeNull(); // 600 m from Scarriff and Tuamgraney
    expect(m("Ae Road", -8.531, 52.91)).toBeNull();
  });
  it("stays within reach", () => {
    expect(m("Feakle", -8.53, 52.91)).toBeNull(); // 8 km away
  });
});
