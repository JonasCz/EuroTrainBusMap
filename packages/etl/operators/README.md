# Operator adapters

The main pipeline (`src/`) holds only generic rules: GTFS semantics, multilingual keyword lists
(`data/classify-keywords.json`: train categories, brands, rail-replacement wording) and per-feed knobs in
`feeds.json` (`railCat`, `priority`, `allCoach`, …). A fix or an addition that exists because **one operator's or
one feed's data** is different goes into an adapter here: one file per operator (or a small group of operators that
share one quirk), applied at fixed points of every build.

| file | scope | what it does |
| --- | --- | --- |
| `blablacar.ts` | eu-blablacar-bus | BlaBlaCar Bus only from its own feed (`exclusive`) |
| `entur.ts` | no-entur | rail trips calling only at bus stops (`stops.txt` `vehicle_type`) are replacement buses: dropped (`onLoad`) |
| `european-sleeper.ts` | eu-european-sleeper | European Sleeper only from its own feed (`exclusive`) |
| `eurostar.ts` | agency Eurostar | Eurostar / Thalys only from the Eurostar feed (`exclusive`); its routes are high speed (`route`) |
| `flixbus.ts` | eu/gb/tr-flixbus | FlixBus / FlixTrain only from their own feeds (`exclusive`) |
| `gb-mixed-rail.ts` | country GB | GWR / EMR / ScotRail / TfW routes: category per trip (`classify.after`) |
| `hu-volanbusz.ts` | hu-volanbusz | route_type 200 on nearly every line: coach types count as buses (`feedOptions.coachTypesAsBus`) |
| `livnobus.ts` | ba-livnobus | Li-Bus Livno only from its own feed (`exclusive`; the redvoznje.ba boards list it too) |
| `ma-oncf.ts` | ma-oncf, agency Supratours | "(suprat.)" marker removed from trip headsigns (`onLoad`, `setHeadsigns`) |
| `es-titsa.ts` | es-titsa, agency TITSA | "(T)" marker and ALL CAPS removed from stop names (`onLoad`, `setStopNames`) |
| `se-train-operators.ts` | se-trafiklab, train operators' agencies | their bus routes are replacement buses: dropped (`classify.after`) |
| `sncf.ts` | fr-sncf-national | feed options (category from trip_id, number in headsign, category names); CTE / CRE trips on rail routes are buses, CRE reservation only (`classify.before`) |
| `trenitalia.ts` | agency Trenitalia | end-station-named long-distance trains: brand "Frecciarossa", high speed (`route`) |
| `zrs.ts` | ba-zrs | only the ŽRS (Republika Srpska) trains of the community feed ba_ZFBiH are kept (`feedOptions.onlyAgencies`; the FBiH trains come from the generated ba-zfbih) |
| `zou.ts` | fr-paca-zou-intermetropole | adds the Transdev ZOU! regional-train feed after fr-transilien (`extraFeeds`) |

## The header comment (required)

Every adapter starts with a doc comment so that another agent can re-check it against the current data and repair or
remove it. Sections, in this order (see any adapter, e.g. `sncf.ts`):

- **Source** – the feed id(s) and their URLs (Transitous file, Mobility Database id, origin).
- **Shape** – what the data looks like *today*, with rows copied from the live feed and the date checked
  (`agency.txt`, `routes.txt`, `trips.txt` lines; copies of the operator in other feeds).
- **What it does** – which parts / hooks and their effect.
- **Known quirks** – anything else odd about the data the adapter deals with or deliberately leaves alone.
- **Fails on purpose** – what makes it fail (config checks, conflicts) or, for most adapters, "never: it just stops
  matching" and how you would notice (counts in the build report's `operators`).
- **Re-check / update** – the commands (`unzip -p work/cache/feeds/<feed>.zip …`) that show whether the quirk is still
  there, what to change when the data changed, and when the adapter can go.

Keep the copied rows current when you change the adapter.

## Writing one

