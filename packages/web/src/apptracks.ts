/**
 * Hoverable tracks per view: what the highlighted tracks of a view stand for (route options of a journey
 * search, the services from a city or of a pair, the legs of a journey), the tooltip, what to emphasise on the
 * map and mark in the panel, and what a click opens. See logic/tracks.ts for the segment → items index.
 */
import type { Route } from "@etbm/shared";
import { stationName, type Net } from "./data/net.ts";
import { addTraffic, trafficCats, type CorridorTraffic } from "./logic/context.ts";
import { CAT_LABEL } from "./logic/filters.ts";
import { legBrand, type JourneyGroup } from "./logic/journeygroups.ts";
import type { Leg, LegInfo } from "./logic/journey.ts";
import type { Departure } from "./logic/timetable.ts";
import { buildTrackIndex, fmtTpd, itemsAt, nameList, summarizeRuns, type TrackIndex, type TrackItem, type TrackRun } from "./logic/tracks.ts";
import { fmtDuration, fmtTime } from "./logic/tz.ts";
import { corridorSegs } from "./map/features.ts";
import type { MapView, TrackFocus, TrackHandler } from "./map/mapview.ts";
import { h } from "./ui/dom.ts";
import { journeyGroups, routeKey, type JourneyRow, type Panel } from "./ui/panel.ts";

/** A view's tracks: the map handler plus the panel items (data-hl keys) hovered in the list. */
export interface ViewTracks extends TrackHandler {
  item(key: string): TrackFocus | null;
}

interface Ctx {
  net: Net;
  map: MapView;
  panel: Panel;
}

const focusOf = (key: string, traffic: CorridorTraffic, extra: Partial<TrackFocus> = {}): TrackFocus => ({ key, corridors: trafficCats(traffic), traffic, ...extra });

/** The index is built on the first hover (a city's services can be thousands of runs). */
function lazyIndex(net: Net, items: () => readonly TrackItem[]): () => TrackIndex {
  let idx: TrackIndex | null = null;
  return () => (idx ??= buildTrackIndex(items(), (c) => corridorSegs(net.geo, c)));
}

/** Brand of a route for tooltips: "TGV INOUI", "TER"; buses by their line ("Regional bus 12"). */
export function routeLabel(r: Route): string {
  return legBrand("", r.cat, r) || `${CAT_LABEL[r.cat] ?? "Line"} ${r.name}`.trim();
}

// ---------------------------------------------------------------- journeys (route options)

/** "TGV INOUI › Paris › TGV INOUI" */
function groupLabel(net: Net, g: JourneyGroup<JourneyRow>): string {
  const parts: string[] = [];
  g.brands.forEach((b, i) => {
    if (i) parts.push(net.cities[g.cities[i - 1]!]?.name ?? "?");
    const cat = g.rows[0]!.journey.legs[i]!.cat;
    parts.push(b.startsWith("cat") ? (CAT_LABEL[cat] ?? b) : b);
  });
  return parts.join(" › ");
}

function groupSum(g: JourneyGroup<JourneyRow>): string {
  const dur = g.minMin === g.maxMin ? fmtDuration(g.minMin) : `${fmtDuration(g.minMin)} – ${fmtDuration(g.maxMin)}`;
  return `${dur} · ${g.rows.length > 1 ? `${g.rows.length} a day` : "once a day"}`;
}

/**
 * Journeys view: a track is ridden by route options (groups). Hover: their legs on the map, the groups marked in
 * the list; click: the next journey of the one option, or a card to pick one of several.
 */
