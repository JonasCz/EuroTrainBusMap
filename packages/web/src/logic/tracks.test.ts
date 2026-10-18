import { describe, expect, it } from "vitest";
import { Cat, type Route } from "@etbm/shared";
import { buildTrackIndex, fmtTpd, itemsAt, nameList, summarizeRuns, type TrackRun } from "./tracks.ts";

// corridors → segments: 1 Bordeaux–Paris (segs 10, 11), 2 Paris–Lyon (20, 21), 3 Lyon–Marseille (30),
// 4 Bordeaux–Toulouse (40), 5 Toulouse–Marseille (50), 6 Marseille–Nice (60, 61); 7 shares segment 21 with 2
const segs: Record<number, number[]> = { 1: [10, 11], 2: [20, 21], 3: [30], 4: [40], 5: [50], 6: [60, 61], 7: [21, 70] };
const segsOf = (c: number) => segs[c];

describe("track index", () => {
  // route options: via Paris (TGV), via Marseille (Intercités + TER), via Paris and Marseille
  const options = [{ corridors: [1, 2, 3, 6] }, { corridors: [4, 5, 6] }, { corridors: [1, 7, 6] }];
  const idx = buildTrackIndex(options, segsOf);

  it("finds every option riding a segment", () => {
    expect([...itemsAt(idx, [20]).keys()]).toEqual([0]);
    // the Paris–Lyon segment 21 is shared by corridor 7
    expect([...itemsAt(idx, [21]).keys()]).toEqual([0, 2]);
    expect([...itemsAt(idx, [60]).keys()]).toEqual([0, 1, 2]);
    expect([...itemsAt(idx, [40]).keys()]).toEqual([1]);
    expect(itemsAt(idx, [999]).size).toBe(0);
  });

  it("gives the first position of the corridor in each item", () => {
    expect(itemsAt(idx, [61])).toEqual(new Map([[0, 3], [1, 2], [2, 2]]));
    // several segments: the earliest position per item
    expect(itemsAt(idx, [11, 61])).toEqual(new Map([[0, 0], [1, 2], [2, 0]]));
  });

  it("skips missing corridors and corridors without geometry", () => {
    const i = buildTrackIndex([{ corridors: [-1, 8, 4] }], segsOf);
    expect(itemsAt(i, [40])).toEqual(new Map([[0, 2]]));
    expect(i.segCorridors.size).toBe(1);
  });
});

describe("runs over a track", () => {
  const route = (name: string, cat: Route["cat"] = Cat.LongDistance): Route => ({ name, agency: "SNCF", cat, flags: 0 });
  // origin Bordeaux; cities 1 Paris, 2 Lyon, 3 Marseille, 4 Toulouse, 5 Agen
  const runs: TrackRun[] = [
    { route: route("TGV INOUI 8401"), tpd: 10, corridors: [1], dests: [{ city: 1, hops: 1 }] },
    { route: route("Intercités 4655"), tpd: 4, corridors: [9, 4, 5], dests: [{ city: 5, hops: 1 }, { city: 4, hops: 2 }, { city: 3, hops: 3 }] },
    { route: route("TER 861", Cat.Regional), tpd: 6, corridors: [9], dests: [{ city: 5, hops: 1 }] },
  ];
  const brand = (r: Route) => r.name.split(" ")[0]!;
  const imp = (c: number) => [0, 1, 0.8, 0.9, 0.85, 0.3][c]!;

  it("lists brands, trips and places beyond the track", () => {
    // corridor 9 (Bordeaux–Agen) is hop 0 of the Intercités and the TER
    const s = summarizeRuns(runs, new Map([[1, 0], [2, 0]]), brand, imp);
    expect(s.brands).toEqual([{ name: "TER", tpd: 6 }, { name: "Intercités", tpd: 4 }]);
    expect(s.tpd).toBe(10);
    expect(s.dests).toEqual([3, 4, 5]);
    // both runs reach Agen first
    expect(s.next).toBe(5);
    expect(s.traffic.get(5)).toEqual({ [Cat.LongDistance]: 4 });
    expect(s.traffic.get(9)).toEqual({ [Cat.LongDistance]: 4, [Cat.Regional]: 6 });
  });

  it("leaves out places before the track", () => {
    // corridor 5 (Toulouse–Marseille) is hop 2 of the Intercités: only Marseille is beyond it
    const s = summarizeRuns(runs, new Map([[1, 2]]), brand, imp);
    expect(s.dests).toEqual([3]);
    expect(s.next).toBe(3);
  });
});

describe("formatting", () => {
  it("counts trips", () => {
    expect(fmtTpd(23.4)).toBe("23 trips a day");
    expect(fmtTpd(1)).toBe("1 trip a day");
    expect(fmtTpd(2 / 7)).toBe("2 trips a week");
    expect(fmtTpd(0.01)).toBe("occasional trips");
  });
  it("shortens lists", () => {
    expect(nameList(["Lyon", "Marseille"])).toBe("Lyon, Marseille");
    expect(nameList(["a", "b", "c", "d", "e"], 3)).toBe("a, b, c +2");
  });
});

describe("trips from line widths (default map tooltip)", () => {
  it("inverts catWidth", async () => {
    const { catWidth, tpdFromWidth } = await import("@etbm/shared");
    for (const [cat, tpd, snapped] of [[Cat.LongDistance, 18, true], [Cat.Bus, 6, true], [Cat.Coach, 3, false]] as const)
      expect(tpdFromWidth(cat, catWidth(cat, tpd, snapped), snapped)).toBeCloseTo(tpd, 5);
    expect(tpdFromWidth(Cat.Regional, 5)).toBe(Infinity);
  });
});
