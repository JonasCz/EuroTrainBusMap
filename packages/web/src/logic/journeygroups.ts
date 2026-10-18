/**
 * Journeys view: journeys with changes grouped by route option – the brand of every leg ("Intercités", "TER",
 * "TGV INOUI") and the change cities – so the list reads "Intercités → Marseille → TER" with the departures of
 * the day below it, instead of one flat list where a slower but different option is easy to miss.
 */
import { Cat, routeBrand, type Route } from "@etbm/shared";
import type { Journey } from "./transfer.ts";

/** Per leg of a journey: the route it was matched to in the boarding city's timetable, if any. */
export interface GroupLegIn {
  route?: Route;
}

export interface JourneyGroup<T> {
  key: string;
  /** The journeys stay on board the vehicle a continued journey arrives on (Journey.stay): their first leg is no change. */
  stay?: boolean;
  /** brand per leg */
  brands: string[];
  /** city of every change (before legs 2 …) */
  cities: number[];
  /** the change station before legs 2 … when every journey of the group uses the same pair (arrival = departure station: no walk) */
  stations: ({ arr: number; dep: number } | null)[];
  rows: T[];
  /** shortest / longest journey, minutes */
  minMin: number;
  maxMin: number;
}

/** Brand of a journey leg: from the transfer timetable, else from the matched route; "" for regional buses (the mode is enough). */
export function legBrand(brand: string, cat: number, route?: Route): string {
  if (cat === Cat.Bus) return "";
  return brand || (route ? routeBrand(route.name, route.agency, cat, route.brand) : "");
}

/**
 * Groups journeys by brands of the legs and change cities (staying on board apart); groups are sorted by their
 * fastest journey with 30 minutes added per change (staying on board first), rows by departure.
 */
export function groupJourneys<T>(rows: T[], journey: (r: T) => Journey, legs: (r: T) => GroupLegIn[], stationCity: ArrayLike<number>): JourneyGroup<T>[] {
  const groups = new Map<string, JourneyGroup<T>>();
  for (const r of rows) {
    const j = journey(r);
    const li = legs(r);
    const brands = j.legs.map((l, i) => legBrand(l.brand, l.cat, li[i]?.route) || `cat${l.cat}`);
    const cities: number[] = [];
    const stations: { arr: number; dep: number }[] = [];
    for (let i = 1; i < j.legs.length; i++) {
      const p = j.legs[i - 1]!, l = j.legs[i]!;
      const dep = l.stations[l.board]!;
      cities.push(stationCity[dep]!);
      stations.push({ arr: p.stations[p.alight]!, dep });
    }
    const key = `${j.stay ? "stay:" : ""}${brands.join("|")}#${cities.join(",")}`;
    const min = Math.round((j.arrUtc - j.depUtc) / 60000);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, ...(j.stay ? { stay: true } : {}), brands, cities, stations, rows: [], minMin: min, maxMin: min }));
    else {
      g.stations = g.stations.map((s, i) => (s && s.arr === stations[i]!.arr && s.dep === stations[i]!.dep ? s : null));
      g.minMin = Math.min(g.minMin, min);
      g.maxMin = Math.max(g.maxMin, min);
    }
    g.rows.push(r);
  }
  const out = [...groups.values()];
  for (const g of out) g.rows.sort((a, b) => journey(a).depUtc - journey(b).depUtc || journey(a).arrUtc - journey(b).arrUtc);
  const score = (g: JourneyGroup<T>) => g.minMin + 30 * g.cities.length;
  return out.sort((a, b) => Number(!!b.stay) - Number(!!a.stay) || score(a) - score(b) || b.rows.length - a.rows.length || (a.key < b.key ? -1 : 1));
}
