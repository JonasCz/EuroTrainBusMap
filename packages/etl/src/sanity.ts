import type { CalendarsFile, CityFile, NetworkFile } from "@etbm/shared";
import { getBit, maskFromBase64, weekday } from "./core/calendar.ts";
import { isoToEpochDay } from "./core/time.ts";

export interface SanityInput {
  network: NetworkFile;
  calendars: CalendarsFile;
  readCity: (id: number) => CityFile | null;
}

export interface SanityResult {
  errors: string[];
  warnings: string[];
  checks: Record<string, string | number | boolean>;
}

function findCity(n: NetworkFile, names: string[], country?: string) {
  const lc = names.map((s) => s.toLowerCase());
  const cands = n.cities.filter((c) => lc.includes(c.name.toLowerCase()) && (!country || c.country === country));
  return cands.sort((a, b) => b.importance - a.importance)[0];
}

/** Next Tuesday–Thursday day index in the horizon (a regular weekday). */
function weekdayIndex(cal: CalendarsFile): number {
  const s = isoToEpochDay(cal.startDate);
  for (let i = 7; i < cal.days; i++) if ([1, 2].includes(weekday(s + i))) return i;
  return 0;
}

/** Number of direct trips from city a to city b on day index `day`. */
export function countDirect(cf: CityFile, n: NetworkFile, cal: CalendarsFile, b: number, day: number): number {
  const masks = new Map<number, Uint8Array>();
  let cnt = 0;
  for (const t of cf.trips) {
    const p = cf.patterns[t[0]]!;
    const ia = p.stations.findIndex((s) => n.stations[s]?.city === cf.city);
    if (ia < 0) continue;
    const ib = p.stations.findIndex((s, i) => i > ia && n.stations[s]?.city === b);
    if (ib < 0) continue;
    let m = masks.get(t[2]);
    if (!m) masks.set(t[2], (m = maskFromBase64(cal.masks[t[2]]!)));
    if (getBit(m, day)) cnt++;
  }
  return cnt;
}

