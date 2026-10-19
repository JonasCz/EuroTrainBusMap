/**
 * Where a generated timetable comes from (Route.src / srcAt, attribution `retrieved`): the texts of the source link
 * in the trip schedule and the journey legs ("Timetable: zfbh.ba · retrieved 19 Oct 2026") and of the data sources
 * dialog. Pure functions (no DOM), so they can be tested.
 */
import type { Route } from "@etbm/shared";

/** "2026-10-19T17:53:12Z" → "19 Oct 2026" (the UTC date); null for anything else. */
export function retrievedDate(iso: string | undefined): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(iso)) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** "19 Oct 2026, 17:53 UTC" for tooltips; null for anything else. */
export function retrievedTime(iso: string | undefined): string | null {
  const day = retrievedDate(iso);
  return day ? `${day}, ${iso!.slice(11, 16)} UTC` : null;
}

/** Host of a source page without "www." ("zfbh.ba"); the URL itself when it does not parse. */
export function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Text and tooltip of a route's source link, or null for routes from GTFS feeds (no Route.src). */
export function sourceLinkText(r: Pick<Route, "src" | "srcAt">): { text: string; title: string } | null {
  if (!r.src || !/^https?:\/\//.test(r.src)) return null;
  const host = sourceHost(r.src);
  const day = retrievedDate(r.srcAt);
  const time = retrievedTime(r.srcAt);
  return {
    text: day ? `Timetable: ${host} · retrieved ${day}` : `Timetable: ${host}`,
    title: `Generated from the timetable on ${host}${time ? `, read ${time}` : ""} (no open data feed exists): check it there before travelling`,
  };
}

/** The data sources dialog's text after a source's name: " — CC-BY-4.0 · retrieved 19 Oct 2026". */
export function sourceMeta(s: { license: string; retrieved?: string }): string {
  const day = retrievedDate(s.retrieved);
  return ` — ${s.license}${day ? ` · retrieved ${day}` : ""}`;
}
