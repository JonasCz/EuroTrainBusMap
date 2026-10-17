/** Application controller: state → data → map highlight + panel. */
import type { CityFile } from "@etbm/shared";
import { loadCity } from "./data/load.ts";
import { cityTz, ensureDetail, stationBySlug, stationName, stationSlug, type Net } from "./data/net.ts";
import { addDays, inHorizon } from "./logic/calendar.ts";
import { connections, type Connection, type OnwardStop } from "./logic/connections.ts";
import { sameFilters, type Filters } from "./logic/filters.ts";
import { resolveLeg, type Leg, type LegInfo } from "./logic/journey.ts";
import { computeReach } from "./logic/reach.ts";
import { addTraffic, trafficCats, type CorridorTraffic } from "./logic/context.ts";
import { nextServiceDates, pairCandidates, pairTraffic, serviceDates, timetable, type Departure } from "./logic/timetable.ts";
import { stationDepartures } from "./logic/stations.ts";
import { localDate } from "./logic/tz.ts";
import { STATION_ZOOM } from "./map/lod.ts";
import type { MapView, Highlight } from "./map/mapview.ts";
import { Panel, type View } from "./ui/panel.ts";
import { parseHash, toHash, type AppState } from "./ui/state.ts";

export const CONNECTION_WINDOW_MIN = 180;

/** A value computed on first use (e.g. the date picker's service days, only needed when it opens). */
function lazy<T>(f: () => T): () => T {
  let done = false;
  let v: T;
  return () => {
    if (!done) {
      v = f();
      done = true;
    }
    return v;
  };
}

export class App {
  state: AppState;
  private token = 0;
  private lastFilters: Filters | null = null;
  private lastFocusKey = "";

  constructor(
    readonly net: Net,
    private map: MapView,
    private panel: Panel,
    private padding: () => { top: number; bottom: number; left: number; right: number },
  ) {
    this.state = parseHash(net, location.hash);
    addEventListener("popstate", () => this.fromUrl());
    addEventListener("hashchange", () => this.fromUrl());
  }

  private fromUrl(): void {
    const s = parseHash(this.net, location.hash);
    if (toHash(this.net, s) === toHash(this.net, this.state)) return;
    this.state = s;
    void this.render();
  }

  /** Update state; push a history entry unless `replace`. */
  set(patch: Partial<AppState>, opts: { replace?: boolean } = {}): void {
    const next: AppState = { ...this.state, ...patch };
    for (const k of Object.keys(patch) as (keyof AppState)[]) if (patch[k] === undefined) delete next[k];
    // a station belongs to its city: another origin city (or none) drops it, unless the patch names one
    if (patch.city !== this.state.city && !("station" in patch)) delete next.station;
    if (next.city === undefined) {
      delete next.dest;
      delete next.station;
      next.legs = [];
    }
    if (next.dest === undefined) next.legs = [];
    this.state = next;
    const hash = toHash(this.net, next);
    const url = `${location.pathname}${location.search}${hash}`;
    if (url !== `${location.pathname}${location.search}${location.hash}`) {
      if (opts.replace) history.replaceState(null, "", url || location.pathname);
      else history.pushState(null, "", url || location.pathname);
    }
    void this.render();
  }

  // ---- actions --------------------------------------------------------------

  clickCity(id: number): void {
    const s = this.state;
    if (s.city === undefined) this.set({ city: id, dest: undefined, legs: [] });
    else if (id === s.city) {
      if (s.dest !== undefined) this.set({ dest: undefined, legs: [] });
      else this.set({ city: undefined, date: undefined });
    } else if (id === s.dest && !s.legs.length) return;
    else this.set({ dest: id, legs: [] });
  }

  /**
   * A station was clicked (station zoom). With no selection it becomes the origin: the reach is that
   * one station's, the whole city's stations stay highlighted around it. Inside the origin city it
   * switches (or, clicked again, drops) the origin station; elsewhere it is a destination, like its city.
   */
  clickStation(id: number, city: number, name: string): void {
    const s = this.state;
    const c = this.net.cities[city];
    if (!c) return;
    const slug = stationSlug(c.name, name);
    if (s.city === undefined) this.set({ city, station: slug, dest: undefined, legs: [] });
    else if (city === s.city) this.set({ station: s.station === slug ? undefined : slug, legs: [] });
    else this.clickCity(city);
  }

  background(): void {
    if (this.state.city !== undefined) this.set({ city: undefined, station: undefined, dest: undefined, legs: [], date: undefined });
  }

