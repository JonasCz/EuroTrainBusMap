# Data sources (research notes, Oct 2026)

Draft feed manifest: [`data/feeds.draft.json`](../data/feeds.draft.json). It lists 78 entries and about 4.9 GB of zips if every optional bus tier is included. Rail plus coach on their own come to about 1.5 GB.

## 1. Mirrors: where to download feeds from

### Transitous processed-feed mirror (main source)
- **`https://api.transitous.org/gtfs/`** is a public nginx autoindex of every feed that Transitous imports. It holds 2,337 `*.gtfs.zip` files plus a few `.netex.zip` files, and it is refreshed nightly. Files are named `<cc>_<source-name>.gtfs.zip`, following `feeds/<cc>.json` in the public-transport/transitous repo. The Transitous docs link to it under "Diagnostics → processed feeds".
- **`https://api.transitous.org/gtfs/license.json`** has one entry per file with country, operators, `source` (the original URL), `spdx_license_identifier`, publisher, contacts and `last_updated`. We can generate our attribution page from it.
- The mirrored files are post-processed by Transitous (fixes, `gtfsclean`, often **shapes dropped**). Because of this they are smaller than the originals: Sweden is 44 MB instead of 821 MB, and FlixBus is 2 MB instead of 30 MB.
- Feeds whose origin needs an **API key are mirrored decrypted**. Transitous keeps the keys as `AGE-ENCRYPTED` values in its repo, and 36 European sources use this, including Trenitalia, TEC, De Lijn, TFI, VBB, Swiss 2026 and BKK. The mirror is the only key-free source for Trenitalia, AT rail, De Lijn and TEC.
- HTTP Range requests work. Requests with the Python-urllib default User-Agent get a 403, so send a custom UA.
- This is a community server. Download once a week, set a descriptive UA, and ideally ask in `#transitous:matrix.spline.de` before depending on it. Filenames with a year in them (`*-2026`, `ch_…26/27`) change at the December timetable switch, so resolve them from the index or `license.json` rather than hard-coding.
- No GitHub release or merged GTFS exists. MOTIS imports the feeds individually. `/gtfs/data/` holds only MOTIS internal binaries (for example an 18 GB routed-shapes cache), which we cannot use.

### Transitous `feeds/<cc>.json` schema
- Source `type` values: `http` (direct URL), `transitland-atlas` (`transitland-atlas-id`), `mobility-database` (`mdb-id`), and `url` (realtime feeds only). One feed uses `ftp`.
- Other keys: `spec` (gtfs / gtfs-rt / netex / siri…), `license.spdx-identifier`, `fix`, `skip` + `skip-reason`, `drop-shapes`, `drop-agency-names`, `extend-calendar`, `use-gtfsclean`, `headers`, `http-options`, `url-override`, `script`, and `x-data-gov-fr-*` (FR auto-generated, `managed-by-script`).
- Across 43 European country files there are 2,184 sources. Static and not skipped, they split as: http 818, transitland-atlas 207, mobility-database 155, keyed (encrypted URL or header) 13, ftp 1. A further 179 are skipped.

### Mobility Database (`files.mobilitydatabase.org/<id>/latest.zip`)
- Keeps the original files, shapes included. It **also mirrors keyed feeds**: Sweden 3 `mdb-2939` (821 MB) and DELFI `mdb-3215` (530 MB) need no key here.
- Some copies are stale. CH `mdb-2898` dates from May 2026 and CZ JDF `mdb-2904` from Nov 2025.
- Trenitalia and the AT rail reference data have no usable MDB copy.

## 2. Key operators (checked with remote-zip reads of routes.txt)

