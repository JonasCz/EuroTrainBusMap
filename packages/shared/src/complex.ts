/**
 * Station complexes: where a city's stations are drawn separately (STATION_ZOOM and beyond), the
 * stations that belong together get a soft outline (the convex hull of their points, drawn by the
 * style with a constant screen-space radius, so it has straight edges and rounded corners), and the
 * trains / buses that run between them are drawn as links. Pure, shared by the ETL (tiles, link
 * selection) and the tests; the web style only draws what the tiles carry.
 *
 * Rules (the same for every city):
 *  - members: a city's major stations (stationLevel <= 1) that have rail service or at least
 *    MEMBER_MIN_TPD departures per day – minor bus stops never take part;
 *  - a city with at most MAX_MEMBERS members within MAX_SPAN_KM of each other is one complex (level 0, shown
 *    from the zoom of its second member);
 *  - a bigger city (London, Paris…) would become a blob: its members are clustered greedily
 *    (heaviest first, CLUSTER_KM around the cluster's lead station) and every cluster of two or more
 *    is a small complex of its own (level 1, shown from STATION_LEVELS[CX_DETAIL_LEVEL]);
 *  - a link (an intra-city hop of a pattern, e.g. Tipperary – Limerick Junction) is kept when both
 *    ends are members and it is not shorter than MIN_LINK_M; it appears when both ends are drawn.
 */
import { Cat, type City, type Station } from "./schema.ts";
import { haversineKm, stationLevel } from "./lod.ts";

export const MEMBER_MIN_TPD = 15;
export const MAX_SPAN_KM = 6;
export const MAX_MEMBERS = 8;
export const CLUSTER_KM = 1.0;
export const MIN_LINK_M = 150;
export const MAX_LINK_KM = 30;
/** Complexes of big cities (clusters) appear from STATION_LEVELS[CX_DETAIL_LEVEL] (11.5) at the earliest. */
export const CX_DETAIL_LEVEL = 1;

type Pos = [number, number];
const RAIL = Cat.LongDistance | Cat.Regional;

export interface Complex {
  city: number;
  /** 0: the whole city (compact), 1: a cluster in a big city */
  level: 0 | 1;
  /** station ids, heaviest first */
  members: number[];
  /** index into STATION_LEVELS of the zoom from which the outline is shown */
  zi: number;
}

/** Whether the station at `rank` of its city's list takes part in complexes. */
export function isMember(s: Pick<Station, "cats" | "tpd">, rank: number): boolean {
  return stationLevel(s.cats, rank) <= 1 && ((s.cats & RAIL) !== 0 || (s.tpd ?? 0) >= MEMBER_MIN_TPD);
}

/** Level index (into STATION_LEVELS) at which the station at `rank` is drawn. */
export const stationZi = (s: Pick<Station, "cats">, rank: number) => stationLevel(s.cats, rank);

export function cityMembers(c: Pick<City, "stations">, stations: (Station | undefined)[]): number[] {
  const out: number[] = [];
  c.stations.forEach((sid, rank) => {
    const s = stations[sid];
    if (s && isMember(s, rank)) out.push(sid);
  });
  return out;
}

const km = (a: Station, b: Station) => haversineKm([a.lon, a.lat], [b.lon, b.lat]);

/** The complexes of one city (empty when it has fewer than two members). */
export function cityComplexes(c: City, stations: (Station | undefined)[]): Complex[] {
  const ids = cityMembers(c, stations);
  if (ids.length < 2) return [];
  const rankOf = new Map(c.stations.map((s, i) => [s, i]));
  const zi = (members: number[]) => {
    const z = members.map((m) => stationZi(stations[m]!, rankOf.get(m)!)).sort((a, b) => a - b);
    return z[1]!; // the second member's level: the outline appears when two stations are drawn
  };
  let span = 0;
  for (let i = 0; i < ids.length && span <= MAX_SPAN_KM; i++) for (let j = i + 1; j < ids.length; j++) span = Math.max(span, km(stations[ids[i]!]!, stations[ids[j]!]!));
  if (span <= MAX_SPAN_KM && ids.length <= MAX_MEMBERS) return [{ city: c.id, level: 0, members: ids, zi: zi(ids) }];
  const clusters: number[][] = [];
  for (const id of ids) {
    const s = stations[id]!;
    let best = -1, bd = CLUSTER_KM;
    clusters.forEach((cl, k) => {
      const d = km(s, stations[cl[0]!]!);
      if (d <= bd) [best, bd] = [k, d];
    });
    if (best >= 0) clusters[best]!.push(id);
    else clusters.push([id]);
  }
  return clusters
    .filter((cl) => cl.length >= 2)
    .map((members) => ({ city: c.id, level: 1 as const, members, zi: Math.max(zi(members), CX_DETAIL_LEVEL) }));
}

/** Convex hull (Andrew's monotone chain), counter-clockwise, without the closing point. */
export function convexHull(points: Pos[]): Pos[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]).filter((q, i, arr) => i === 0 || q[0] !== arr[i - 1]![0] || q[1] !== arr[i - 1]![1]);
  if (p.length < 3) return p;
  const cross = (o: Pos, a: Pos, b: Pos) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (pts: Pos[]) => {
    const h: Pos[] = [];
    for (const q of pts) {
      while (h.length >= 2 && cross(h[h.length - 2]!, h[h.length - 1]!, q) <= 0) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return [...build(p), ...build([...p].reverse())];
}

/** Outline geometry of a complex: a polygon (3+ stations not on a line), else a line. */
export function complexGeometry(points: Pos[]): { type: "Polygon"; coordinates: Pos[][] } | { type: "LineString"; coordinates: Pos[] } | null {
  const h = convexHull(points);
  if (h.length < 2) return null;
  if (h.length === 2) return { type: "LineString", coordinates: h };
  return { type: "Polygon", coordinates: [[...h, h[0]!]] };
}

/** Whether a station-to-station hop is a link worth drawing. */
export function isLinkCandidate(a: Pick<Station, "lon" | "lat">, b: Pick<Station, "lon" | "lat">): boolean {
  const d = haversineKm([a.lon, a.lat], [b.lon, b.lat]) * 1000;
  return d >= MIN_LINK_M && d <= MAX_LINK_KM * 1000;
}
