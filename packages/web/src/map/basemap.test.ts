import { describe, expect, it } from "vitest";
import { classifyTile, toSets } from "./basemap.ts";

describe("basemap tile index", () => {
  const sets = toSets({ version: 2, minzoom: 2, maxzoom: 9, tiles: { 5: [10, 11], 6: [20, 22] }, land: { 4: [3, 4], 6: [30, 30] } });
  it("finds files, land (also through ancestors) and sea", () => {
    expect(classifyTile(sets, 5, 10, 11)).toBe("file");
    expect(classifyTile(sets, 6, 20, 22)).toBe("file");
    expect(classifyTile(sets, 4, 3, 4)).toBe("land");
    expect(classifyTile(sets, 6, 13, 17)).toBe("land"); // child of z4 3/4
    expect(classifyTile(sets, 9, 3 * 32 + 5, 4 * 32 + 31)).toBe("land");
    expect(classifyTile(sets, 6, 30, 30)).toBe("land");
    expect(classifyTile(sets, 6, 31, 30)).toBe("sea");
    expect(classifyTile(sets, 3, 0, 0)).toBe("sea");
  });
});
