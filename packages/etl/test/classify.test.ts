import { describe, expect, it } from "vitest";
import { Cat, Flag } from "@etbm/shared";
import {
  classifyRoute, displayName, heuristicRailCat, isHighSpeedService, isReplacementName, modeOfRouteType, RAIL_LINE_CODE_RE,
  REPLACEMENT_HEADSIGN_RE, type ClassifyContext,
} from "../src/core/classify.ts";

const ctx = (over: Partial<ClassifyContext> = {}): ClassifyContext => ({
  keep: ["rail", "coach", "bus"],
  opts: {},
  country: "AT",
  coachRe: /\b(flix ?bus|national express|regiojet)\b/i,
  urbanRe: /\b(wiener linien|bvg)\b/i,
  ...over,
});
const r = (routeType: number, shortName = "", tripPrefix = "", agency = "X", longName = "", desc = "") => ({
  routeType, shortName, tripPrefix, agency, longName, desc,
});

describe("mode filter", () => {
  it("keeps rail/bus/coach and drops urban modes", () => {
    expect(modeOfRouteType(2)).toBe("rail");
    expect(modeOfRouteType(109)).toBe("rail");
    expect(modeOfRouteType(3)).toBe("bus");
    expect(modeOfRouteType(202)).toBe("coach");
    for (const t of [0, 1, 4, 5, 6, 7, 11, 12, 400, 900, 1000, 1300, 1400, 714, 715]) expect(modeOfRouteType(t)).toBeNull();
  });
});

describe("rail category", () => {
  it("uses extended route types", () => {
    expect(classifyRoute(r(102, "IC1"), ctx())?.cat).toBe(Cat.LongDistance);
    expect(classifyRoute(r(106, "R1"), ctx())?.cat).toBe(Cat.Regional);
    expect(classifyRoute(r(109, "S1"), ctx())?.cat).toBe(Cat.Regional);
    const nj = classifyRoute(r(105, "NJ"), ctx())!;
    expect(nj.cat).toBe(Cat.LongDistance);
    expect(nj.flags & Flag.Night).toBeTruthy();
  });
  it("uses train name tokens for route_type 2", () => {
    expect(classifyRoute(r(2, "A-1", "RJX"), ctx())?.cat).toBe(Cat.LongDistance);
    // gtfs.de rv_free: SNCF's Paris – Freiburg TGVs as route "TGD", feed default Regional
    expect(classifyRoute(r(2, "TGD", "", "SNCF"), ctx({ opts: { railCatDefault: "Regional" } }))?.cat).toBe(Cat.LongDistance);
    expect(classifyRoute(r(2, "A-1", "REX"), ctx())?.cat).toBe(Cat.Regional);
    expect(classifyRoute(r(2, "ICE 597"), ctx())?.cat).toBe(Cat.LongDistance);
    expect(classifyRoute(r(2, "RE1"), ctx())?.cat).toBe(Cat.Regional);
    expect(classifyRoute(r(2, "Stoptrein RS21"), ctx())?.cat).toBe(Cat.Regional);
    expect(classifyRoute(r(2, "TGV INOUI"), ctx())?.cat).toBe(Cat.LongDistance);
    expect(classifyRoute(r(2, "Os 5403"), ctx())?.cat).toBe(Cat.Regional);
    expect(classifyRoute(r(2, "LNER", "", "LNER"), ctx({ country: "GB" }))?.cat).toBe(Cat.LongDistance);
    expect(classifyRoute(r(2, "Northern", "", "Northern Rail"), ctx({ country: "GB" }))?.cat).toBe(Cat.Regional);
    // mixed GB operators (GWR …) are left to the per-trip heuristic by an operator adapter: operators.test.ts
    const nj = classifyRoute(r(2, "NJ 40490"), ctx())!;
    expect(nj.flags & Flag.Night).toBeTruthy();
  });
  it("applies feed options", () => {
    expect(classifyRoute(r(2, "16"), ctx({ opts: { railCatDefault: "Regional" }, country: "DE" }))).toEqual({
      cls: "rail", cat: Cat.Regional, flags: 0,
    });
    expect(classifyRoute(r(2, "X"), ctx({ opts: { railCat: "LongDistance" } }))?.cat).toBe(Cat.LongDistance);
    expect(classifyRoute(r(2, "IC"), ctx({ keep: ["bus"] }))).toBeNull();
  });
  it("per-trip heuristic", () => {
    expect(heuristicRailCat(200, 6, 120)).toBe(Cat.LongDistance);
    expect(heuristicRailCat(40, 15, 60)).toBe(Cat.Regional);
  });
});

