import { WALK_MAX_M, WALK_MAX_MIN, distanceM } from "@etbm/shared";
import { describe, expect, it } from "vitest";
import { isTerminalName, nameSimilarity, normalizeStopName, prettifyName, sanitizeName, stripPlatform } from "../src/core/names.ts";
import { classifyPair, cleanStationName, describeStation, mergeStations, walkMinutes, type PairInfo, type StopIn } from "../src/core/stations.ts";

describe("name normalization", () => {
  it("removes generic words, platforms and diacritics", () => {
    expect(normalizeStopName("Berlin Hbf (Washingtonplatz)")).toBe("berlin");
    expect(normalizeStopName("Berlin Hauptbahnhof")).toBe("berlin");
    expect(normalizeStopName("München Hbf Gleis 27")).toBe("munchen");
    expect(normalizeStopName("Kraków Główny")).toBe("krakow");
    expect(normalizeStopName("Gare de Lyon")).toBe("de lyon");
  });
  it("similarity", () => {
    expect(nameSimilarity("Berlin Hbf (Washingtonplatz)", "Berlin Hbf")).toBe(1);
    expect(nameSimilarity("Praha hl.n.", "Praha hlavní nádraží")).toBeGreaterThanOrEqual(0.9);
    expect(nameSimilarity("Frankfurt(Main)Hbf", "Frankfurt (Main) Hbf")).toBe(1);
    expect(nameSimilarity("Hauptstraße", "Kirche")).toBe(0);
  });
  it("prettifies names", () => {
    expect(prettifyName("LONDON KINGS CROSS")).toBe("London Kings Cross");
    expect(cleanStationName("S+U Gesundbrunnen Bhf", "Berlin", true)).toBe("Berlin Gesundbrunnen");
    expect(cleanStationName("Wien Hbf", "Wien", true)).toBe("Wien Hbf");
  });
});

describe("platform qualifiers", () => {
  it("strips them in several languages", () => {
    const cases: [string, string][] = [
      ["Paddington (Platform 6)", "Paddington"],
      ["London Euston (Platform 9)", "London Euston"],
      ["Farringdon (Platform A)", "Farringdon"],
      ["London Bridge Platform 4", "London Bridge"],
      ["Wien Hbf Bahnsteig 3-4", "Wien Hbf"],
      ["München Hbf Gleis 27", "München Hbf"],
      ["Köln Hbf, Gleis 5", "Köln Hbf"],
      ["Gleis 5, Köln Hbf", "Köln Hbf"],
      ["Paris Gare de Lyon - Voie 2", "Paris Gare de Lyon"],
      ["Lyon Part-Dieu (Quai A)", "Lyon Part-Dieu"],
      ["Milano Centrale Binario 12", "Milano Centrale"],
      ["Praha hl.n. (nástupiště 3)", "Praha hl.n."],
      ["Warszawa Centralna (Peron 2)", "Warszawa Centralna"],
      ["Utrecht Centraal (Spoor 5)", "Utrecht Centraal"],
      ["Victoria Coach Station (Bay 12)", "Victoria Coach Station"],
      ["Zürich HB (Stand B)", "Zürich HB"],
      ["Bern Bahnhof Stop A", "Bern Bahnhof"],
      ["Golders Green Station (Stop GE)", "Golders Green Station"],
      ["Winson Green Metro (Platform WD)", "Winson Green Metro"],
      ["Dale House (Stop MS22)", "Dale House"],
      ["Harewood Arms (Platform 45014866)", "Harewood Arms"],
      ["Papendrecht, Busstation (Perron D)", "Papendrecht, Busstation"],
    ];
    for (const [a, b] of cases) expect(stripPlatform(a)).toBe(b);
  });
  it("leaves real names alone", () => {
    for (const n of ["Costa Baya", "Berliner Tor", "Platform 1", "Gleis 1", "Bayern", "Stand", "Quai d'Orsay", "Brandenburger Tor", "Finchley Road (NW11)", "Bus Stop Road"]) expect(stripPlatform(n)).toBe(n);
  });
  it("picks the common platform-free name for a station", () => {
    const d = describeStation(
      [1, 2, 3, 4].map((i) => stop(`London Bridge (Platform ${i})`, -0.086, 51.505, { rail: true, weight: 10 })).concat([stop("London Bridge", -0.0861, 51.5051, { rail: true, weight: 1 })]),
      "London",
    );
    expect(d.name).toBe("London Bridge");
    expect(describeStation([stop("Paddington (Platform 6)", -0.176, 51.516, { rail: true })], "London").name).toBe("Paddington");
  });
});