export function runSanity(inp: SanityInput): SanityResult {
  const { network: n, calendars: cal } = inp;
  const errors: string[] = [];
  const warnings: string[] = [];
  const checks: SanityResult["checks"] = {};

  // ---- structural
  n.cities.forEach((c, i) => {
    if (c.id !== i) errors.push(`city id mismatch at ${i}`);
    if (c.tz < 0 || c.tz >= n.timezones.length) errors.push(`city ${i} bad tz`);
    for (const s of c.stations) if (n.stations[s]?.city !== i) errors.push(`city ${i} lists station ${s} of another city`);
  });
  n.stations.forEach((s, i) => {
    if (s.id !== i) errors.push(`station id mismatch at ${i}`);
    if (!n.cities[s.city]) errors.push(`station ${i} bad city`);
  });
  n.corridors.forEach((c, i) => {
    if (c.id !== i) errors.push(`corridor id mismatch ${i}`);
    if (!n.stations[c.a] || !n.stations[c.b]) errors.push(`corridor ${i} bad station`);
    else if (c.a === c.b) errors.push(`corridor ${i} joins a station to itself`);
    if (c.coords.length < 2) errors.push(`corridor ${i} has < 2 coords`);
  });
  if (n.segments) {
    n.corridors.forEach((c, i) => {
      for (const code of c.segs ?? []) if (!n.segments![code >= 0 ? code : -code - 1]) errors.push(`corridor ${i} bad segment ${code}`);
      if (c.segs && !c.segs.length) errors.push(`corridor ${i} has no segments`);
    });
    checks.segments = n.segments.length;
  }
  const sampleIds = [...new Set([0, 1, 2, 3, 4, 5, Math.floor(n.cities.length / 2), n.cities.length - 1].filter((x) => x >= 0 && x < n.cities.length))];
  for (const id of sampleIds) {
    const cf = inp.readCity(id);
    if (!cf) {
      errors.push(`city file ${id} missing`);
      continue;
    }
    cf.patterns.forEach((p, pi) => {
      if (!cf.routes[p.route]) errors.push(`city ${id} pattern ${pi} bad route`);
      if (p.arr.length !== p.stations.length || p.dep.length !== p.stations.length) errors.push(`city ${id} pattern ${pi} array lengths`);
      if (p.corridors.length !== p.stations.length - 1) errors.push(`city ${id} pattern ${pi} corridors ${p.corridors.length} != stops - 1 (${p.stations.length - 1})`);
      p.corridors.forEach((c, k) => {
        const cr = n.corridors[c];
        if (c === -1) return; // a hop that never runs in the horizon
        if (!cr) errors.push(`city ${id} pattern ${pi} bad corridor ${c}`);
        else if (!((cr.a === p.stations[k] && cr.b === p.stations[k + 1]) || (cr.b === p.stations[k] && cr.a === p.stations[k + 1]))) errors.push(`city ${id} pattern ${pi} corridor ${c} does not join stops ${k}, ${k + 1}`);
      });
      for (const s of p.stations) if (!n.stations[s]) errors.push(`city ${id} pattern ${pi} bad station ${s}`);
      if (!p.stations.some((s) => n.stations[s]?.city === id)) errors.push(`city ${id} pattern ${pi} does not call at city`);
    });
    if (cf.patternTz.length !== cf.patterns.length) errors.push(`city ${id} patternTz length`);
    for (const t of cf.trips) {
      if (!cf.patterns[t[0]] || !cal.masks[t[2]]) {
        errors.push(`city ${id} trip references invalid pattern/calendar`);
        break;
      }
    }
  }
  if (errors.length > 50) errors.splice(50, errors.length - 50, "… more errors truncated");

  // ---- known facts (warnings only)
  const day = weekdayIndex(cal);
  const pair = (a: string[], b: string[], min: number, label: string, ca?: string, cb?: string) => {
    const A = findCity(n, a, ca), B = findCity(n, b, cb);
    if (!A || !B) {
      checks[label] = "cities missing";
      if (min > 0) warnings.push(`${label}: city not found (${A ? "" : a[0]} ${B ? "" : b[0]})`);
      return;
    }
    const cf = inp.readCity(A.id);
    const cnt = cf ? countDirect(cf, n, cal, B.id, day) : 0;
    checks[label] = cnt;
    if (cnt < min) warnings.push(`${label}: only ${cnt} direct trips on day ${day} (expected ≥ ${min})`);
  };
  const has = (cc: string) => n.cities.some((c) => c.country === cc && c.cats & 3);
  if (has("DE")) {
    pair(["Berlin"], ["Hamburg"], 20, "Berlin→Hamburg", "DE", "DE");
    pair(["München", "Munich"], ["Nürnberg", "Nuremberg"], 20, "München→Nürnberg", "DE", "DE");
    const m = findCity(n, ["München", "Munich"], "DE");
    if (m) {
      const names = m.stations.map((s) => n.stations[s]!.name);
      const hbf = names.some((x) => /München Hbf|München Hauptbahnhof/i.test(x));
      const ost = names.some((x) => /München Ost/i.test(x));
      checks["München Hbf+Ost same city"] = hbf && ost;
      if (!(hbf && ost)) warnings.push(`München Hbf / Ost not both in München (${names.slice(0, 8).join(", ")})`);
    }
    const ber = findCity(n, ["Berlin"], "DE"), pots = findCity(n, ["Potsdam"], "DE");
    checks["Potsdam separate from Berlin"] = !!(ber && pots && ber.id !== pots.id);
    if (!(ber && pots && ber.id !== pots.id)) warnings.push("Potsdam is not a separate city");
    if (ber) {
      const names = ber.stations.map((s) => n.stations[s]!.name);
      for (const st of ["Berlin Hbf", "Berlin Ostbahnhof", "Berlin Gesundbrunnen", "Berlin Südkreuz", "Berlin-Spandau"]) {
        const ok = names.some((x) => x.replace(/[-\s]/g, "").toLowerCase().startsWith(st.replace(/[-\s]/g, "").toLowerCase()));
        checks[`Berlin has ${st}`] = ok;
        if (!ok) warnings.push(`Berlin is missing station ${st}`);
      }
    }
    for (const [a, b] of [["Offenbach am Main", "Frankfurt am Main"], ["Fürth", "Nürnberg"]] as const) {
      const A = n.cities.find((c) => c.name.startsWith(a.split(" ")[0]!) && c.country === "DE");
      const B = n.cities.find((c) => c.name.startsWith(b.split(" ")[0]!) && c.country === "DE");
      checks[`${a} separate from ${b}`] = !!(A && B && A.id !== B.id);
    }
  }
  if (has("AT") || has("HU")) pair(["Wien", "Vienna"], ["Budapest"], 1, "Wien→Budapest", "AT", "HU");
  if (has("CZ") && has("AT")) pair(["Praha", "Prague"], ["Wien", "Vienna"], 1, "Praha→Wien", "CZ", "AT");
  if (has("TR")) pair(["İstanbul", "Istanbul"], ["Ankara"], 1, "İstanbul→Ankara", "TR", "TR");
  if (has("FR")) pair(["Paris"], ["Lyon"], 10, "Paris→Lyon", "FR", "FR");
  if (has("GB")) pair(["London"], ["Manchester"], 10, "London→Manchester", "GB", "GB");
  if (has("CH")) pair(["Zürich", "Zurich"], ["Bern"], 20, "Zürich→Bern", "CH", "CH");
  checks.weekdayIndex = day;
  return { errors, warnings, checks };
}
