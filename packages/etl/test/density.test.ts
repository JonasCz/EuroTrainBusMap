import { describe, expect, it } from "vitest";
import { CAT_BITS, Cat, LEVELS, PROMOTE_FLOOR, levelIndex, monotoneLevels, promoteScenarios, promoteSparse } from "@etbm/shared";

const NC = CAT_BITS.length;
const bus = CAT_BITS.indexOf(Cat.Bus);
/** n parallel east–west lines, 0.01° apart, 50 km long, starting at lon0 */
function lines(lon0: number, n: number) {
  return Array.from({ length: n }, (_, i) => [[lon0, 45 + i * 0.01], [lon0 + 0.65, 45 + i * 0.01]] as [number, number][]);
}

describe("density-aware LOD", () => {
  // a sparse region with 1 bus line and a dense one with 120 bus lines, all at base level 9.5
  const segCoords = [...lines(0, 1), ...lines(40, 120)];
  // every line starts at a city (0) on the visible network (corridor 0: a long-distance line)
  const corridors = [
    { a: 0, b: 1, segs: [] as number[], cats: Cat.LongDistance, tpd: { [Cat.LongDistance]: 20 } },
    ...segCoords.map((_, i) => ({ a: 0, b: i + 2, segs: [i], cats: Cat.Bus, tpd: { [Cat.Bus]: 10 + i } })),
  ];
  const ld = CAT_BITS.indexOf(Cat.LongDistance);
  const base = levelIndex(9.5);
  const run = () => {
    const levels = new Int8Array(corridors.length * NC).fill(127);
    levels[ld] = 0;
    corridors.forEach((_, c) => c > 0 && (levels[c * NC + bus] = base));
    promoteSparse({ segCoords, corridors, cats: CAT_BITS, levels }, { budget: 150 });
    return corridors.slice(1).map((_, c) => LEVELS[levels[(c + 1) * NC + bus]!]);
  };

  it("promotes lines in sparse areas only, down to the category floor", () => {
    const z = run();
    expect(z[0]).toBe(PROMOTE_FLOOR[Cat.Bus]); // 5
    const dense = z.slice(1);
    expect(dense.filter((x) => x === 9.5).length).toBeGreaterThan(30);
    // busiest dense lines are the ones that got the room
    expect(dense[dense.length - 1]).toBeLessThan(9.5);
  });

  it("does not promote lines that touch nothing visible", () => {
    const levels = new Int8Array(2 * NC).fill(127);
    levels[1 * NC + bus] = base;
    promoteSparse({ segCoords: [segCoords[0]!], corridors: [corridors[0]!, { ...corridors[1]!, a: 5, b: 6 }], cats: CAT_BITS, levels });
    expect(levels[1 * NC + bus]).toBe(base);
  });

  it("is deterministic", () => {
    expect(run()).toEqual(run());
  });

  it("promotes a whole chain of hops together or not at all", () => {
    // a 3-hop bus line A-B-C-D (each hop ~50 km east), hops at different base levels; A is on the visible network
    const hops = [0, 1, 2].map((i) => [[i * 0.65, 45], [(i + 1) * 0.65, 45]] as [number, number][]);
    const cors = [
      { a: 0, b: 10, segs: [] as number[], cats: Cat.LongDistance, tpd: { [Cat.LongDistance]: 20 } },
      ...hops.map((_, i) => ({ a: i, b: i + 1, segs: [i], cats: Cat.Bus, tpd: { [Cat.Bus]: 100 } })),
    ];
    const levels = new Int8Array(cors.length * NC).fill(127);
    levels[ld] = 0;
    [levelIndex(8.5), levelIndex(9.5), levelIndex(8)].forEach((l, i) => (levels[(i + 1) * NC + bus] = l));
    const group = new Int32Array(cors.length * NC).fill(-1);
    for (let i = 1; i <= 3; i++) group[i * NC + bus] = 7;
    promoteSparse({ segCoords: hops, corridors: cors, cats: CAT_BITS, levels, group });
    const got = [1, 2, 3].map((c) => levels[c * NC + bus]);
    expect(new Set(got).size).toBe(1);
    expect(LEVELS[got[0]!]).toBe(PROMOTE_FLOOR[Cat.Bus]);
  });
});