const stop = (name: string, lon: number, lat: number, o: Partial<StopIn> = {}): StopIn => ({
  name, lon, lat, rail: false, parent: null, feed: 0, weight: 1, ...o,
});

describe("station merging", () => {
  it("merges a bus stop into the nearby rail station with a similar name", () => {
    const stops = [
      stop("Berlin Hbf", 13.3695, 52.5251, { rail: true, weight: 100 }),
      stop("Berlin Hbf (Washingtonplatz)", 13.3699, 52.5243),
      stop("Berlin Hauptbahnhof", 13.3690, 52.5250, { rail: true, feed: 1 }),
      stop("Berlin Ostbahnhof", 13.4347, 52.5108, { rail: true }),
    ];
    const { stationOf, count } = mergeStations(stops);
    expect(count).toBe(2);
    expect(stationOf[0]).toBe(stationOf[1]);
    expect(stationOf[0]).toBe(stationOf[2]);
    expect(stationOf[3]).not.toBe(stationOf[0]);
  });
  it("keeps differently named bus stops apart; merges by parent", () => {
    const stops = [
      stop("Hauptstraße", 10, 50),
      stop("Kirche", 10.001, 50), // 71 m: another stop on the street
      stop("Rathaus", 10.0, 50.0022), // and a third one: not an isolated pair
      stop("Gleis 1", 11, 51, { parent: "7", rail: true }),
      stop("Gleis 2", 11.002, 51, { parent: "7", rail: true }),
    ];
    const { stationOf, bySignal } = mergeStations(stops);
    expect(stationOf[0]).not.toBe(stationOf[1]);
    expect(stationOf[0]).not.toBe(stationOf[2]);
    expect(stationOf[3]).toBe(stationOf[4]);
    expect(bySignal.parent).toBe(1);
  });
  it("prefers the rail name for the station", () => {
    const d = describeStation([stop("Berlin Hbf (Washingtonplatz)", 13.37, 52.52, { weight: 1000 }), stop("Berlin Hbf", 13.37, 52.525, { rail: true })], "Berlin");
    expect(d.name).toBe("Berlin Hbf");
  });
  it("walking time", () => {
    expect(walkMinutes(0)).toBe(3);
    expect(walkMinutes(750)).toBe(16);
    // Paris Montparnasse → Gare de Lyon, 4.1 km straight: 5.4 km on foot
    expect(walkMinutes(distanceM(2.31901, 48.84017, 2.37497, 48.84388))).toBe(75);
    // the longest walk offered (farther pairs have no transfer)
    expect(walkMinutes(WALK_MAX_M)).toBe(WALK_MAX_MIN);
    expect(WALK_MAX_M).toBe(6750);
  });
});

/** a pair in a busy place (other differently named stops around) unless stated otherwise */
const pair = (o: Partial<PairInfo>): PairInfo => ({ d: 100, sim: 0, railA: false, railB: false, termA: false, termB: false, crowdA: 1, crowdB: 1, isolated: false, ...o });