describe("bus & coach", () => {
  it("classifies coaches by type and operator", () => {
    expect(classifyRoute(r(200, "A31", "", "National Express"), ctx())?.cls).toBe("coach");
    expect(classifyRoute(r(3, "N123", "", "FlixBus"), ctx())?.cat).toBe(Cat.Coach);
    expect(classifyRoute(r(3, "450", "", "Regionalbus GmbH"), ctx())?.cat).toBe(Cat.Bus);
    expect(classifyRoute(r(200, "5", "", "Volán"), ctx({ opts: { coachTypesAsBus: true } }))?.cat).toBe(Cat.Bus);
    expect(classifyRoute(r(3, "1", "", "X"), ctx({ opts: { allCoach: true } }))?.cat).toBe(Cat.Coach);
  });
  it("drops replacement and urban buses, keeps intercity buses", () => {
    expect(classifyRoute(r(3, "SEV"), ctx())).toBeNull();
    expect(classifyRoute(r(3, "Bus SEV"), ctx())).toBeNull();
    expect(classifyRoute(r(3, "13A", "", "Wiener Linien"), ctx())).toBeNull();
    expect(classifyRoute(r(3, "800", "", "RVO"), ctx({ country: "DE" }))?.cls).toBe("bus");
  });
  it("treats bus / coach trip categories on rail routes as buses (Irish Rail BUS, Car)", () => {
    expect(classifyRoute(r(2, "rail", "BUS", "Iarnród Éireann / Irish Rail", "Dublin - Limerick"), ctx({ country: "IE" }))?.cat).toBe(Cat.Bus);
    expect(classifyRoute(r(2, "rail", "Car", "X"), ctx({ country: "FR" }))).toEqual({ cls: "bus", cat: Cat.Bus, flags: 0 });
    expect(classifyRoute(r(2, "rail", "BUS"), ctx({ keep: ["rail"] }))).toBeNull();
    expect(classifyRoute(r(2, "560A", "IC", "SNCF VOYAGEURS"), ctx({ country: "FR" }))?.cls).toBe("rail");
    // operator-specific categories (SNCF CTE / CRE) need the operator adapter (operators.test.ts)
    expect(classifyRoute(r(2, "P15", "CTE", "SNCF VOYAGEURS", "Colmar - Metzeral"), ctx({ country: "FR" }))?.cls).toBe("rail");
  });
  it("applies operator hooks around the generic rules", () => {
    const hooks = { before: () => ({ mode: "bus" as const, flags: Flag.ReservationOnly }) };
    expect(classifyRoute(r(2, "X", "ZZ"), ctx({ hooks }))).toEqual({ cls: "bus", cat: Cat.Bus, flags: Flag.ReservationOnly });
    // the forced mode still goes through the feed's keep list and the replacement filter
    expect(classifyRoute(r(2, "X", "ZZ"), ctx({ hooks, keep: ["rail"] }))).toBeNull();
    expect(classifyRoute(r(2, "SEV", "ZZ"), ctx({ hooks }))).toBeNull();
    // after: replace, drop (null) or keep (undefined); railCatDefault applies after it
    expect(classifyRoute(r(2, "RE1"), ctx({ hooks: { after: (_r, cl) => ({ ...cl, cat: null }) }, opts: { railCatDefault: "LongDistance" } }))?.cat).toBe(Cat.LongDistance);
    expect(classifyRoute(r(2, "RE1"), ctx({ hooks: { after: () => null } }))).toBeNull();
    expect(classifyRoute(r(2, "RE1"), ctx({ hooks: { after: () => undefined } }))?.cat).toBe(Cat.Regional);
  });
});

