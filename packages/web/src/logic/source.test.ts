import { describe, expect, it } from "vitest";
import { retrievedDate, retrievedTime, sourceHost, sourceLinkText, sourceMeta } from "./source.ts";

describe("source link of generated timetables", () => {
  it("shows the host and the day the timetable was retrieved", () => {
    expect(sourceLinkText({ src: "https://www.zfbh.ba/en/time-table/", srcAt: "2026-10-19T17:53:12Z" })).toEqual({
      text: "Timetable: zfbh.ba · retrieved 19 Oct 2026",
      title: "Generated from the timetable on zfbh.ba, read 19 Oct 2026, 17:53 UTC (no open data feed exists): check it there before travelling",
    });
    expect(sourceLinkText({ src: "https://redvoznje.ba/", srcAt: "2026-10-19T23:59:59Z" })!.text).toBe("Timetable: redvoznje.ba · retrieved 19 Oct 2026");
  });

  it("falls back to the host alone without (or with an unreadable) retrieval time, and to nothing without a source", () => {
    expect(sourceLinkText({ src: "https://www.zfbh.ba/en/time-table/" })!.text).toBe("Timetable: zfbh.ba");
    expect(sourceLinkText({ src: "https://www.zfbh.ba/", srcAt: "2026-10-19" })!.text).toBe("Timetable: zfbh.ba");
    expect(sourceLinkText({})).toBeNull();
    expect(sourceLinkText({ src: "javascript:alert(1)" })).toBeNull();
  });

  it("formats dates in UTC and data source lines", () => {
    expect(retrievedDate("2026-12-31T23:30:00Z")).toBe("31 Dec 2026");
    expect(retrievedDate("not a date")).toBeNull();
    expect(retrievedTime("2026-10-19T07:05:00Z")).toBe("19 Oct 2026, 07:05 UTC");
    expect(sourceHost("https://www.example.org/x")).toBe("example.org");
    expect(sourceMeta({ license: "CC-BY-4.0", retrieved: "2026-10-19T17:53:12Z" })).toBe(" — CC-BY-4.0 · retrieved 19 Oct 2026");
    expect(sourceMeta({ license: "ODbL-1.0" })).toBe(" — ODbL-1.0");
  });
});
