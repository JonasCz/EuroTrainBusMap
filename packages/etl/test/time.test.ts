import { describe, expect, it } from "vitest";
import { isUtcLike, parseGtfsDate, parseGtfsTime, tzOffsetMinutes, isoToEpochDay, epochDayToIso } from "../src/core/time.ts";

describe("parseGtfsTime", () => {
  it("parses normal and >24h times", () => {
    expect(parseGtfsTime("08:15:00")).toBe(495);
    expect(parseGtfsTime("25:10:59")).toBe(1510);
    expect(parseGtfsTime(" 7:05:00 ")).toBe(425);
    expect(parseGtfsTime("100:00:00")).toBe(6000);
  });
  it("rejects garbage", () => {
    expect(parseGtfsTime("")).toBeNull();
    expect(parseGtfsTime(null)).toBeNull();
    expect(parseGtfsTime("ab:cd")).toBeNull();
    expect(parseGtfsTime("10:75:00")).toBeNull();
  });
});

describe("dates and timezones", () => {
  it("parses YYYYMMDD", () => {
    expect(epochDayToIso(parseGtfsDate("20261011")!)).toBe("2026-10-11");
    expect(isoToEpochDay("1970-01-02")).toBe(1);
  });
  it("computes offsets with DST", () => {
    expect(tzOffsetMinutes("Europe/Berlin", isoToEpochDay("2026-07-01"))).toBe(120);
    expect(tzOffsetMinutes("Europe/Berlin", isoToEpochDay("2026-12-01"))).toBe(60);
    expect(tzOffsetMinutes("Europe/London", isoToEpochDay("2026-12-01"))).toBe(0);
    expect(tzOffsetMinutes("Europe/Istanbul", isoToEpochDay("2026-12-01"))).toBe(180);
  });
  it("detects UTC zones", () => {
    expect(isUtcLike("UTC")).toBe(true);
    expect(isUtcLike("Etc/UTC")).toBe(true);
    expect(isUtcLike("Europe/London")).toBe(false);
  });
});