describe("rail-replacement buses", () => {
  it("drops them by route name, description or agency in every country's wording", () => {
    for (const [short, long, agency] of [
      ["Snelbus ipv trein", "Snelbus ipv trein Arnhem Centraal <-> Ede-Wageningen", "NS"],
      ["RE8", "", "DB SEV GmbH"],
      ["RE14E", "", "Bus SEV, nur Abellio, DB Regio, Go-Ahead"],
      ["H6", "H6 HÉV-pótlóbusz", "MÁV Személyszállítási Zrt. - Helyközi busz"],
      ["", "Treinvervangend vervoer", "Arriva"],
      ["", "Ersättningsbuss Göteborg - Alingsås", "Västtrafik"],
      ["ZKA", "Kraków - Tarnów", "Polregio"],
      ["", "Bus de remplacement", "SNCB"],
      ["B1", "Bahnersatz Visp - Brig", "MGB"],
    ])
      expect(classifyRoute(r(3, short, "", agency, long), ctx())).toBeNull();
    // ŽSR publishes its NAD buses as trains (route_type 106, long name "NAD")
    expect(classifyRoute(r(106, "Os 14281", "", "Železničná spoločnosť Slovensko, a.s.", "NAD"), ctx({ country: "SK" }))).toBeNull();
  });
  it("does not mistake place names for replacement markers", () => {
    expect(isReplacementName("S2", "Březová nad Svitavou – Blansko – Brno", "České dráhy, a.s.")).toBe(false);
    expect(isReplacementName("130", "Bystřice nad Pernštejnem-Žďár nad Sázavou", "ZDAR, a.s.")).toBe(false);
    expect(isReplacementName("N0272", "Celje AP - Planina/Sev.", "Nomago")).toBe(false);
    expect(classifyRoute(r(106, "S2", "", "České dráhy, a.s.", "Březová nad Svitavou – Blansko – Brno"), ctx({ country: "CZ" }))?.cls).toBe("rail");
  });
  it("recognises replacement headsigns, not churches", () => {
    for (const hs of ["Gera Hbf (SEV)", "Derkum Bahnhof SEV, Weilerswist", "Nykøbing F St. (togbus)", "Hauptbahnhof (EV), Aschaffenburg", "SCHIENENERSATZ Donauwörth"])
      expect(REPLACEMENT_HEADSIGN_RE.test(hs)).toBe(true);
    for (const hs of ["Stühlingen Ev. Kirche", "Planina/Sev. - Celje AP", "Sevenum", "Frýdlant nad Ostravicí", "Næstved St."])
      expect(REPLACEMENT_HEADSIGN_RE.test(hs)).toBe(false);
  });
  it("knows train line codes", () => {
    for (const n of ["RE1", "RB 81X", "S1EV", "MEX17E", "RE 7", "IRE3", "S8"]) expect(RAIL_LINE_CODE_RE.test(n)).toBe(true);
    for (const n of ["R90", "X85", "P71", "C24+", "SB66", "450", "RE"]) expect(RAIL_LINE_CODE_RE.test(n)).toBe(false);
  });
});

describe("displayName", () => {
  it("splits train numbers", () => {
    expect(displayName("ICE 597", "", "", "DB")).toEqual({ name: "ICE", number: "597" });
    expect(displayName("A-1", "", "REX 1234", "ÖBB")).toEqual({ name: "REX", number: "REX 1234" });
    expect(displayName("IR13", "", "21174", "SBB")).toEqual({ name: "IR13", number: "21174" });
    expect(displayName("RE 1", "", "", "DB")).toEqual({ name: "RE 1" });
    expect(displayName("", "Berlin - Hamburg", "", "X")).toEqual({ name: "Berlin - Hamburg" });
  });
  it("shows internal category codes under the sold name", () => {
    expect(displayName("TGD", "", "", "SNCF")).toEqual({ name: "TGV" });
    expect(displayName("TGD", "", "TGD 9577", "SNCF")).toEqual({ name: "TGV", number: "TGD 9577" });
  });
});

describe("isHighSpeedService", () => {
  const hs = (names: string[], agency = "", routeType = 2) => isHighSpeedService({ routeType, agency, names });
  it("recognises high-speed brands", () => {
    expect(hs(["TGV INOUI", "421H", "Paris - Bordeaux"], "SNCF VOYAGEURS")).toBe(true);
    expect(hs(["OUIGO", "533A"])).toBe(true);
    expect(hs(["ICE 41"], "DB Fernverkehr AG")).toBe(true);
    expect(hs(["AVE"], "RENFE OPERADORA")).toBe(true);
    expect(hs(["FR", "Frecciarossa"], "TRENITALIA")).toBe(true);
    expect(hs([""], "SBB", 101)).toBe(true);
    // unbranded routes are high-speed only when an operator adapter says so (trenitalia.ts, eurostar.ts)
    expect(hs(["Paris-Gare-de-Lyon/Lyon-Perrache"], "Trenitalia")).toBe(false);
    expect(isHighSpeedService({ routeType: 2, agency: "Trenitalia", names: ["Paris-Gare-de-Lyon/Lyon-Perrache"], highSpeed: true })).toBe(true);
    expect(isHighSpeedService({ routeType: 2, agency: "X", names: ["OUIGO Train Classique"], highSpeed: true })).toBe(false);
  });
  it("leaves conventional trains out", () => {
    expect(hs(["Intercités de nuit", "Paris - Nice"], "SNCF VOYAGEURS")).toBe(false);
    expect(hs(["OUIGO Train Classique"])).toBe(false);
    expect(hs(["IC 55"], "DB Fernverkehr AG")).toBe(false);
    expect(hs(["RE 5"], "DB Regio AG")).toBe(false);
    expect(hs(["TER", "Bordeaux - Angoulême"], "SNCF")).toBe(false);
    expect(hs(["IC", "InterCity"], "PKP Intercity")).toBe(false);
  });
});
