import { describe, expect, it } from "vitest";
import { MaskStore, expandService, getBit, maskFromBase64, maskToBase64, popcount, shiftMask, weekday } from "../src/core/calendar.ts";
import { isoToEpochDay } from "../src/core/time.ts";

const start = isoToEpochDay("2026-10-12"); // a Monday

describe("calendar expansion", () => {
  it("weekday is Monday-based", () => {
    expect(weekday(start)).toBe(0);
    expect(weekday(start + 6)).toBe(6);
  });
  it("expands weekdays within range", () => {
    const m = expandService(
      { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false, start, end: start + 13 },
      [],
      start,
      60,
    );
    expect(popcount(m)).toBe(10);
    expect(getBit(m, 0)).toBe(true);
    expect(getBit(m, 5)).toBe(false);
    expect(getBit(m, 14)).toBe(false);
  });
  it("applies exceptions and works without calendar.txt", () => {
    const m = expandService(null, [{ day: start + 3, type: 1 }, { day: start + 70, type: 1 }], start, 60);
    expect(popcount(m)).toBe(1);
    const m2 = expandService(
      { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true, start, end: start + 100 },
      [{ day: start + 1, type: 2 }],
      start,
      60,
    );
    expect(popcount(m2)).toBe(59);
    expect(getBit(m2, 1)).toBe(false);
  });
  it("base64 is little-endian bit order and dedups", () => {
    const m = expandService(null, [{ day: start, type: 1 }, { day: start + 9, type: 1 }], start, 16);
    expect([...m]).toEqual([1, 2]);
    expect(maskFromBase64(maskToBase64(m))).toEqual(m);
    const s = new MaskStore();
    expect(s.add(m)).toBe(0);
    expect(s.add(Uint8Array.from(m))).toBe(0);
    expect(s.add(new Uint8Array(2))).toBe(1);
  });
  it("shifts masks", () => {
    const m = expandService(null, [{ day: start, type: 1 }, { day: start + 59, type: 1 }], start, 60);
    const s = shiftMask(m, 1, 60);
    expect(getBit(s, 1)).toBe(true);
    expect(popcount(s)).toBe(1);
  });
});
