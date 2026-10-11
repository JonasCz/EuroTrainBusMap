import { describe, expect, it } from "vitest";
import { CAT_BITS, Cat, LEVELS, levelIndex, promoteSparse } from "@etbm/shared";

const NC = CAT_BITS.length;
const bus = CAT_BITS.indexOf(Cat.Bus);
/** n parallel east–west lines, 0.01° apart, 50 km long, starting at lon0 */
function lines(lon0: number, n: number) {
  return Array.from({ length: n }, (_, i) => [[lon0, 45 + i * 0.01], [lon0 + 0.65, 45 + i * 0.01]] as [number, number][]);
}

describe("density-aware LOD", () => {
  // a sparse region with 1 bus line and a dense one with 120 bus lines, all at base level 9.5
  const segCoords = [...lines(0, 1), ...lines(10, 120)];
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
    promoteSparse({ segCoords, corridors, cats: CAT_BITS, levels }, { budget: 600 });
    return corridors.slice(1).map((_, c) => LEVELS[levels[(c + 1) * NC + bus]!]);
  };

  it("promotes lines in sparse areas only, by at most MAX_PROMOTE levels", () => {
    const z = run();
    expect(z[0]).toBe(LEVELS[base - 3]); // 7.5
    const dense = z.slice(1);
    expect(dense.filter((x) => x === 9.5).length).toBeGreaterThan(60);
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
});
