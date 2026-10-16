import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deserializeRailGraph } from "../geometry/railbin.ts";
import { Router } from "../geometry/route.ts";
import { fastDist } from "../util/geo.ts";
import { UMode, type LonLat, type UrbanFeed, type UrbanPattern } from "./types.ts";

export interface Aligners {
  /** tram / metro / light-rail track */
  rail: Router | null;
  /** tertiary and above roads (city buses) */
  road: Router | null;
}

/** Tight snapping: a stop is on its track / street, not a kilometre away. */
const SNAP = { snapRadius: 120, snapSlack: 40, maxCandidates: 6 };

function graphFile(kind: "rail" | "road", workDir: string, assetsDir: string): string | null {
  const name = kind === "rail" ? "urbanrail-graph-v1.bin" : "road-graph-v1.bin";
  const env = kind === "road" ? process.env.ETBM_ROAD_GRAPH : process.env.ETBM_URBAN_RAIL_GRAPH;
  const dir = kind === "rail" ? "rail" : "road";
  return [env, join(workDir, "geometry", name), join(assetsDir, dir, name)].filter((f): f is string => !!f).find((f) => existsSync(f)) ?? null;
}

export function loadAligners(workDir: string, assetsDir: string, log: (m: string) => void): Aligners {
  const out: Aligners = { rail: null, road: null };
  const rf = graphFile("rail", workDir, assetsDir);
  if (rf) {
    out.rail = new Router(deserializeRailGraph(readFileSync(rf)).graph, { ...SNAP, minComponent: 300 });
    log(`urban: tram/metro track graph ${rf}`);
  } else log("urban: WARNING no urban rail graph (rail/urbanrail-graph-v1.bin): tram / metro lines without shapes stay stop-to-stop");
  const df = graphFile("road", workDir, assetsDir);
  if (df) {
    out.road = new Router(deserializeRailGraph(readFileSync(df)).graph, { ...SNAP, minComponent: 3000 });
    log(`urban: road graph ${df}`);
  } else log("urban: WARNING no road graph: city buses without shapes stay stop-to-stop");
  return out;
}

export interface AlignStats {
  patterns: Record<string, { shape: number; routed: number; partial: number; stops: number }>;
}

/** Hops longer than this (m) relative to the straight distance are rejected. */
export const detourLimit = (d: number) => 1.7 * d + 250;

/**
 * Give patterns that came without a shape a plausible alignment: every hop between consecutive stops
 * follows the track (tram / metro) or the street (bus) graph where it can be routed within a small
 * detour, else it stays a straight chord. Patterns with at least 70 % routed hops are marked as aligned.
 */
export function alignFeed(feed: UrbanFeed, al: Aligners, stats: AlignStats): void {
  const cache = new Map<string, LonLat[] | null>();
  const key = (a: LonLat, b: LonLat) => `${a[0]},${a[1]};${b[0]},${b[1]}`;
  for (const line of feed.lines) {
    const rail = line.mode !== UMode.Bus;
    const router = rail ? al.rail : al.road;
    const st = (stats.patterns[rail ? "rail" : "bus"] ??= { shape: 0, routed: 0, partial: 0, stops: 0 });
    for (const p of line.patterns) {
      if (p.geom === "shape") {
        st.shape++;
        continue;
      }
      if (!router || p.stops.length < 2) {
        st.stops++;
        continue;
      }
      const pts: LonLat[] = p.stops.map((s) => [feed.stops[s]!.lon, feed.stops[s]!.lat]);
      const out: LonLat[] = [pts[0]!];
      let ok = 0, hops = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!, b = pts[i]!;
        const d = fastDist(a[0], a[1], b[0], b[1]);
        if (d < 25) {
          out.push(b);
          ok++;
          hops++;
          continue;
        }
        hops++;
        const k = key(a, b);
        let r = cache.get(k);
        if (r === undefined) {
          const res = router.route(a, b, detourLimit(d));
          r = res ? res.coords : null;
          cache.set(k, r);
        }
        if (r && r.length >= 2) {
          ok++;
          // the routed path starts / ends at the track; keep the stops themselves as the ends
          out.push(...r.slice(1, -1), b);
        } else out.push(b);
      }
      const share = ok / Math.max(1, hops);
      if (share >= 0.7) {
        p.coords = out.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5] as LonLat);
        p.geom = rail ? "rail" : "road";
        st[ok === hops ? "routed" : "partial"]++;
      } else {
        st.stops++;
        // keep the partly routed path? a mix of chords and tracks looks worse than the clean chord line
      }
    }
  }
}

export type { UrbanPattern };