export function journeyTracks(c: Ctx, rows: JourneyRow[], open: (route: Leg[]) => void, cont: boolean): ViewTracks {
  const { net, map, panel } = c;
  const groups = journeyGroups(rows, net);
  const index = lazyIndex(net, () => groups.map((g) => ({ corridors: g.rows.flatMap((r) => r.legs.flatMap((l) => l.corridors ?? [])) })));
  const traffic = (rs: JourneyRow[]) => {
    const t: CorridorTraffic = new Map();
    for (const r of rs) for (const l of r.legs) addTraffic(t, l.corridors ?? [], l.raw.cat, 1);
    return t;
  };
  const groupsFocus = (gs: number[]) => focusOf(`g:${gs.join(",")}`, traffic(gs.flatMap((i) => groups[i]!.rows)));
  const at = (seg: number) => [...itemsAt(index(), [seg]).keys()];
  const next = (g: JourneyGroup<JourneyRow>) => {
    const now = Date.now();
    return g.rows.find((r) => r.route && r.journey.depUtc >= now) ?? g.rows.find((r) => r.route);
  };
  const openGroup = (g: JourneyGroup<JourneyRow>) => {
    const r = next(g);
    if (r?.route) open(r.route);
  };
  const verb = cont ? "add" : "open";
  return {
    hover(seg) {
      const gs = seg === null ? [] : at(seg);
      panel.markTracks(gs.length ? gs.map((i) => `g:${groups[i]!.key}`) : null);
      if (!gs.length) return null;
      const tip =
        gs.length === 1
          ? [groupLabel(net, groups[gs[0]!]!), groupSum(groups[gs[0]!]!), `Click to ${verb} the next journey`]
          : [
              `${gs.length} route options use this track`,
              ...gs.slice(0, 4).map((i) => `${groupLabel(net, groups[i]!)} (${groups[i]!.rows.length}×)`),
              ...(gs.length > 4 ? [`+${gs.length - 4} more`] : []),
              "Click to choose one",
            ];
      return { ...groupsFocus(gs), tip, clickable: true };
    },
    click(seg, lngLat) {
      const gs = at(seg);
      if (gs.length === 1) {
        openGroup(groups[gs[0]!]!);
        return;
      }
      if (!gs.length) return;
      const all = groupsFocus(gs);
      const card = h(
        "div",
        { class: "urb-card trk-card" },
        h("div", { class: "urb-title" }, `${gs.length} route options on this track`),
        gs.map((i) => {
          const g = groups[i]!;
          const r = next(g);
          const tz = net.ctx.cityTz[net.ctx.stationCity[r ? r.journey.legs[0]!.stations[r.journey.legs[0]!.board]! : 0]!] ?? "UTC";
          return h(
            "button",
            {
              type: "button",
              class: "trk-opt",
              onmouseenter: () => {
                map.emphasize(groupsFocus([i]));
                panel.markTracks([`g:${g.key}`]);
              },
              onmouseleave: () => {
                map.emphasize(all);
                panel.markTracks(gs.map((k) => `g:${groups[k]!.key}`), false);
              },
              onclick: () => {
                map.closePopup();
                openGroup(g);
              },
            },
            h("span", { class: "trk-opt-name" }, groupLabel(net, g)),
            h("span", { class: "trk-opt-sum" }, `${groupSum(g)}${r ? ` · next ${fmtTime(r.journey.depUtc, tz)}` : ""}`),
          );
        }),
      );
      map.showCard(card, lngLat);
      map.emphasize(all);
    },
    item(key) {
      if (key.startsWith("g:")) {
        const i = groups.findIndex((g) => `g:${g.key}` === key);
        return i < 0 ? null : groupsFocus([i]);
      }
      if (key.startsWith("j:")) {
        const r = rows[+key.slice(2)];
        return r ? focusOf(key, traffic([r])) : null;
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------- services from a city / of a pair

/**
 * Runs of services (reach view: every pattern from the city; timetable view: those of the pair). Hover: the
 * brands and trips/day over the track and the places beyond it; the runs on the map.
 */
export function runTracks(
  c: Ctx,
  runs: () => TrackRun[],
  opts: {
    /** data-hl keys of the panel items for the runs over a track */
    keys(runs: TrackRun[], dests: number[]): string[];
    /** the action of a click (label for the tooltip, run), if any */
    click(runs: TrackRun[], next: number | undefined): { label: string; run(): void } | null;
    /** the runs of a panel item */
    item(key: string, runs: TrackRun[]): { run: TrackRun; hops: number }[];
    tail?: boolean;
  },
): ViewTracks {
  const { net, map, panel } = c;
  const index = lazyIndex(net, runs);
  const name = (city: number) => net.cities[city]?.name ?? "?";
  const imp = (city: number) => net.cities[city]?.importance ?? 0;
  const at = (seg: number) => {
    const hits = itemsAt(index(), [seg]);
    const all = runs();
    const sum = summarizeRuns(all, hits, routeLabel, imp);
    const over = [...hits].filter(([i, pos]) => all[i]!.dests.some((d) => d.hops > pos)).map(([i]) => all[i]!);
    return { hits, sum, over };
  };
  const items = new Map<string, TrackFocus | null>();
  return {
    hover(seg) {
      const x = seg === null ? null : at(seg);
      if (!x?.over.length) {
        panel.markTracks(null);
        return null;
      }
      const { sum, over, hits } = x;
      panel.markTracks(opts.keys(over, sum.dests));
      const act = opts.click(over, sum.next);
      const brands = nameList(sum.brands.map((b) => b.name), 3);
      const tip = [brands, opts.tail === false ? fmtTpd(sum.tpd) : `${fmtTpd(sum.tpd)} to ${nameList(sum.dests.map(name), 4)}`, ...(act ? [`Click ${act.label}`] : [])];
      return focusOf(`r:${[...hits].map(([i, p]) => `${i}.${p}`).join(",")}`, sum.traffic, { tip, clickable: !!act });
    },
    click(seg) {
      const { sum, over } = at(seg);
      opts.click(over, sum.next)?.run();
    },
    item(key) {
      if (items.has(key)) return items.get(key)!;
      const t: CorridorTraffic = new Map();
      for (const { run, hops } of opts.item(key, runs())) addTraffic(t, run.corridors.slice(0, hops), run.route.cat, run.tpd);
      const f = t.size ? focusOf(`i:${key}`, t) : null;
      items.set(key, f);
      return f;
    },
  };
}

/** Reach view: hover shows the services over a track and the places beyond; click selects the next place. */
export function reachTracks(c: Ctx, runs: () => TrackRun[], pick: (city: number) => void): ViewTracks {
  return runTracks(c, runs, {
    keys: (_r, dests) => dests.map((d) => `c:${d}`),
    click: (_r, next) => (next === undefined ? null : { label: `for ${c.net.cities[next]?.name ?? "?"}`, run: () => pick(next) }),
    item: (key, all) => {
      if (!key.startsWith("c:")) return [];
      const city = +key.slice(2);
      return all.flatMap((run) => run.dests.filter((d) => d.city === city).map((d) => ({ run, hops: d.hops })));
    },
  });
}

/** Timetable view (direct services of a pair): the routes over a track; click opens the next of their departures. */
export function pairTracks(c: Ctx, runs: () => TrackRun[], deps: Departure[], choose: (d: Departure) => void): ViewTracks {
  return runTracks(c, runs, {
    tail: false,
    keys: (over) => [...new Set(over.map((r) => routeKey(r.route)))],
    click: (over) => {
      const keys = new Set(over.map((r) => routeKey(r.route)));
      const now = Date.now();
      const mine = deps.filter((d) => keys.has(routeKey(d.route)));
      const d = mine.find((x) => x.depUtc >= now) ?? mine[0];
      return d ? { label: `to open the ${fmtTime(d.depUtc, c.net.ctx.cityTz[c.net.ctx.stationCity[d.depStation]!] ?? "UTC")} departure`, run: () => choose(d) } : null;
    },
    item: (key, all) => all.filter((r) => routeKey(r.route) === key).map((run) => ({ run, hops: run.corridors.length })),
  });
}

// ---------------------------------------------------------------- legs of a journey

/** Schedule / journey / connections views: a track is one of the legs ridden; click as given (or nothing). */
export function legTracks(c: Ctx, infos: LegInfo[], click: ((leg: number) => void) | null, clickLabel = ""): ViewTracks {
  const { net, panel } = c;
  const index = lazyIndex(net, () => infos.map((i) => ({ corridors: i.corridors })));
  const tz = (st: number) => net.ctx.cityTz[net.ctx.stationCity[st]!] ?? "UTC";
  const legFocus = (ls: number[], extra: Partial<TrackFocus> = {}) => {
    const t: CorridorTraffic = new Map();
    for (const i of ls) addTraffic(t, infos[i]!.corridors, infos[i]!.route.cat, 1);
    return focusOf(`l:${ls.join(",")}`, t, extra);
  };
  const at = (seg: number) => [...itemsAt(index(), [seg]).keys()];
  return {
    hover(seg) {
      const ls = seg === null ? [] : at(seg);
      panel.markTracks(ls.length ? ls.map((i) => `l:${i}`) : null);
      if (!ls.length) return null;
      const tip = ls.flatMap((i) => {
        const l = infos[i]!;
        return [`${[l.route.name, l.number].filter(Boolean).join(" ")} → ${l.headsign}`, `${fmtTime(l.depUtc, tz(l.depStation))} ${stationName(net, l.depStation)} → ${fmtTime(l.arrUtc, tz(l.arrStation))} ${stationName(net, l.arrStation)}`];
      });
      if (click && clickLabel) tip.push(`Click ${clickLabel}`);
      return legFocus(ls, { tip, clickable: !!click });
    },
    click(seg) {
      const ls = at(seg);
      if (ls.length && click) click(ls[0]!);
    },
    item(key) {
      if (!key.startsWith("l:")) return null;
      const i = +key.slice(2);
      return infos[i] ? legFocus([i]) : null;
    },
  };
}