  back(): void {
    const s = this.state;
    if (s.legs.length) this.set({ legs: s.legs.slice(0, -1) });
    else if (s.dest !== undefined) this.set({ dest: undefined });
    else if (s.station !== undefined) this.set({ station: undefined });
    else if (s.city !== undefined) this.set({ city: undefined, date: undefined });
  }

  // ---- rendering ----------------------------------------------------------------

  today(city: number): string {
    return localDate(Date.now(), cityTz(this.net, city));
  }

  async render(): Promise<void> {
    const tok = ++this.token;
    const s = this.state;
    const net = this.net;
    if (!this.lastFilters || !sameFilters(this.lastFilters, s.filters)) {
      this.lastFilters = s.filters;
      void this.map.setFilters(s.filters); // base network builds in a worker; UI does not wait
    }
    this.panel.setFilters(s.filters);
    const stale = () => tok !== this.token;
    const empty: Highlight = { emphasis: { focus: new Set(), active: false }, corridors: new Map() };

    if (s.city === undefined) {
      document.title = "EuroTrainBusMap";
      await this.map.setHighlight(empty);
      this.panel.show({ kind: "intro" });
      return;
    }
    const origin = s.city;
    const originName = net.cities[origin]!.name;
    this.panel.show({ kind: "loading", title: originName });
    let cf: CityFile;
    const tLoad = performance.now();
    try {
      [cf] = await Promise.all([loadCity(net.ds, origin), ensureDetail(net)]);
      if (import.meta.env.DEV) console.debug(`[perf] city file ${originName} ${Math.round(performance.now() - tLoad)} ms`);
    } catch (e) {
      if (!stale()) this.panel.show({ kind: "error", message: `Could not load timetable data for ${originName}. ${(e as Error).message}` });
      return;
    }
    if (stale()) return;
    // the origin station (URL: slug of its name) is known once the city's geo file is loaded
    const originStation = s.station !== undefined ? stationBySlug(net, origin, s.station) : undefined;
    if (s.station !== undefined && originStation === undefined) {
      this.set({ station: undefined }, { replace: true }); // unknown station: the whole city
      return;
    }

    // ---- one city (or one station of it): reachable destinations
    if (s.dest === undefined) {
      const tReach = performance.now();
      const reach = computeReach(cf, net.ctx, s.filters, originStation);
      if (import.meta.env.DEV) console.debug(`[perf] reach ${reach.dests.size} dests ${Math.round(performance.now() - tReach)} ms`);
      const focus = new Set([origin, ...reach.dests.keys()]);
      // panel first (the list is what the user waits for), then the map highlight
      const label = originStation !== undefined ? `${stationName(net, originStation)}` : originName;
      document.title = `${label} – EuroTrainBusMap`;
      this.panel.show({ kind: "reach", city: origin, ...(originStation !== undefined ? { station: originStation } : {}), reach, stationDeps: stationDepartures(cf, net.ctx) });
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      if (stale()) return;
      await this.map.setHighlight({ emphasis: { focus, active: true, origin, ...(originStation !== undefined ? { originStation } : {}) }, corridors: reach.corridors, traffic: reach.traffic });
      // frame the origin and its most important destinations (not every bus stop)
      const top = [...reach.dests.keys()].sort((a, b) => net.cities[b]!.importance - net.cities[a]!.importance).slice(0, 25);
      // a station picked at station zoom keeps the view (the panel lists its destinations); a city fits its destinations
      if (originStation !== undefined && this.map.map.getZoom() >= STATION_ZOOM) this.lastFocusKey = `r${origin}`;
      else this.frame([origin, ...top], `r${origin}`);
      return;
    }

    const dest = s.dest;
    const date = s.date ?? this.today(origin);

    // ---- pair timetable
    if (!s.legs.length) {
      const cands = pairCandidates(cf, net.ctx, s.filters, dest, originStation);
      const deps = timetable(cf, net.ctx, s.filters, dest, date, cands);
      const traffic = pairTraffic(cf, net.ctx, s.filters, dest, originStation);
      const corridors = trafficCats(traffic);
      const next = deps.length ? [] : nextServiceDates(cf, net.ctx, s.filters, dest, date, 5, originStation);
      await this.map.setHighlight({
        emphasis: { focus: this.withCorridorEnds(new Set([origin, dest]), corridors), active: true, origin, dest, ...(originStation !== undefined ? { originStation } : {}) },
        corridors,
        traffic,
      });
      const fromName = originStation !== undefined ? stationName(net, originStation) : originName;
      document.title = `${fromName} → ${net.cities[dest]!.name} – EuroTrainBusMap`;
      this.panel.show({
        kind: "timetable",
        city: origin,
        ...(originStation !== undefined ? { station: originStation } : {}),
        dest,
        date,
        today: this.today(origin),
        deps,
        next,
        inHorizon: inHorizon(net.cal, date),
        hasService: corridors.size > 0,
        serviceDays: lazy(() => serviceDates(cf, net.ctx, s.filters, dest, originStation, cands)),
      });
      this.frame([origin, dest], `p${origin}-${dest}`);
      return;
    }

    // ---- journey: resolve legs, then connections from the last arrival
    const infos: LegInfo[] = [];
    let from = origin;
    for (const leg of s.legs) {
      const l: Leg = { ...leg, from };
      const lcf = from === origin ? cf : await loadCity(net.ds, from).catch(() => null);
      if (stale()) return;
      const info = lcf ? resolveLeg(lcf, net.ctx, l) : null;
      if (!info) break;
      infos.push(info);
      from = info.to;
    }
    if (!infos.length) {
      this.set({ legs: [] }, { replace: true });
      return;
    }
    if (infos.length !== s.legs.length) {
      this.state = { ...s, legs: infos.map((i) => i.leg) };
      history.replaceState(null, "", toHash(net, this.state) || location.pathname);
    }
    const last = infos[infos.length - 1]!;
    let conns: Connection[] = [];
    try {
      const bcf = await loadCity(net.ds, last.to);
      if (stale()) return;
      conns = connections(
        bcf,
        net.ctx,
        s.filters,
        { city: last.to, station: last.arrStation, utc: last.arrUtc, routeName: last.route.name, ...(last.number !== undefined ? { number: last.number } : {}) },
        CONNECTION_WINDOW_MIN,
      );
    } catch (e) {
      if (!stale()) this.panel.show({ kind: "error", message: `Could not load ${net.cities[last.to]!.name}. ${(e as Error).message}` });
      return;
    }
    // every leg is one trip: one trip/day of width on its corridors
    const traffic: CorridorTraffic = new Map();
    const focus = new Set<number>([origin]);
    for (const i of infos) {
      addTraffic(traffic, i.corridors, i.route.cat, 1);
      focus.add(i.to);
    }
    const corridors = trafficCats(traffic);
    for (const c of conns) for (const st of c.stops) focus.add(st.city);
    await this.map.setHighlight({ emphasis: { focus: this.withCorridorEnds(focus, corridors), active: true, origin, dest: last.to }, corridors, traffic });
    document.title = `Connections from ${net.cities[last.to]!.name} – EuroTrainBusMap`;
    this.panel.show({ kind: "connections", legs: infos, conns, windowMin: CONNECTION_WINDOW_MIN });
    this.frame(
      [origin, ...infos.map((i) => i.to)],
      `j${infos.map((i) => i.to).join("-")}`,
    );
  }