| Area | Best source | Size | Route types |
|---|---|---|---|
| FlixBus EU | MDB `tdg-11681` (= `gtfs.gis.flix.tech/gtfs_generic_eu.zip`, which needs a browser UA) | 30 MB | 3 (1142), 2 (3) |
| FlixBus GB / TR | Transitous `gb_flixbus` / `tr_flixbus` | 2 / 9 MB | 3 |
| BlaBlaCar Bus | MDB `tdg-52605` | 0.3 MB | 3 |
| DE long-distance / regional rail | gtfs.de via MDB `mdb-768` / `mdb-1089` | 0.4 / 11 MB | 2 |
| DE buses | DELFI (Transitous 328 MB, or MDB 530 MB) | | 3, 700, 715… |
| CH | Transitous `ch_opentransportdataswiss26` | 270 MB | 100–117, 700, 1000… |
| GB | Transitous `gb_great-britain` (aubin.app: NR + BODS) | 562 MB, stop_times 5.2 GB raw | 2, 3, 200 |
| IT Trenitalia | Transitous only | 22 MB | 2 (2.7k), 3 |
| ES Renfe LD/AVE, Cercanías | Transitous (from NAP) | 0.6 / 9 MB | 2 |
| PL PKP IC / regional | Transitous `pl_PKP-Intercity`, `pl_Polish-Trains` | 126 (mostly shapes) / 4 MB | 2; 106/103 |
| CZ | Transitous `cz_CZPTT` (rail), `cz_JDF-merged` (bus) | 8 / 17 MB | 106/103/102; 701/704/202 |
| TR TCDD | Transitous (community, MIT) | 0.05 MB | 101/102/106 |
| UA UZ | Transitous (unofficial) | 6 MB | 102/106 |
| SE | Transitous `se_Trafiklab` (origin keyed) | 44 MB | 700, 106, 102, 101 |

- **NeTEx-only or no GTFS:** Portugal coaches (Rede Expressos) and the Greek KTEL coaches have no GTFS. Turkish coaches exist only as FlixBus TR. Italy has no national bus aggregate. Italo and DB/ÖBB Nightjet do not publish their own feeds, but their trains are covered inside gtfs.de, AT rail and CH.
- **API key only at the origin, but mirrored:** SE Trafiklab, BE TEC / De Lijn, IT Trenitalia, IE TFI, AT mobilitaetsverbuende (registration), DE DELFI (registration). Every one of these has a key-free mirror.

## 3. Filtering city transit out
Aggregates such as DELFI, NL, CH, NO, SE, DK, the FR regional sets, AT PTA and TFI include city buses and trams. Planned filter:
- Drop route_type 0/1/5/6/7/11/12, 400–899 and 900–1799 (tram, metro, ferry, cable).
- Keep rail types 2 and 100–117 (drop 109 suburban as an optional layer).
- For buses (3, 700–716, 200–209), keep only routes whose trips span at least about 15 km between first and last stop and that serve at least 2 distinct municipalities. A cheap version is the stop bbox diagonal, or `route_type` 200/701/702 where those types are used.

## 4. Rail geometry

| Option | Verdict |
|---|---|
| (a) Overture `theme=transportation/type=segment`, `subtype='rail'`, release `2026-09-23.1` (`s3://overturemaps-us-west-2/release/2026-09-23.1/…`, 128 files, 72 GB worldwide). DuckDB with a bbox filter. | **Recommended.** Measured: Switzerland bbox took 73 s on first run and returned 41k rail segments / 18.9k km. **Europe bbox (-25,34,45,72), classes standard/narrow/unknown gauge: 888k segments, 220 MB zstd GeoParquet, 13 min** (DuckDB 1.5, 8 threads, through a proxy; it streams the needed row groups and writes nothing big to disk). Note: with `AWS_*` env vars set, DuckDB sends them and gets a 403; unset them for anonymous access. No disk pressure, already split into segments with `class` (standard/narrow gauge, tram, subway…). License: ODbL (OSM-derived). |
| (b) Geofabrik `europe-latest.osm.pbf` (~31 GB) + `osmium tags-filter w/railway=rail` | Does not fit the 14 GB of free disk unless the runner is cleaned up or countries are streamed one at a time. Two-plus hours of download and filtering. Usable fallback if done per-country. |
| (c) pfaedle map-matching (`pfaedle -x rail.osm.pbf feed.zip`, mots rail) | Good for real per-trip shapes. Needs an OSM rail extract (from (a) or (b)) and takes minutes to tens of minutes per big feed. Possible later, after (a)/(b). |
| (d) shapes.txt in the feeds | Mixed. Present: PKP IC, Trenitalia, Irish Rail, FI VR, UZ, RO, HR, SI, LV, Entur, NL. Missing: gtfs.de FV/RV, SNCF, SNCB, CH, AT rail, CZ, SK, ES LD, HU MÁV, GB (Transitous copies are often stripped). |

