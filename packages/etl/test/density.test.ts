import { describe, expect, it } from "vitest";
import { CAT_BITS, Cat, LEVELS, PROMOTE_FLOOR, SEED_FLOOR, SEED_MAX_ZOOM, levelIndex, monotoneLevels, promoteScenarios, promoteSparse } from "@etbm/shared";

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

  it("does not promote lines that touch nothing visible next to the visible network", () => {
    // the visible long-distance line runs 0.1° (~11 km) beside the bus line, without a common node
    const levels = new Int8Array(2 * NC).fill(127);
    levels[ld] = 0;
    levels[1 * NC + bus] = base;
    const segs = [segCoords[0]!, segCoords[0]!.map(([x, y]) => [x, y + 0.1] as [number, number])];
    promoteSparse({ segCoords: segs, corridors: [{ ...corridors[0]!, segs: [1] }, { ...corridors[1]!, a: 5, b: 6 }], cats: CAT_BITS, levels });
    expect(levels[1 * NC + bus]).toBe(base);
  });

  it("seeds an unconnected network in an empty region (an island) and grows it from there", () => {
    // mainland: a visible long-distance line at lon 0; island (Iceland-like, 64° N, 20° further west):
    // two bus lines meeting at node 21, not connected to the mainland, base levels 9.5 / 8.5
    const segs: [number, number][][] = [
      [[0, 50], [2, 50]],
      [[-23, 64], [-20, 64]], // island line A (busiest)
      [[-20, 64], [-18, 65]], // island line B
    ];
    const cors = [
      { a: 0, b: 1, segs: [0], cats: Cat.LongDistance, tpd: { [Cat.LongDistance]: 20 } },
      { a: 20, b: 21, segs: [1], cats: Cat.Bus, tpd: { [Cat.Bus]: 60 } },
      { a: 21, b: 22, segs: [2], cats: Cat.Bus, tpd: { [Cat.Bus]: 3 } },
    ];
    const mk = () => {
      const levels = new Int8Array(cors.length * NC).fill(127);
      levels[ld] = 0;
      levels[1 * NC + bus] = levelIndex(8.5);
      levels[2 * NC + bus] = base;
      return levels;
    };
    const levels = mk();
    promoteSparse({ segCoords: segs, corridors: cors, cats: CAT_BITS, levels });
    expect(LEVELS[levels[1 * NC + bus]!]).toBe(SEED_FLOOR); // the island's main line, below the bus floor
    expect(LEVELS[levels[2 * NC + bus]!]).toBe(PROMOTE_FLOOR[Cat.Bus]); // grows out of it from the bus floor
    // without seeds the island stays empty until the base levels
    const off = mk();
    promoteSparse({ segCoords: segs, corridors: cors, cats: CAT_BITS, levels: off }, { seed: false });
    expect(LEVELS[off[1 * NC + bus]!]).toBe(8.5);
    expect(LEVELS[off[2 * NC + bus]!]).toBe(8.5); // grows from line A only once that one is in
  });

  it("seeds one line per empty neighbourhood, the most important one", () => {
    // 20 unconnected parallel bus lines, 1 km apart, 2° long, in an otherwise empty map; the busiest
    // one is a short town hop (too short to stand for the region)
    const segs = Array.from({ length: 20 }, (_, i) => [[10, 45 + i * 0.01], [i === 19 ? 10.05 : 12, 45 + i * 0.01]] as [number, number][]);
    const cors = segs.map((_, i) => ({ a: 100 + 2 * i, b: 101 + 2 * i, segs: [i], cats: Cat.Bus, tpd: { [Cat.Bus]: 10 + i } }));
    const levels = new Int8Array(cors.length * NC).fill(127);
    cors.forEach((_, i) => (levels[i * NC + bus] = base));
    promoteSparse({ segCoords: segs, corridors: cors, cats: CAT_BITS, levels });
    const z = cors.map((_, i) => LEVELS[levels[i * NC + bus]!]);
    expect(z[18]).toBe(SEED_FLOOR); // the busiest long enough to be seen
    expect([...z.slice(0, 18), z[19]].every((x) => x! > SEED_MAX_ZOOM)).toBe(true); // the others stay at their base level
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
