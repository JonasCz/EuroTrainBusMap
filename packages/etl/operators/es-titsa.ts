import { defineOperator } from "../src/operators/types.ts";

/**
 * TITSA (Transportes Interurbanos de Tenerife): the island's intercity buses ("guaguas"), stop names.
 *
 * Source: feed es-titsa = Transitous https://api.transitous.org/gtfs/es_Autob%C3%BAs-interurbano-de-Tenerife.gtfs.zip
 * (NAP Spain data, TITSA; a feed of its own because of minBusKm 8 in feeds.json).
 *
 * Shape (checked 2026-10-20; 3,898 stops, 182 routes, 47,092 trips, calendar_dates only, 2026-10-13 – 2027-04-11):
 *   agency.txt  "2,TITSA,http://www.titsa.com,Atlantic/Canary,es,922 53 13 00"
 *   stops.txt   "ABAMA (T),8109,28.2,-16.8,http://www.titsa.com/correspondencias.php?idc=8109"
 *               "ARICO EL VIEJO (T)" next to "ARICO EL VIEJO" (same name, other stop id), "ADEJE (LAS TORRES) (T)",
 *               "ALDEA BLANCA  (T)" (double space), "AMBULATORIO  RAVELO" (double space), "HOSP. DEL SUR EL MOJÓN"
 *   About 450 stops end in " (T)": a TITSA marker that is not explained in the feed (probably "terminal"; the same
 *   name also exists without it as another stop id). All names are ALL CAPS, many with double spaces.
 *
 * What it does: `onLoad` – removes the trailing " (T)", collapses repeated spaces and title-cases the names
 * ("ARICO EL VIEJO (T)" → "Arico el Viejo", "ADEJE (LAS TORRES) (T)" → "Adeje (Las Torres)"), Spanish particles
 * (de, del, la, las, los, el, y, ...) stay lower case inside a name, via LoadApi.setStopNames. Only TITSA's stops.
 *
 * Known quirks: abbreviations ("HOSP.", "FCO.", "HDEZ.", "C. INSULAR") are kept as published. After the cleanup the
 * two stops of a "ARICO" pair share a name; they are different stop ids and stay separate stops.
 * Fails on purpose: never; a new marker simply stays in the name.
 * Re-check / update: `unzip -p work/cache/feeds/es-titsa.zip stops.txt | cut -d, -f1 | grep '(' | sort -u`
 * lists the names with a bracket. `operators.es-titsa` in the build report counts the changed names.
 */
const PARTICLES = new Set(["de", "del", "la", "las", "los", "el", "y", "e", "a", "al", "en", "con", "por", "lo"]);

/** "ADEJE (LAS TORRES) (T)" → "Adeje (Las Torres)". */
export function cleanTitsaStopName(raw: string): string {
  const n = raw.replace(/\s*\(T\)\s*$/i, "").replace(/\s+/g, " ").trim();
  if (!n || n !== n.toUpperCase()) return n || raw.trim();
  return n
    .toLowerCase()
    .split(" ")
    .map((w, i) =>
      w.replace(/^([("'\-/]*)(\p{L})(.*)$/u, (_m, pre: string, c: string, rest: string) =>
        i > 0 && !pre && PARTICLES.has(c + rest) ? pre + c + rest : pre + c.toUpperCase() + rest,
      ),
    )
    .join(" ");
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export default defineOperator({
  id: "es-titsa",
  description: "TITSA (Tenerife buses): the \"(T)\" marker and double spaces are removed from the ALL-CAPS stop names, which are title-cased.",
  appliesTo: { feeds: ["es-titsa"], agencies: [/^titsa$/i] },
  async onLoad(api) {
    const rows = await api.all<{ stop_id: string; name: string }>(`SELECT stop_id, name FROM t_stops_all WHERE name IS NOT NULL`);
    const changed = rows.filter((r) => cleanTitsaStopName(r.name) !== r.name);
    if (!changed.length) return;
    const values = changed.map((r) => `(${q(r.stop_id)}, ${q(cleanTitsaStopName(r.name))})`).join(", ");
    await api.setStopNames(`SELECT * FROM (VALUES ${values}) v(stop_id, name)`, 'TITSA "(T)" marker, spacing and ALL CAPS in stop names');
  },
});