**Recommendation:** extract Overture rail segments for the Europe bbox once per run (or cache by release) into a GeoParquet or FlatGeobuf file of a few hundred MB. Build a rail graph from it. For each consecutive stop pair in the timetable, snap to the graph and take a shortest path (our own lightweight map-matching). Use the feed's `shapes.txt` where it exists, and fall back to a straight line where routing fails.

## 5. Canary Islands and Morocco (checked 19 Oct 2026)

The map's coverage (`packages/shared/src/coverage.ts`) includes the Canary Islands, Madeira and Morocco with Western
Sahara. Feeds checked (downloaded, calendars read):

| Feed | Source | Valid | Used |
|---|---|---|---|
| ONCF rail (Al Boraq, Al Atlas, TNR, Al Bidaoui) + Supratours coaches | Transitous `ma_oncf` (unofficial, scraped from oncf-voyages.ma, ODbL) | 2026-08-18 – 2028-08-18 (one week repeated; Fridays nearly empty) | `ma-oncf` (rail + coach) |
| TITSA (Tenerife buses) | Transitous `es_Autobús-interurbano-de-Tenerife` (NAP) = `es_Transportes-interurbanos-de-Tenerife-(TITSA)` | calendar_dates 2026-10-13 – 2027-04-11 | already matched by `es-regional-bus`; was dropped by the old bbox |
| Guaguas Municipales (Las Palmas city bus) | Transitous `es_Guaguas-Municipales` (MDB `tld-767`) | 2015 – 2035 | local layer (`urban-feeds.json`) |
| Metrotenerife (tram) | Transitous `es_Metrotenerife` = operator URL | ended 2025-07-15 | no: removed from `urban-feeds.json` (out of date) |
| Casablanca tramway T1–T4, busway BW1/BW2 | MDB `mdb-3462` (unofficial) | feed_info 2026-05-31 – 06-30, only Sunday / holiday dates after that | no: removed (out of date) |
| TILP (La Palma buses) | Transitous `es_Trasnportes-Insular-de-La-Palma-(TILP)` | ended 2025-12-25 | no (stale) |
| ONCF (other unofficial feed) | MDB `mdb-3049` | ended 2025-12-31, 60 trips | no (stale, superseded) |
| Casabus (Casablanca city bus) | MDB `mdb-3463` | ended 2026-06-29 | no (stale) |
| Vitalis Tétouan city bus | MDB `mdb-1816` | ended 2021-11-30 | no (stale) |
| Fred. Olsen Express (inter-island ferries) | Transitous `es_Ferry-Fred.Olsen` (NAP) | 2026-10-17 – 2027-05-30 | no: ferries are not a mode of the pipeline |
| Baleària (incl. Algeciras – Tanger Med / Ceuta, Huelva – Gran Canaria / Tenerife) | Transitous `es_Ferry-Baleària` | service dates end 2025-03-31 | no: ferry, and stale |

No GTFS found (Transitous, Mobility Database): Global (Gran Canaria interurban), Lanzarote / Fuerteventura buses,
CTM coaches, Rabat–Salé tram, Naviera Armas, FRS Tarifa – Tanger. Madeira (`pt_Funchal`, valid to 2026-11-30) is inside
the coverage now but not added.

## 6. Generated feeds: Bosnia and Herzegovina (checked 19 Oct 2026)

