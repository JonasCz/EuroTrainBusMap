/** App state ⇄ URL hash. */
import type { Net } from "../data/net.ts";
import { cityByRef } from "../data/net.ts";
import { isValidDate } from "../logic/calendar.ts";
import { ALL_CATS, decodeCats, encodeCats, type Filters } from "../logic/filters.ts";
import { decodeLegs, encodeLegs, type Leg } from "../logic/journey.ts";

export interface AppState {
  city?: number;
  dest?: number;
  /** Selected date (origin-local), undefined = today. */
  date?: string;
  filters: Filters;
  /** Journey legs; legs[0] departs from `city`. `from` of later legs is resolved lazily (-1). */
  legs: Leg[];
}

export function parseHash(net: Net, hash: string): AppState {
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  const city = cityByRef(net, q.get("from"));
  const dest = city !== undefined ? cityByRef(net, q.get("to")) : undefined;
  const date = q.get("date");
  const f = q.get("modes");
  const legs = city !== undefined && dest !== undefined ? decodeLegs(q.get("legs"), city) : [];
  return {
    ...(city !== undefined ? { city } : {}),
    ...(dest !== undefined && dest !== city ? { dest } : {}),
    ...(isValidDate(date) ? { date } : {}),
    filters: { cats: f === null ? ALL_CATS : decodeCats(f) },
    legs,
  };
}

export function toHash(net: Net, s: AppState): string {
  const q: string[] = [];
  if (s.city !== undefined) q.push(`from=${net.slug[s.city]}`);
  if (s.city !== undefined && s.dest !== undefined) q.push(`to=${net.slug[s.dest]}`);
  if (s.date && s.city !== undefined) q.push(`date=${s.date}`);
  if (s.legs.length && s.dest !== undefined) q.push(`legs=${encodeLegs(s.legs)}`);
  if (s.filters.cats !== ALL_CATS) q.push(`modes=${encodeCats(s.filters.cats) || "none"}`);
  return q.length ? `#${q.join("&")}` : "";
}
