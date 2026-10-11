import { describe, expect, it } from "vitest";
import { addDays, decodeMask, encodeMask, formatDateShort, runsOnDate, weekday, weekdayNote, inHorizon } from "./calendar.ts";
import { cal } from "./testdata.ts";

describe("calendar", () => {
  it("round-trips masks", () => {
    const bits = [true, false, true, true, false, false, false, false, true];
    const m = decodeMask(encodeMask(bits));
    expect(m.length).toBe(2);
    expect(m[0]).toBe(0b1101);
    expect(m[1]).toBe(1);
  });
  it("date arithmetic", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(weekday("2026-10-05")).toBe(1);
    expect(formatDateShort("2026-11-14")).toBe("Sat 14 Nov");
  });
  it("runs on date", () => {
    expect(runsOnDate(cal, 1, "2026-10-09")).toBe(true); // Fri
    expect(runsOnDate(cal, 1, "2026-10-10")).toBe(false); // Sat
    expect(runsOnDate(cal, 0, "2026-10-04")).toBe(false); // before horizon
    expect(runsOnDate(cal, 0, "2026-11-02")).toBe(false); // after horizon
    expect(inHorizon(cal, "2026-11-01")).toBe(true);
  });
  it("weekday notes", () => {
    expect(weekdayNote(cal, 0)).toBeNull();
    expect(weekdayNote(cal, 1)).toBe("Fri, Sun only");
    expect(weekdayNote(cal, 2)).toBe("no service");
    expect(weekdayNote(cal, 3)).toBe("only Mon 5 Oct, Tue 6 Oct, Wed 7 Oct");
    expect(weekdayNote(cal, 4)).toBe("Mon–Fri only");
  });
  it("not-Saturday note", () => {
    const c = { ...cal, masks: [decodeMask(encodeMask(Array.from({ length: 28 }, (_, i) => (1 + i) % 7 !== 6)))], anyDay: [true] };
    expect(weekdayNote(c, 0)).toBe("not Sat");
    const c2 = { ...cal, masks: [decodeMask(encodeMask(Array.from({ length: 28 }, (_, i) => ![2, 3].includes((1 + i) % 7))))], anyDay: [true] };
    expect(weekdayNote(c2, 0)).toBe("not Tue, Wed");
  });
});
