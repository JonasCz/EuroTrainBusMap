import { defineOperator } from "../src/operators/types.ts";

/**
 * ŽRS (Željeznice Republike Srpske): trains of Republika Srpska, Bosnia and Herzegovina, read from the community feed
 * that also has the FBiH trains – only the ŽRS part is kept; the FBiH trains come from the generated feed ba-zfbih.
 *
 * Source: feed ba-zrs = Transitous https://api.transitous.org/gtfs/ba_ZFBiH.gtfs.zip (unofficial, Petr Novak; no other
 * source of the ŽRS timetable exists, the operator publishes no GTFS).
 *
 * Shape (checked 2026-10-19; file of Aug 2025):
 *   agency.txt     "FBH,Željeznice FBiH d.o.o.,https://www.zfbh.ba/,Europe/Sarajevo"
 *                  "RSR,Željeznice RSrp d.o.o.,https://www.zrs-rs.com/,Europe/Sarajevo"
 *   routes.txt     "Banja Luka – Doboj,P 6401,RSR,2,6401" (27 RSR routes: Banja Luka – Doboj / Dobrljin / Novi Grad,
 *                  Doboj – Petrovo Novo, Novi Grad – Dobrljin)
 *   trips.txt      "6401,AL,Doboj,BLDo,6401,1"
 *   calendar.txt   "1,1,1,1,1,1,1,20250101,20251213,AL", "1,1,1,1,1,0,0,20250101,20251213,WD" (…)
 *   feed_info.txt  "Petr Novak,https://www.zfbh.ba/,en,20250101,20251213,1.0,novakp@wo.cz"
 *
 * What it does: feed option `onlyAgencies` – only the routes of the ŽRS agency ("Željeznice RSrp d.o.o.") are loaded.
 *
 * Known quirks: the service ended on 2025-12-13 (the December 2025 timetable change). The build keeps the feed as
 * stale within feeds.json `staleMaxDays` (src/gtfs/validity.ts: its last six weeks repeated, every train labelled
 * "Timetables out of date — expired 13 Dec 2025"); after that it is skipped with a warning.
 * Fails on purpose: never; when the agency name changes the feed loads no routes ("no routes kept" in the build log).
 * Re-check / update: `unzip -p work/cache/feeds/ba-zrs.zip agency.txt feed_info.txt`. When the file is refreshed
 * (feed_info end date after the build) the label goes by itself; when it splits into a ŽRS-only file, point ba-zrs at
 * it and remove this adapter.
 */
export default defineOperator({
  id: "zrs",
  description: "ŽRS (Republika Srpska rail): only the ŽRS agency of the community feed ba_ZFBiH is kept (the FBiH trains come from ba-zfbih).",
  appliesTo: { feeds: ["ba-zrs"] },
  feedOptions: { onlyAgencies: "RSrp|Republike Srpske" },
});
