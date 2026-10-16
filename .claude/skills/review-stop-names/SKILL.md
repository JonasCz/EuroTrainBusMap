---
name: review-stop-names
description: Review coach and bus stop names (FlixBus, BlaBlaCar, other international coaches, stops named like a station next to a rail station) and record merges into stations or local-language display names in packages/etl/data/stop-names.json. Use after adding or changing feeds, when a new data build shows English or odd stop names ("Vienna Erdberg (Busterminal VIB)", "Prague Florenc Central Bus Station"), or when a coach stop at a station forecourt is listed as a separate station.
---

# Review stop names

Some feeds, mainly international coaches, name stops in English or in odd ways. Those stops are
then not merged with the station they belong to. The fix is a cached, reviewed mapping in
`packages/etl/data/stop-names.json`. The ETL applies it in the station-merge stage, in
`applyStopNames` (`packages/etl/src/core/stopnames.ts`):

```jsonc
{
  "version": 1,
  "meta": { "model": "claude-sonnet-…", "date": "2026-10-11", "reviewed": 5896 },   // file level only
  "entries": {
    "<key>": { "action": "merge", "station": "<target station name>", "near": [lon, lat] },
    "<key>": { "action": "rename", "name": "<display name>" },
    "<key>": { "action": "keep" }
  }
}
```

- **Keys.** The primary key is `<feed key>:<stop_id>`. A fallback key, `~<normalised name>@<x>,<y>`, places the stop on a ~50 m grid. Use the primary key unless the feed's stop ids are unstable (they change between releases). The candidate export prints both.
- **merge.** The stop joins the station whose name equals `station` (after normalising case, accents and punctuation) – or that contains a stop of that name – and that lies within 1.5 km of `near`, or of the stop if `near` is missing. If no such station exists, the ETL logs `stop-names: … not found` and changes nothing. It never fails. Stations are first merged by distance, name and terminal words (see "Stations" in the README), so many coach stops are already in their rail station when the mapping is applied; the log counts only the stops it actually moved.
- **rename.** Sets the display name of the stop's station. Stations with rail stops keep their rail name.
- **keep.** The stop has been reviewed and needs no change. Keys not in the file are left alone.

## When to run

- After adding feeds, or after a feed changes its stop ids or names.
- When the map or timetables show English, exonym or garbled stop names.
- When a coach stop sits next to a station but is listed separately.

## How

1. **Export the candidates.** This takes about 2 min and reuses the last build's DuckDB, with `--reuse-db` added automatically:
   ```sh
   pnpm --filter @etbm/etl run stops:candidates -- --out work/stop-candidates.jsonl --work work
   ```
   Each line describes one stop that is not yet in `entries`: `key`, `altKey`, `feed`, `stopId`, `name`, `operator`, `cats`, `weight` (stop events), `lon`/`lat`, `city`, `country`, `station` (its current station), `nearby` (the five nearest other stations within 1.5 km, with `name`, `distM`, `cats` and `rail`) and `reason`. The reasons are:
   - `intl-coach`: every stop of an international coach feed.
   - `foreign-name`: an English or exonym name outside GB/IE/MT/CY.
   - `near-rail`: the name looks like a station and the stop is within 300 m of a rail station.
2. **Split into batches** of about 150 lines, for example `split -l 150 work/stop-candidates.jsonl work/stop-batch-`.
3. **Review each batch with a Sonnet subagent.** Give it the batch and the decision rules below, verbatim. Ask for one JSON object per input line: `{"key": "<key>", "action": …, …}` with the `merge`/`rename`/`keep` fields. Run several batches in parallel.
4. **Merge the results** into `packages/etl/data/stop-names.json` under `entries`, keyed by `key`. Do not overwrite entries that already exist unless you are deliberately re-reviewing them. Update `meta` (model, date, count). Sort the keys so diffs stay readable.
5. **Rebuild:**
   ```sh
   pnpm --filter @etbm/etl run build-data -- --out work/out --work work --reuse-db
   ```
   Check the `stop-names:` log line (merges, renames, targets not found). For each `not found`, look at the target name in the candidate's `nearby` list and fix the entry.