  private withCorridorEnds(focus: Set<number>, corridors: Map<number, number>): Set<number> {
    // corridors join stations: their cities are emphasised too
    for (const cid of corridors.keys()) {
      const c = this.net.geo.corridors.get(cid);
      if (!c) continue;
      for (const st of [c.a, c.b]) {
        const city = this.net.ctx.stationCity[st];
        if (city !== undefined) focus.add(city);
      }
    }
    return focus;
  }

  /** Re-frame only when the focus set changed (not on date/filter changes). */
  private frame(ids: number[], key: string): void {
    if (key === this.lastFocusKey) return;
    this.lastFocusKey = key;
    this.map.fitCities(ids, this.padding());
  }

  // ---- panel actions ----------------------------------------------------------------

  chooseDeparture(d: Departure): void {
    this.set({ legs: [{ from: this.state.city!, trip: d.trip, date: d.serviceDate, board: d.board, alight: d.alight }] });
  }

  chooseConnection(c: Connection, stop: OnwardStop, fromCity: number): void {
    const v = stop.via ?? { trip: c.trip, serviceDate: c.serviceDate, board: c.board };
    const leg: Leg = { from: fromCity, trip: v.trip, date: v.serviceDate, board: v.board, alight: stop.stop };
    this.set({ legs: [...this.state.legs, leg] });
  }

  shiftDate(days: number): void {
    const s = this.state;
    if (s.city === undefined) return;
    const d = addDays(s.date ?? this.today(s.city), days);
    this.set({ date: d }, { replace: true });
  }
}
