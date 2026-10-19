import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Db } from "../src/db.ts";
import type { FeedsConfig, ResolvedFeed } from "../src/feeds.ts";
import { initSchema, loadFeed } from "../src/gtfs/load.ts";
import { csvLine, expiredReason, expiryDate, feedState, feedValidity, pickReferenceDays, projectionDays, readFeedValidity, referenceWindow, zipState, type RefDay } from "../src/gtfs/validity.ts";
import { better, resolveDuplicates, type DupTrip } from "../src/core/dedup.ts";

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

describe("feed validity", () => {
  it("reads the last service day from calendar and calendar_dates, and feed_end_date", async () => {
    const z = await zipOf("a", {
      "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nwk,1,1,1,1,1,0,0,20251104,20261105\nnone,0,0,0,0,0,0,0,20251104,20991231\n",
      "calendar_dates.txt": "﻿service_id,date,exception_type\nwk,20261224,2\nx,20261120,1\n",
      "feed_info.txt": 'feed_publisher_name,feed_end_date\n"Op, Inc",20261202\n',
    });
    // the calendar row without a weekday does not count; a removed date (type 2) neither
    expect(await readFeedValidity(z)).toEqual({ firstService: "2025-11-04", lastService: "2026-11-20", feedEnd: "2026-12-02" });
    // cached beside the zip
    expect(await feedValidity(z)).toEqual({ firstService: "2025-11-04", lastService: "2026-11-20", feedEnd: "2026-12-02" });
    expect(existsSync(z + ".validity.json")).toBe(true);
    expect(await zipState(z, "2026-10-18")).toEqual({ kind: "current" });
    expect(await zipState(z, "2026-11-21")).toEqual({ kind: "stale", end: "2026-11-20", from: "2025-11-04", reason: "service ended on 2026-11-20" });
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
    expect(await zipState(z, "2026-10-18")).toEqual({ kind: "current" });
  });

  it("splits quoted CSV cells", () => {
    expect(csvLine('a,"b, c","d ""e""",')).toEqual(["a", "b, c", 'd "e"', ""]);
  });
});

