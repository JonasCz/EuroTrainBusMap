import { describe, expect, it } from "vitest";
import { Cat, Flag } from "@etbm/shared";
import { classifyRoute, displayName, heuristicRailCat, modeOfRouteType, type ClassifyContext } from "../src/core/classify.ts";

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
    expect(classifyRoute(r(2, "16"), ctx({ opts: { railCatDefault: "Regional", dticket: true }, country: "DE" }))).toEqual({
      cls: "rail", cat: Cat.Regional, flags: Flag.DTicket,
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
  it("drops replacement and urban buses, sets D-Ticket for DE buses", () => {
    expect(classifyRoute(r(3, "SEV"), ctx())).toBeNull();
    expect(classifyRoute(r(3, "Bus SEV"), ctx())).toBeNull();
    expect(classifyRoute(r(3, "13A", "", "Wiener Linien"), ctx())).toBeNull();
    expect(classifyRoute(r(3, "800", "", "RVO"), ctx({ country: "DE", opts: { dticket: true } }))?.flags).toBe(Flag.DTicket);
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