describe("merge signals", () => {
  it("merges whatever the names say only when it is the same spot, or a rail stop is involved", () => {
    expect(classifyPair(pair({ d: 40 }))).toBe("near");
    expect(classifyPair(pair({ d: 100, railA: true }))).toBe("near"); // bus bay next to a station entrance
    expect(classifyPair(pair({ d: 100 }))).toBeNull(); // two bus stops with different names are two places
    expect(classifyPair(pair({ d: 100, railA: true, railB: true }))).toBeNull(); // two different rail stations
    expect(classifyPair(pair({ d: 40, railA: true, railB: true }))).toBe("near"); // …unless they are one spot
  });
  it("shrinks the near radius where many differently named stops lie around (cities)", () => {
    expect(classifyPair(pair({ d: 140, railA: true, crowdA: 2 }))).toBe("near");
    expect(classifyPair(pair({ d: 140, railA: true, crowdA: 4 }))).toBeNull();
    expect(classifyPair(pair({ d: 90, railA: true, crowdA: 4 }))).toBe("near");
    expect(classifyPair(pair({ d: 90, railA: true, crowdA: 9 }))).toBeNull();
  });
  it("merges stops with agreeing names further apart, at a larger radius around rail stops", () => {
    expect(classifyPair(pair({ d: 220, sim: 0.9 }))).toBe("name");
    expect(classifyPair(pair({ d: 330, sim: 0.9 }))).toBeNull();
    expect(classifyPair(pair({ d: 330, sim: 0.9, railB: true }))).toBe("name");
    expect(classifyPair(pair({ d: 420, sim: 0.9, railB: true }))).toBeNull();
  });
  it("attaches a bus terminal to the rail station", () => {
    expect(classifyPair(pair({ d: 300, sim: 0.5, termA: true, railB: true }))).toBe("terminal");
    expect(classifyPair(pair({ d: 300, sim: 0.1, termA: true, railB: true }))).toBeNull(); // a different place
    expect(classifyPair(pair({ d: 480, sim: 0.5, termA: true, railB: true }))).toBeNull(); // too far
  });
  it("merges an isolated pair, but not in a busy neighbourhood", () => {
    const alone = { isolated: true };
    expect(classifyPair(pair({ d: 280, sim: 0.1, ...alone }))).toBe("isolated");
    expect(classifyPair(pair({ d: 280, sim: 0.1 }))).toBeNull();
    expect(classifyPair(pair({ d: 280, sim: 0.1, railA: true, railB: true, ...alone }))).toBeNull();
    expect(classifyPair(pair({ d: 320, sim: 0.1, ...alone }))).toBeNull();
  });
  it("applies them to real-looking stops and counts them", () => {
    const stops = [
      stop("Kleinstadt", 10, 50, { rail: true, weight: 50 }),
      stop("Kleinstadt ZOB", 10.0027, 50.0004, { weight: 10 }), // ~200 m, terminal word → merges
      stop("Gasthof Krone", 10.0, 50.0025, { weight: 1 }), // ~280 m, nothing else around → isolated
      stop("Dorf Mitte", 10.1, 50.0), // far away: alone
      stop("Dorf Kirche", 10.1006, 50.0), // 43 m: the same spot
    ];
    const r = mergeStations(stops);
    expect(r.stationOf[0]).toBe(r.stationOf[1]);
    expect(r.stationOf[0]).toBe(r.stationOf[2]);
    expect(r.stationOf[3]).toBe(r.stationOf[4]);
    expect(r.count).toBe(2);
    expect(r.bySignal.terminal + r.bySignal.name).toBeGreaterThanOrEqual(1);
    expect(r.bySignal.isolated).toBe(1);
    expect(r.bySignal.near).toBe(1);
  });
  it("does not chain a street full of stops into one station", () => {
    // a rail stop with a bus stop every 100 m along the street (all within the near radius of the next)
    const stops = [stop("Bahnhof Foo", 10, 50, { rail: true }), ...Array.from({ length: 8 }, (_, i) => stop(`Haltestelle ${i}`, 10 + (i + 1) * 0.0014, 50))];
    const { stationOf } = mergeStations(stops);
    expect(new Set(stationOf).size).toBeGreaterThan(1);
  });
});

describe("names", () => {
  it("removes raw ids and city prefixes some feeds leave in stop names", () => {
    expect(sanitizeName("ROMA | Anagnina (Metro A) # f3583")).toBe("Roma Anagnina (Metro A)");
    expect(sanitizeName("ROMA | Via Pontina Via Vallerano # f2688")).toBe("Roma Via Pontina Via Vallerano");
    expect(sanitizeName("MONTEROTONDO | Via Unione (Stadio) | Liceo Scientifico G.Peano # f13923")).toBe("Monterotondo Via Unione (Stadio) - Liceo Scientifico G.Peano");
    expect(sanitizeName("Bus Stop #12")).toBe("Bus Stop #12");
    expect(sanitizeName("Gleis #123")).toBe("Gleis #123");
    expect(sanitizeName("Wien Hbf")).toBe("Wien Hbf");
    expect(sanitizeName("Haltestelle &amp; Co")).toBe("Haltestelle & Co");
    expect(sanitizeName("Paris | Gare Routière")).toBe("Paris Gare Routière");
  });
  it("recognises bus / coach terminals in several languages", () => {
    for (const n of ["Berlin ZOB", "Düsseldorf Busbahnhof", "Paris Gare Routière", "Limerick Coach Station", "Zagreb Autobusni kolodvor", "Brașov Autogara", "Ankara Otogar", "Praha autobusové nádraží"]) expect(isTerminalName(n), n).toBe(true);
    for (const n of ["Köln Hbf", "Zobel Strasse", "Busch Allee", "Limerick Junction"]) expect(isTerminalName(n), n).toBe(false);
  });
  it("treats a lone town name as weak evidence for a longer name", () => {
    expect(nameSimilarity("Eschwege Bahnhof", "Eschwege Post")).toBeLessThan(0.6);
    expect(nameSimilarity("Berlin Hbf", "Berlin Hbf (Washingtonplatz)")).toBe(1);
  });
});
