import { describe, expect, it } from "vitest";
import { addDays, buildCalIndex, daysNote, decodeMask, departureMask, encodeMask, formatDateShort, runsOnDate, weekday, weekdayNote, inHorizon } from "./calendar.ts";
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
    expect(weekdayNote(cal, 1)).toBe("Fri, Sun");
    expect(weekdayNote(cal, 2)).toBe("no service");
    expect(weekdayNote(cal, 3)).toBe("only Mon 5 Oct, Tue 6 Oct, Wed 7 Oct");
    expect(weekdayNote(cal, 4)).toBe("Mon–Fri");
  });
  it("not-Saturday note", () => {
    const c = { ...cal, masks: [decodeMask(encodeMask(Array.from({ length: 28 }, (_, i) => (1 + i) % 7 !== 6)))], anyDay: [true] };
    expect(weekdayNote(c, 0)).toBe("Daily except Sat");
    const c2 = { ...cal, masks: [decodeMask(encodeMask(Array.from({ length: 28 }, (_, i) => ![2, 3].includes((1 + i) % 7))))], anyDay: [true] };
    expect(weekdayNote(c2, 0)).toBe("Daily except Tue, Wed");
  });

  // 60-day horizon from Sun 11 Oct 2026 (day i is weekday (i % 7), 0 = Sun)
  const H = 60;
  const mk = (pred: (i: number) => boolean) => buildCalIndex({ startDate: "2026-10-11", days: H, masks: [encodeMask(Array.from({ length: H }, (_, i) => pred(i)))] });
  const note = (pred: (i: number) => boolean) => weekdayNote(mk(pred), 0);
  const wd = (i: number) => i % 7;

  it("labels exact weekday sets", () => {
    expect(note(() => true)).toBeNull();
    expect(note((i) => wd(i) >= 1 && wd(i) <= 5)).toBe("Mon–Fri");
    expect(note((i) => wd(i) === 0)).toBe("Sun only");
    expect(note((i) => wd(i) === 1 || wd(i) === 4)).toBe("Mon, Thu");
    expect(note((i) => wd(i) !== 6)).toBe("Daily except Sat");
  });

  it("never claims a weekday from a scattered calendar", () => {
    // Mon–Fri on 14 scattered dates (the old majority rule said "Thu only")
    const on = new Set([4, 11, 18, 25, 32, 2, 9, 23, 30, 39, 46, 15, 36, 50]);
    const n = note((i) => on.has(i));
    expect(n).toBe("runs 13, 15, 20 Oct +11");
    expect(n).not.toMatch(/only/);
  });

  it("names few exceptions and the service period", () => {
    expect(note((i) => wd(i) >= 1 && wd(i) <= 5 && i !== 22)).toBe("Mon–Fri except Mon 2 Nov");
    expect(note((i) => wd(i) >= 1 && wd(i) <= 5 && ![22, 29, 36].includes(i))).toBe("Mon–Fri except 3 dates");
    expect(note((i) => wd(i) !== 6 && i !== 8)).toBe("Daily except Sat and Mon 19 Oct");
    expect(note((i) => wd(i) === 0 || i === 13)).toBe("Sun only, also Sat 24 Oct");
    expect(note((i) => i < 30)).toBe("Daily until 9 Nov");
    expect(note((i) => i >= 20 && (wd(i) === 6 || wd(i) === 0))).toBe("Sat, Sun from 31 Oct");
  });

  it("shifts service days to departure days", () => {
    const c = mk((i) => wd(i) === 5); // Fri service day
    expect(daysNote(c, departureMask(c, 0, 1))).toBe("Sat only"); // departs after midnight
  });

});
