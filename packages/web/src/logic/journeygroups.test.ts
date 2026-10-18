import { describe, expect, it } from "vitest";
import { Cat } from "@etbm/shared";
import { groupJourneys, legBrand } from "./journeygroups.ts";
import type { Journey, JourneyLeg } from "./transfer.ts";

// stations 0 origin, 1 / 2 two stations of the change city 10 (Paris), 3 change city 11 (Marseille), 4 target
const stationCity = [0, 10, 10, 11, 12];
const leg = (brand: string, from: number, to: number, dep: number, arr: number, cat: number = Cat.LongDistance): JourneyLeg => ({
  patternId: 0, stations: [from, to], arr: [0, arr - dep], dep: [0, arr - dep], cat, brand, start: dep, cal: 0, serviceDate: "2026-10-19",
  board: 0, alight: 1, depUtc: dep * 60000, arrUtc: arr * 60000,
});
const j = (...legs: JourneyLeg[]): Journey => ({ legs, depUtc: legs[0]!.depUtc, arrUtc: legs[legs.length - 1]!.arrUtc });

describe("journey groups", () => {
  it("groups by brands and change cities, rows by departure, groups by speed and changes", () => {
    const rows = [
      j(leg("TGV INOUI", 0, 1, 600, 700), leg("TGV INOUI", 2, 4, 780, 1000)), // walk 1 → 2 in Paris
      j(leg("Intercités", 0, 3, 400, 760), leg("TER", 3, 4, 790, 950, Cat.Regional)),
      j(leg("TGV INOUI", 0, 1, 300, 400), leg("TGV INOUI", 1, 4, 450, 700)), // no walk this time
      j(leg("Intercités", 0, 3, 400, 760), leg("TGV INOUI", 3, 4, 800, 960)),
    ];
    const g = groupJourneys(rows, (r) => r, () => [], stationCity);
    expect(g.map((x) => x.key)).toEqual(["TGV INOUI|TGV INOUI#10", "Intercités|TER#11", "Intercités|TGV INOUI#11"]);
    const tgv = g[0]!;
    expect(tgv.rows.map((r) => r.depUtc / 60000)).toEqual([300, 600]);
    expect([tgv.minMin, tgv.maxMin]).toEqual([400, 400]);
    // the change stations differ between the rows: not shown in the header
    expect(tgv.stations).toEqual([null]);
    expect(g[1]!.stations).toEqual([{ arr: 3, dep: 3 }]);
  });
  it("takes the brand from the matched route when the data has none", () => {
    expect(legBrand("", Cat.Coach, { name: "FlixBus 1628", agency: "FlixBus", cat: Cat.Coach, flags: 0 })).toBe("FlixBus");
    expect(legBrand("TER", Cat.Regional, { name: "C2", agency: "SNCF", cat: Cat.Regional, flags: 0 })).toBe("TER");
    expect(legBrand("", Cat.Bus, { name: "X5", agency: "Stagecoach", cat: Cat.Bus, flags: 0 })).toBe("");
  });
});
