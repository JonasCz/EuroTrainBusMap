import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csvLine, expiredReason, feedValidity, readFeedValidity, zipExpired } from "../src/gtfs/validity.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "validity-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A zip with the given GTFS files (name → text). */
async function zipOf(name: string, files: Record<string, string>): Promise<string> {
  const d = join(dir, name);
  execFileSync("mkdir", ["-p", d]);
  for (const [n, t] of Object.entries(files)) await writeFile(join(d, n), t);
  const z = join(dir, `${name}.zip`);
  execFileSync("zip", ["-q", "-j", z, ...Object.keys(files).map((n) => join(d, n))]);
  return z;
}

describe("feed validity (out-of-date feeds are skipped)", () => {
  it("reads the last service day from calendar and calendar_dates, and feed_end_date", async () => {
    const z = await zipOf("a", {
      "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nwk,1,1,1,1,1,0,0,20251104,20261105\nnone,0,0,0,0,0,0,0,20251104,20991231\n",
      "calendar_dates.txt": "﻿service_id,date,exception_type\nwk,20261224,2\nx,20261120,1\n",
      "feed_info.txt": 'feed_publisher_name,feed_end_date\n"Op, Inc",20261202\n',
    });
    // the calendar row without a weekday does not count; a removed date (type 2) neither
    expect(await readFeedValidity(z)).toEqual({ lastService: "2026-11-20", feedEnd: "2026-12-02" });
    // cached beside the zip
    expect(await feedValidity(z)).toEqual({ lastService: "2026-11-20", feedEnd: "2026-12-02" });
    expect(existsSync(z + ".validity.json")).toBe(true);
    expect(await zipExpired(z, "2026-10-18")).toBeNull();
    expect(await zipExpired(z, "2026-11-21")).toBe("service ended on 2026-11-20");
  });

  it("a feed_end_date before the build start makes a feed with stray later services out of date", () => {
    // Zaragoza (Oct 2026): the bulk of service ends with feed_info on 2026-10-05, one service runs to December
    expect(expiredReason({ lastService: "2026-12-17", feedEnd: "2026-10-05" }, "2026-10-18")).toBe("feed_info ends on 2026-10-05 (stray services to 2026-12-17)");
    expect(expiredReason({ lastService: "2025-07-15", feedEnd: null }, "2026-10-18")).toBe("service ended on 2025-07-15");
    // Centrotrans: valid to 2026-11-05, in date now, drops out by itself from 2026-11-06
    expect(expiredReason({ lastService: "2026-11-05", feedEnd: null }, "2026-10-18")).toBeNull();
    expect(expiredReason({ lastService: "2026-11-05", feedEnd: null }, "2026-11-06")).toBe("service ended on 2026-11-05");
    // nothing known: left to the loader
    expect(expiredReason({ lastService: null, feedEnd: null }, "2026-10-18")).toBeNull();
  });

  it("a feed without calendar files counts as in date", async () => {
    const z = await zipOf("b", { "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\na,A,1,2\n" });
    expect(await zipExpired(z, "2026-10-18")).toBeNull();
  });

  it("splits quoted CSV cells", () => {
    expect(csvLine('a,"b, c","d ""e""",')).toEqual(["a", "b, c", 'd "e"', ""]);
  });
});