No current GTFS exists for the railways of Bosnia and Herzegovina. Transitous' `ba_ZFBiH` (unofficial, by Petr Novak;
ŽFBiH and ŽRS trains) was last updated in August 2025 and its service ended on 2025-12-13. ŽFBiH publishes its
timetable only as a web page, so the feed `ba-zfbih` is **generated** from it on every build
(`packages/etl/generators/ba-zfbih.ts`, see the README there):

| Part of <https://www.zfbh.ba/en/time-table/> | Use |
|---|---|
| Heading "ŽFBH Timetable for 2025/2026" | must name the current annual timetable (else the source fails); service is generated up to the December timetable change |
| Table "Train number \| Train type \| Relation \| Departure \| Arrival" (39 trains: Sarajevo – Mostar – Čapljina (– Ploče), Sarajevo – Zenica – Maglaj, Sarajevo – Visoko, Sarajevo – Pazarić, Zenica – Maglaj) | one trip per train; "Fast train" → route type 103 (long distance), "Local train" → 106 (regional) |
| "Note:" footnotes keyed by asterisks (`*` … `*******`) | exact texts mapped to hard-coded calendar rules; weekday trains skip the FBiH public holidays (1–2 Jan, 1 Mar, 1–2 May, 25 Nov) |
| Station form (POST `redvoznje_pol` / `redvoznje_dol`, 54 stations) | the trains between two stations with their times there: queried for Sarajevo and Maglaj with every other station (106 requests, ~4 s each, two at a time: ~4 min), giving every train's intermediate stops |

Findings: the station form also lists two old train numbers not in the table (2172, 2173 of the 2025 timetable;
ignored) and not the Ploče trains. The footnotes date the Ploče trains (390–393 until 25.06., 1390 / 1391 26.06. –
27.09.2026) in the past, so none of them runs in an October – December window; HŽPP's feed (`hr-hz`) has 390 – 393
between Ploče and Metković on Fridays to Sundays until December 2026, so their Croatian part is still on the map.
Station coordinates come from the stops of the 2025 community feed (they lie on the OSM track of the rail graph within
25 m) plus Briješće (estimated); Ploče as in the HŽPP feed. The Transitous file `ba_ZFBiH` itself is out of date and no
longer in `feeds.json` (the ŽRS trains of Republika Srpska, Banja Luka – Doboj …, have no current source).

## 7. Feed audit (19 Oct 2026)

Every feed of `feeds.json` and `urban-feeds.json` was checked against its downloaded zip (last service day from
calendar / calendar_dates, `feed_info` dates, services active in the next 60 days). Removed as out of date:

| Feed | Evidence |
|---|---|
| `ba-zrs` (Transitous `ba_ZFBiH`, ŽRS only) | last service 2025-12-13 (file of Aug 2025) |
| `es-feve` (Transitous `es_Feve`) | last service 2026-05-13 (file of 15 Apr 2026), 0 trips in the window |
| `es-regional-bus` file `Autobús-interurbano-de-Navarra` (regex) | last service 2025-12-31 (file of Nov 2025) |
| `it-regional-bus` files `liguria-riviera-transporti`, `Lombardia-Movibus` (regex) | summer timetable ended 2026-09-13; ended 2025-03-30 |
| `u-es-metro-de-madrid` | last service 2026-05-27 (file of May 2025) |
| `u-es-metrotenerife` | last service 2025-07-15 |
| `u-es-transporte-urbano-de-zaragoza` | feed_info ends 2026-10-05; after it one stray service a day (27,161 dates before vs 1 per day after) |
| `u-ma-casatramway` | feed_info 2026-05-31 – 06-30; only Sunday / holiday dates after that |
| `u-pt-porto-stcp` | last service 2026-10-06 (file of 10 Sep 2026) |
| `u-gr-athens-bus`, `u-gr-athens-rail` | last service 2026-10-06 / 2026-08-31 (files of 8 Jul 2026) |

Kept although close to their end: `u-it-lombardia-atm` (last service 2026-10-19, refreshed monthly upstream),
`ba-centrotrans` (2026-11-05). The build's validity check (`packages/etl/src/gtfs/validity.ts`) skips such a feed with a
warning as soon as its service has ended, so they need no manual step.