describe("stale feeds: kept within the cap, projected", () => {
  it("expiry date, cap and state", () => {
    // stray services after feed_end_date: the feed ran out with feed_info
    expect(expiryDate({ lastService: "2026-12-17", feedEnd: "2026-10-05" }, "2026-10-18")).toBe("2026-10-05");
    expect(expiryDate({ lastService: "2025-07-15", feedEnd: "2025-09-30" }, "2026-10-18")).toBe("2025-07-15");
    expect(expiryDate({ lastService: "2026-11-05", feedEnd: null }, "2026-10-18")).toBeNull();
    // Metrotenerife (ended 2025-07-15): 460 days before the build, within the default 730
    expect(feedState({ lastService: "2025-07-15", feedEnd: null }, "2026-10-18")).toEqual({ kind: "stale", end: "2025-07-15", from: null, reason: "service ended on 2025-07-15" });
    // beyond the cap: skipped
    expect(feedState({ lastService: "2025-07-15", feedEnd: null }, "2026-10-18", 365)).toEqual({ kind: "too-old", end: "2025-07-15", reason: "service ended on 2025-07-15, 460 days before the build (limit 365)" });
    expect(feedState({ lastService: "2024-10-17", feedEnd: null }, "2026-10-18").kind).toBe("too-old");
    expect(feedState({ lastService: "2024-10-18", feedEnd: null }, "2026-10-18").kind).toBe("stale");
    expect(feedState({ lastService: "2026-11-05", feedEnd: null }, "2026-10-18")).toEqual({ kind: "current" });
  });

  it("the reference window: the last six weeks, not before the first service day", () => {
    expect(referenceWindow("2025-07-15")).toEqual({ from: "2025-06-04", days: 42 });
    expect(referenceWindow("2026-06-30", "2026-05-31")).toEqual({ from: "2026-05-31", days: 31 });
    expect(referenceWindow("2026-06-30", "2020-01-01")).toEqual({ from: "2026-05-20", days: 42 });
  });

  const day = (offset: number, trips: number, sig: string): RefDay => ({ offset, weekday: offset % 7, trips, sig });

  it("per weekday the most common service set wins: holidays are outvoted", () => {
    // six Mondays (offsets 0, 7, …): one holiday on a Sunday service, one with extra trips
    const days: RefDay[] = [];
    for (let w = 0; w < 6; w++) for (let d = 0; d < 7; d++) days.push(day(w * 7 + d, d < 5 ? 100 : d === 5 ? 60 : 0, d < 5 ? "wk" : d === 5 ? "sat" : ""));
    days[14] = day(14, 30, "sun"); // a Monday holiday
    days[28] = day(28, 130, "wk+extra"); // a Monday with a fair
    const p = pickReferenceDays(days);
    // Monday: the latest ordinary Monday; Sunday: nothing runs
    expect(p).toEqual([35, 36, 37, 38, 39, 40, null]);
  });

  it("ties between service sets go to the trip count closest to the median, then the later day", () => {
    // one service per date (every set unique): Tuesdays with 50, 52, 10, 51 trips → the one closest to the median 50.5
    const days = [day(1, 50, "a"), day(8, 52, "b"), day(15, 10, "c"), day(22, 51, "d")];
    expect(pickReferenceDays(days)[1]).toBe(22);
    // two sets twice each (school weeks / holiday weeks): the busier set near the median, the later day
    expect(pickReferenceDays([day(2, 80, "s"), day(9, 40, "h"), day(16, 80, "s"), day(23, 40, "h")])[2]).toBe(23);
    // a weekday missing from a short window has no service
    expect(pickReferenceDays([day(0, 5, "x")]).slice(1)).toEqual([null, null, null, null, null, null]);
  });

  it("maps every build day to the reference day of its weekday", () => {
    // build from Monday 2026-10-19, days -1 (Sunday) … 8; Sunday has no service
    const picks = [35, 36, 37, 38, 39, 40, null];
    expect(projectionDays("2026-10-19", -1, 8, "2025-06-04", picks)).toEqual([
      [0, 35], [1, 36], [2, 37], [3, 38], [4, 39], [5, 40], [7, 35], [8, 36],
    ]);
  });

  it("a stale trip loses dedup against a current copy and adds no days to it", () => {
    const m = (bits: number[]) => Uint8Array.from(bits);
    const cur: DupTrip = { key: 1, cities: 3, duration: 100, priority: 0, mask: m([1, 0]) };
    const old: DupTrip = { key: 2, cities: 5, duration: 120, priority: 9, stale: true, mask: m([1, 1]) };
    expect(better(cur, old)).toBe(true);
    const r = resolveDuplicates([{ a: 1, b: 2, shared: 3 }], new Map([[1, cur], [2, { ...old }]]));
    expect([...r.dropped]).toEqual([2]);
    expect(r.extraMask.get(1)).toBeUndefined();
    // two stale copies merge as usual
    const r2 = resolveDuplicates([{ a: 1, b: 2, shared: 3 }], new Map([[1, { ...cur, stale: true }], [2, { ...old }]]));
    expect([...r2.dropped]).toEqual([1]);
    expect([...r2.extraMask.get(2)!]).toEqual([1, 1]);
  });

  it("the loader projects a stale feed's last pattern onto the build window and marks the feed", async () => {
    // weekday trains to 2025-07-15 (a Tuesday), a Saturday train, a holiday (2025-07-07, Monday) on Saturday service
    const z = await zipOf("stale", {
      "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\na,Rail,https://x.example,Europe/Madrid\n",
      "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\nr,a,R1,A - B,2\n",
      "trips.txt": "route_id,service_id,trip_id\nr,wk,t1\nr,wk,t2\nr,sat,t3\n",
      "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,40.0,-3.0\nB,Beta,40.5,-3.5\n",
      "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt1,08:00:00,08:00:00,A,1\nt1,09:00:00,09:00:00,B,2\nt2,10:00:00,10:00:00,B,1\nt2,11:00:00,11:00:00,A,2\nt3,12:00:00,12:00:00,A,1\nt3,13:00:00,13:00:00,B,2\n",
      "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nwk,1,1,1,1,1,0,0,20250101,20250715\nsat,0,0,0,0,0,1,0,20250101,20250715\n",
      "calendar_dates.txt": "service_id,date,exception_type\nwk,20250707,2\nsat,20250707,1\n",
    });
    const state = await zipState(z, "2026-10-18");
    expect(state).toMatchObject({ kind: "stale", end: "2025-07-15" });
    const cfg = { userAgent: "t", transitousBase: "", minBusKm: 15, dedicatedOperators: [], coachOperators: "^$", urbanAgencies: "", feeds: [] } as FeedsConfig;
    const rf: ResolvedFeed = { key: "xx-old", def: { id: "xx-old", country: "ES", name: "Old", tier: "core", keep: ["rail"], sources: [] }, urls: [] };
    const db = await Db.open(":memory:");
    try {
      await initSchema(db);
      const st = await loadFeed({ db, cfg, startDate: "2026-10-18", days: 14, tmpDir: dir, presentFeedIds: new Set(), dropBus: false }, 0, rf, z, { end: "2025-07-15", from: null });
      expect(st).toMatchObject({ trips: 3, expired: "2025-07-15" });
      expect(await db.all(`SELECT expired FROM feeds WHERE feed = 0`)).toEqual([{ expired: "2025-07-15" }]);
      // build days -1 … 14 from Sunday 2026-10-18: weekdays (Mon 19th …) run the weekday service – the holiday Monday
      // is outvoted – Saturdays the Saturday service, Sundays nothing
      const rows = await db.all<{ trip: string; days: string }>(`SELECT t.short_name AS trip, string_agg(sd.day::VARCHAR, ',' ORDER BY sd.day) AS days
        FROM trips t JOIN service_days sd USING (service_key) GROUP BY t.trip_key, t.short_name ORDER BY t.trip_key`);
      const wk = [1, 2, 3, 4, 5, 8, 9, 10, 11, 12].join(",");
      expect(rows.map((r) => r.days)).toEqual([wk, wk, "-1,6,13"]);
    } finally {
      db.close();
    }
  });
});
