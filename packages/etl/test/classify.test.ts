import { describe, expect, it } from "vitest";
import { Cat, Flag } from "@etbm/shared";
import { classifyRoute, displayName, heuristicRailCat, isHighSpeedService, modeOfRouteType, type ClassifyContext } from "../src/core/classify.ts";

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
    expect(classifyRoute(r(2, "A-1", "REX"), ctx())?.cat).toBe(Cat.Regional);
    expect(classifyRoute(r(2, "ICE 597"), ctx())?.cat).toBe(Cat.LongDistance);
    expect(classifyRoute(r(2, "RE1"), ctx())?.cat).toBe(Cat.Regional);
    expect(classifyRoute(r(2, "Stoptrein RS21"), ctx())?.cat).toBe(Cat.Regional);
    expect(classifyRoute(r(2, "TGV INOUI"), ctx())?.cat).toBe(Cat.LongDistance);
    expect(classifyRoute(r(2, "Os 5403"), ctx())?.cat).toBe(Cat.Regional);
    expect(classifyRoute(r(2, "LNER", "", "LNER"), ctx({ country: "GB" }))?.cat).toBe(Cat.LongDistance);
    expect(classifyRoute(r(2, "Northern", "", "Northern Rail"), ctx({ country: "GB" }))?.cat).toBe(Cat.Regional);
    expect(classifyRoute(r(2, "GWR", "", "GWR"), ctx({ country: "GB" }))?.cat).toBeNull(); // mixed → per-trip heuristic
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
});

describe("displayName", () => {
  it("splits train numbers", () => {
    expect(displayName("ICE 597", "", "", "DB")).toEqual({ name: "ICE", number: "597" });
    expect(displayName("A-1", "", "REX 1234", "ÖBB")).toEqual({ name: "REX", number: "REX 1234" });
    expect(displayName("IR13", "", "21174", "SBB")).toEqual({ name: "IR13", number: "21174" });
    expect(displayName("RE 1", "", "", "DB")).toEqual({ name: "RE 1" });
    expect(displayName("", "Berlin - Hamburg", "", "X")).toEqual({ name: "Berlin - Hamburg" });
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
    expect(hs(["Paris-Gare-de-Lyon/Lyon-Perrache"], "Trenitalia")).toBe(true);
    expect(hs(["FRPNO -> GBSPX"], "Eurostar")).toBe(true);
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
