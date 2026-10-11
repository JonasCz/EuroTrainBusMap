import { describe, expect, it } from "vitest";
import { fmtDuration, fmtTime, localDate, serviceTimeToUtc, toLocal, tzOffset, wallToUtc } from "./tz.ts";

const iso = (t: number) => new Date(t).toISOString().slice(0, 16);

describe("tz", () => {
  it("offsets", () => {
    expect(tzOffset("Europe/Berlin", Date.UTC(2026, 6, 1))).toBe(120);
    expect(tzOffset("Europe/Berlin", Date.UTC(2026, 0, 1))).toBe(60);
    expect(tzOffset("Europe/Istanbul", Date.UTC(2026, 0, 1))).toBe(180);
    expect(tzOffset("Europe/Lisbon", Date.UTC(2026, 0, 1))).toBe(0);
    expect(tzOffset("Europe/Helsinki", Date.UTC(2026, 6, 1))).toBe(180);
  });
  it("service time to UTC", () => {
    expect(iso(serviceTimeToUtc("2026-07-01", 600, "Europe/Berlin"))).toBe("2026-07-01T08:00");
    expect(iso(serviceTimeToUtc("2026-07-01", 600, "Europe/Istanbul"))).toBe("2026-07-01T07:00");
    expect(iso(serviceTimeToUtc("2026-01-15", 600, "Europe/London"))).toBe("2026-01-15T10:00");
    // past midnight
    expect(iso(serviceTimeToUtc("2026-07-01", 1500, "Europe/Berlin"))).toBe("2026-07-01T23:00");
    // DST start day: GTFS "noon minus 12h" reference
    expect(iso(serviceTimeToUtc("2026-03-29", 600, "Europe/Berlin"))).toBe("2026-03-29T08:00");
    expect(iso(serviceTimeToUtc("2026-03-29", 60, "Europe/Berlin"))).toBe("2026-03-28T23:00");
  });
  it("wall clock to UTC around DST end", () => {
    expect(iso(wallToUtc("2026-10-25", 600, "Europe/Berlin"))).toBe("2026-10-25T09:00");
    expect(iso(wallToUtc("2026-10-24", 600, "Europe/Berlin"))).toBe("2026-10-24T08:00");
  });
  it("formats in local zone", () => {
    const t = Date.UTC(2026, 6, 1, 22, 30);
    expect(fmtTime(t, "Europe/London")).toBe("23:30");
    expect(fmtTime(t, "Europe/Berlin")).toBe("00:30");
    expect(fmtTime(t, "Europe/Istanbul")).toBe("01:30");
    expect(localDate(t, "Europe/Berlin")).toBe("2026-07-02");
    expect(toLocal(t, "Europe/London")).toEqual({ date: "2026-07-01", minutes: 1410 });
  });
  it("durations", () => {
    expect(fmtDuration(45)).toBe("45 min");
    expect(fmtDuration(125)).toBe("2 h 05");
  });
});
