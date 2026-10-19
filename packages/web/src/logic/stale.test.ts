import { describe, expect, it } from "vitest";
import { earliestExpired, expiredDate, staleSourceText, staleWarning } from "./stale.ts";

describe("out-of-date timetables", () => {
  it("warns for routes of an expired feed and stays silent for current ones", () => {
    expect(staleWarning({ expired: "2025-07-15" })).toEqual({
      label: "Out of date",
      text: "Timetables out of date — expired 15 Jul 2025",
      title:
        "The operator's timetable data ran out on 15 Jul 2025 and has not been renewed. The times shown repeat its last weekly pattern and may no longer be right: check with the operator before travelling.",
    });
    expect(staleWarning({})).toBeNull();
    expect(staleWarning({ expired: "2025-13-40" })).toBeNull();
    expect(staleWarning({ expired: "15.07.2025" })).toBeNull();
  });

  it("formats dates in UTC", () => {
    expect(expiredDate("2025-12-31")).toBe("31 Dec 2025");
    expect(expiredDate("2026-02-30")).toBeNull();
    expect(expiredDate(undefined)).toBeNull();
  });

  it("takes the earliest expiry of a group", () => {
    expect(earliestExpired([{}, { expired: "2026-06-29" }, undefined, { expired: "2025-12-13" }])).toBe("2025-12-13");
    expect(earliestExpired([{}, undefined])).toBeUndefined();
  });

  it("data sources: the warning, with the stale files of a source of several files", () => {
    expect(staleSourceText({ expired: "2025-12-13" })).toBe("Timetables out of date — expired 13 Dec 2025");
    expect(staleSourceText({ expired: "2025-12-31", expiredParts: ["Autobús-interurbano-de-Navarra"] })).toBe("Timetables out of date — expired 31 Dec 2025 (Autobús-interurbano-de-Navarra)");
    expect(staleSourceText({})).toBeNull();
  });
});
