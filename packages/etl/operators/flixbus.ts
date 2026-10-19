import { defineOperator } from "../src/operators/types.ts";

/**
 * FlixBus / FlixTrain: their own feeds are the only source of their coaches and trains.
 *
 * Source: feeds eu-flixbus (Transitous https://api.transitous.org/gtfs/eu_flixbus.gtfs.zip, fallback MDB
 * https://files.mobilitydatabase.org/tdg-11681/latest.zip = gtfs.gis.flix.tech/gtfs_generic_eu.zip), gb-flixbus
 * (gb_flixbus.gtfs.zip) and tr-flixbus (tr_flixbus.gtfs.zip).
 *
 * Shape (checked 2026-10-19): copies in other feeds, agency.txt rows –
 *   de-delfi       "13796,FlixTrain-de,https://www.delfi.de,Europe/Berlin,,"
 *   de-gtfsde-rv   "86,Flixtrain,https://www.bahn.de,Europe/Berlin,de"
 *   fi-fintraffic  "4070,FlixBus Estonia,https://www.flixbus.fi/,Europe/Helsinki,fi,"
 *   es-regional-bus~autobus-en-cantabria "573097,Flixbus,http:,Europe/Madrid,es,0"
 *
 * What it does: `exclusive` – routes of other feeds whose agency or route names match "flix" are skipped while one
 * of the FlixBus feeds is in the build (restrictions kept as hints).
 *
 * Known quirks: the EU origin URL answers 403 without a browser-like User-Agent (the Transitous copy is primary).
 * Fails on purpose: never at run time; the config check fails if one of the three feeds leaves feeds.json.
 * Re-check / update: grep the cached feeds' agency.txt / routes.txt for "flix"; coaches of partner operators sold
 * under the Flix brand keep their own operator name in national feeds and are not matched (that is intended).
 */
export default defineOperator({
  id: "flixbus",
  description: "FlixBus and FlixTrain services come from the FlixBus feeds only.",
  appliesTo: { feeds: ["eu-flixbus", "gb-flixbus", "tr-flixbus"] },
  exclusive: { pattern: "flix", feeds: ["eu-flixbus", "gb-flixbus", "tr-flixbus"] },
});