describe("mode scenarios", () => {
  const coach = CAT_BITS.indexOf(Cat.Coach);
  const ldI = CAT_BITS.indexOf(Cat.LongDistance);
  // 30 long-distance lines (base level 0) and, beside them, 30 coach lines (base 8) in the same area,
  // all starting at node 0 / connected to it
  const n = 30;
  const segCoords = [...lines(0, n), ...lines(0.001, n)];
  const corridors = segCoords.map((_, i) =>
    i < n ? { a: 0, b: i + 1, segs: [i], cats: Cat.LongDistance, tpd: { [Cat.LongDistance]: 20 } } : { a: 0, b: i + 1, segs: [i], cats: Cat.Coach, tpd: { [Cat.Coach]: 5 + i } },
  );
  const levels = new Int8Array(corridors.length * NC).fill(127);
  corridors.forEach((c, i) => (levels[i * NC + (c.cats === Cat.Coach ? coach : ldI)] = c.cats === Cat.Coach ? levelIndex(8) : 0));
  const all = (1 << NC) - 1;
  const coachOnly = 1 << coach;

  it("lets a category fill the room of hidden ones", () => {
    const res = promoteScenarios({ segCoords, corridors, cats: CAT_BITS, levels }, [all, coachOnly], { budget: 400 });
    const lv = (r: (typeof res)[number]) => corridors.map((_, i) => r.levels[i * NC + coach]!).slice(n);
    const earliest = (r: (typeof res)[number]) => Math.min(...lv(r));
    // with the long-distance ink counted, coaches come later than when they are alone
    expect(LEVELS[earliest(res[1]!)]).toBeLessThan(LEVELS[earliest(res[0]!)]!);
    expect(LEVELS[earliest(res[1]!)]).toBe(PROMOTE_FLOOR[Cat.Coach]);
    // categories outside a scenario's mask are not drawn there
    expect(res[1]!.levels[0 * NC + ldI]).toBe(127);
    // the input is untouched
    expect(levels[n * NC + coach]).toBe(levelIndex(8));
  });

  it("grows a hidden-category-only area out of the reference scenario's network", () => {
    // a coach line whose only node is on the long-distance network: alone, nothing of its own is visible early
    const cors = [
      { a: 0, b: 1, segs: [0], cats: Cat.LongDistance, tpd: { [Cat.LongDistance]: 20 } },
      { a: 1, b: 2, segs: [1], cats: Cat.Coach, tpd: { [Cat.Coach]: 5 } },
    ];
    const lv = new Int8Array(cors.length * NC).fill(127);
    lv[0 * NC + ldI] = 0;
    lv[1 * NC + coach] = levelIndex(8);
    const res = promoteScenarios({ segCoords: lines(0, 2), corridors: cors, cats: CAT_BITS, levels: lv }, [all, coachOnly]);
    expect(LEVELS[res[1]!.levels[1 * NC + coach]!]).toBe(PROMOTE_FLOOR[Cat.Coach]);
  });

  it("never shows a line later when categories are hidden", () => {
    const mk = (mask: number, v: number[]) => ({ mask, levels: Int8Array.from(v), promoted: [] });
    // 1 corridor × 4 cats; in the subset {cat 1} its level came out later than with all cats
    const res = [mk(all, [0, 5, 6, 127]), mk(0b0010, [127, 8, 127, 127]), mk(0b0110, [127, 4, 9, 127])];
    monotoneLevels(res, NC);
    expect([...res[1]!.levels]).toEqual([127, 4, 127, 127]); // min over its supersets {1,2} and all
    expect([...res[2]!.levels]).toEqual([127, 4, 6, 127]);
    expect([...res[0]!.levels]).toEqual([0, 5, 6, 127]);
  });
});