6. **Spot-check.** Re-export the candidates; the reviewed ones should be gone. In the app, open a few cities (Wien, Praha, Budapest, München, Milano, Paris, İstanbul) and look at their station lists and the timetables of coach departures.

## Decision rules (give these verbatim to the reviewer)

You decide, for each coach or bus stop, whether it is the same place as an existing station or needs a better display name. Use only the information in the line (name, city, country, operator, coordinates, nearby stations). **Never invent places, stations or names that are not supported by the stop name or the nearby list.**

1. **merge.** Only if the stop is the same physical place as one of the `nearby` stations:
   - it is within about 400 m of it (`distM` ≤ 400), **and**
   - its name refers to that station or its forecourt, bus bay or bus station at the same site. Examples: "Vienna Hauptbahnhof (Bus)" → "Wien Hbf"; "Prague Florenc Central Bus Station" → "Praha,ÚAN Florenc"; "Bucharest Airport Henri Coanda (Otopeni Departures)" → "Aeroport H. Coanda T1" when within 400 m; "Delitzsch, Unterer Bahnhof (Bus)" → "Delitzsch unt Bf".

   Output `{"action": "merge", "station": "<exact name from nearby>", "near": [lon, lat of the stop]}`. Copy the station name exactly as it appears in `nearby`. Prefer the rail station when the name says "Hbf", "station", "gare" or similar. Do not merge into a nearby station that merely has a similar street name, and do not merge two different terminals.
2. **rename.** If the stop is not merged but its name is English, an exonym, or garbled, give its local-language name:
   - Prefix the name with the city's local-language name, like the rail stations in the data ("Berlin Hbf", "Praha hl.n."); the frontend strips the prefix at station zoom. In Wien, "Vienna Erdberg (Busterminal VIB)" becomes "Wien Erdberg (VIB)"; "Prague Florenc Central Bus Station" becomes "Praha ÚAN Florenc". If the stop lies in a different place than the exonym suggests (e.g. "Salzburg South" in Elsbethen), use the actual place or the well-known local name.
   - Keep the terminal qualifier short, in the local language or as the local abbreviation: "ÚAN Florenc", "Népliget (autóbusz-pályaudvar)" can be "Népliget", "ZOB", "Autogara", "Otogar", "Busterminal".
   - Use the local spelling with diacritics ("Kraków MDA", "Milano Lampugnano", "Torino Corso Vittorio Emanuele II").
   - Keep platform, bay and stand numbers out.
   - Examples:
     - "Budapest Népliget bus station" in Budapest → "Népliget".
     - "Salzburg South (Hellbrunner Landesstraße)" in Elsbethen → "Salzburg Süd (Hellbrunner Landesstraße)".
     - "BICI COM Vienna" → keep (use rename only if you are sure what the place is called locally).
3. **keep.** The name is already local and fine, or you are not sure.
4. Output one result per input line, keyed by `key`, with no extra commentary.

## Notes

- Raw ids and prefixes some feeds leave in names ("ROMA | Anagnina (Metro A) # f3583") are removed by `sanitizeName` (`core/names.ts`) before names are compared or shown, so write targets and renames without them ("Roma Anagnina (Metro A)"); old entries that still carry them keep working.
- The mapping is applied deterministically and cheaply on every build. Unknown keys mean no change, so new stops simply wait for the next review.
- Unit tests: `packages/etl/test/stopnames.test.ts`.
- Candidate selection lives in `packages/etl/src/stopnames-io.ts`. If too many or too few lines come out, adjust the feed pattern (`INTL_COACH_FEED`), `FOREIGN_NAME_RE` or `STATIONISH_RE`.
