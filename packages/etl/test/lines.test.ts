import { describe, expect, it } from "vitest";
import { CAT_BITS, Cat, LEVELS, levelIndex, lineGroups, smoothLevels } from "@etbm/shared";

const NC = CAT_BITS.length;
const bus = CAT_BITS.indexOf(Cat.Bus);
const rail = CAT_BITS.indexOf(Cat.Regional);

describe("line groups", () => {
  // A-B-C-D chain, a branch D-E and D-F (junction at D), an express A-C
  const cors = [
    { a: 0, b: 1, cats: Cat.Regional },
    { a: 1, b: 2, cats: Cat.Regional },
    { a: 2, b: 3, cats: Cat.Regional },
    { a: 3, b: 4, cats: Cat.Regional },
    { a: 3, b: 5, cats: Cat.Regional },
    { a: 0, b: 2, cats: Cat.Regional }, // express skipping B
    { a: 0, b: 1, cats: Cat.Bus },
  ];
  it("joins hops through two-corridor cities and stops at junctions", () => {
    const g = lineGroups(cors, CAT_BITS);
    const r = (c: number) => g[c * NC + rail]!;
    // A has 2 rail corridors (A-B, A-C), B has 2 (A-B, B-C), C has 3 (B-C, C-D, A-C): junction at C and D
    expect(r(0)).toBe(r(1));
    expect(r(0)).toBe(r(5));
    expect(r(2)).not.toBe(r(0));
    expect(r(3)).not.toBe(r(4));
    expect(r(3)).not.toBe(r(2));
    expect(g[6 * NC + bus]).toBeGreaterThanOrEqual(0);
    expect(g[6 * NC + rail]).toBe(-1);
    expect(g[6 * NC + bus]).not.toBe(r(0));
  });

  it("skips corridors and numbers groups deterministically", () => {
    const skip = new Uint8Array(cors.length * NC);
    skip[1 * NC + rail] = 1;
    const g = lineGroups(cors, CAT_BITS, skip);
    expect(g[1 * NC + rail]).toBe(-1);
    expect(g).toEqual(lineGroups(cors, CAT_BITS, skip));
  });

  it("smooths levels to the earliest in a group and leaves undrawn alone", () => {
    const levels = new Int8Array(cors.length * NC).fill(127);
    levels[0 * NC + rail] = levelIndex(8);
    levels[1 * NC + rail] = levelIndex(6);
    levels[5 * NC + rail] = levelIndex(9.5);
    levels[2 * NC + rail] = levelIndex(8.5);
    smoothLevels(levels, lineGroups(cors, CAT_BITS));
    expect([0, 1, 5].map((c) => LEVELS[levels[c * NC + rail]!])).toEqual([6, 6, 6]);
    expect(LEVELS[levels[2 * NC + rail]!]).toBe(8.5);
    expect(levels[0 * NC + bus]).toBe(127);
  });
});