Copy `_template.ts` to `<id>.ts` (lower case, digits, `-`; the `id` inside must equal the file name) and fill in
what you need. Every file in this directory except `_*.ts`, `*.test.ts` and this README is loaded
(`src/operators/registry.ts`), in id order. Add a test to `test/operators.test.ts` (see the existing ones: classify a
route of the feed with the adapter's hooks, or call `routeExtras`).

```ts
export default defineOperator({
  id: "my-operator",
  description: "What the data does differently and what the adapter does.",
  appliesTo: { feeds: ["xx-feed"], countries: ["XX"], agencies: [/^My Operator$/i] },
  feedOptions: { ... },                     // merged into the options of appliesTo.feeds
  extraFeeds: [{ after: "xx-other", def }], // feeds this adapter adds, at a fixed place in the feed order
  exclusive: { pattern: "my operator", feeds: ["xx-feed"] }, // the operator's own feed is its only source
  classify: { before(r, mode, feed) {...}, after(r, cl, feed) {...} },
  async onLoad(api) {...},
  route(r) {...},
});
```

### Scope (`appliesTo`)

A route is in an adapter's scope when its feed is one of `feeds` or of a country in `countries` (neither given: any
feed) **and**, if `agencies` is given, its agency name (agency.txt) matches one of them. An adapter must name at least
one of the three; a rule for every feed is a generic rule and belongs in `src/`. Hooks are only called for rows in
scope: `classify` per (route, trip category) of the feeds in scope, `onLoad` once per feed in scope with writes
limited to the trips of in-scope routes, `route` per route in scope. `feedOptions` need `appliesTo.feeds` only.

### Pipeline points

| part | when | sees / may change |
| --- | --- | --- |
| `extraFeeds`, `feedOptions`, `exclusive` | when `feeds.json` is loaded (`loadFeedsConfig`), before anything else, for every stage (load, urban, transit) | the in-memory config only; `feeds.json` is never written |
| `classify.before(r, mode, feed)` | load, per route and trip category, before the generic rules of `src/core/classify.ts` | return `{ mode?, flags? }` to force the mode class (a coach category on a rail route) and add `Flag` bits; `undefined` = no opinion |
| `classify.after(r, cl, feed)` | load, after the generic rules, before the feed's `railCatDefault` | return a new `Classification`, `null` to drop the route, `undefined` to keep it |
| `onLoad(api)` | load, after the feed's stop_times and stops are read, before the short-bus filter | read-only `api.all` / `api.scalar` over the feed's temp tables (`t_kt`, `t_st`, `t_stops_all`, `t_trips`, `t_routes`; see `src/operators/types.ts`), `api.columns(file)`, `api.dropTrips(selectTripKeys, reason)`, `api.setHeadsigns(selectTripKeyHeadsign, reason)`, `api.setStopNames(selectStopIdName, reason)` |
| `route(r)` | build, when the route of a trip is created (`build.ts`) | return `{ brand?, highSpeed? }`: `Route.brand` for a route named only by its end stations, high-speed service for rail geometry |

`exclusive`: routes of other feeds whose agency, route short or long name matches `pattern` (case-insensitive) are
skipped when one of `feeds` is in the build; their boarding / alighting restrictions are kept as hints for the
operator's own trips (`limit_hints`, see the main README, step 5).

### Re-runnable, no clobbering

- Adapters never change their inputs: the GTFS zips and `feeds.json` stay as they are, every change is made again
  from them on every build (load hooks on the per-feed temp tables, build hooks in memory).
- **One source per value.** A feed option set by `feeds.json` and an adapter, or by two adapters, an extra feed that
  already exists, two `exclusive` claims on one feed, or two adapters with the same hook on the same whole feed (at
  least one of them without an `agencies` filter) fail when the config is loaded. When both have agency filters, the
  overlap depends on the data: two adapters returning a value for the same field of the same row (route
  classification, `route.brand`, `route.highSpeed`, the routes of an `onLoad`) fail the build with both ids named.
- **Order.** Adapters run sorted by id; since no two may decide the same value, the order never changes a result.
- **Records.** Every change is counted per adapter, feed and field: logged at the end of the build
  (`operator sncf: classify.before@fr-sncf-national 286, …`), written to `work/build-report.json` (`operators`) and,
  for the load-time ones, to the DuckDB table `operator_log` (so `--reuse-db` runs still report them).
- **--reuse-db.** The source text of every adapter with a load-time part (`feedOptions`, `extraFeeds`, `exclusive`,
  `classify`, `onLoad`) is part of the database key in `work/db-state.json`: changing such an adapter reloads the
  feeds; an adapter with only a `route` hook can be changed without reloading.
