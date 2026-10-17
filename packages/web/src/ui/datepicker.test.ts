import { describe, expect, it } from "vitest";
import { monthGrid } from "./datepicker.ts";

describe("date picker month grid", () => {
  it("lays a month out in Monday-first weeks", () => {
    const oct = monthGrid("2026-10"); // 1 Oct 2026 is a Thursday
    expect(oct[0]).toEqual([null, null, null, "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(oct.flat().filter(Boolean)).toHaveLength(31);
    expect(oct[oct.length - 1]).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", null]);
    expect(oct.every((w) => w.length === 7)).toBe(true);
  });
  it("handles a month starting on Monday and February", () => {
    expect(monthGrid("2027-02")[0]![0]).toBe("2027-02-01"); // a Monday
    expect(monthGrid("2027-02").flat().filter(Boolean)).toHaveLength(28);
    expect(monthGrid("2028-02").flat().filter(Boolean)).toHaveLength(29);
    expect(monthGrid("2026-12").flat().filter(Boolean).pop()).toBe("2026-12-31");
  });
});
