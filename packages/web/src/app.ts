/** Application controller: state → data → map highlight + panel. */
import type { CityFile } from "@etbm/shared";
import { loadCity } from "./data/load.ts";
import { cityTz, type Net } from "./data/net.ts";
import { addDays, inHorizon } from "./logic/calendar.ts";
import { connections, type Connection } from "./logic/connections.ts";
import { sameFilters, type Filters } from "./logic/filters.ts";
import { resolveLeg, type Leg, type LegInfo } from "./logic/journey.ts";
import { computeReach } from "./logic/reach.ts";
import { nextServiceDates, pairCorridors, timetable, type Departure } from "./logic/timetable.ts";
import { localDate } from "./logic/tz.ts";
import type { MapView, Highlight } from "./map/mapview.ts";
import { Panel, type View } from "./ui/panel.ts";
import { parseHash, toHash, type AppState } from "./ui/state.ts";

export const CONNECTION_WINDOW_MIN = 180;

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
    if (next.city === undefined) {
      delete next.dest;
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

  background(): void {
    if (this.state.city !== undefined) this.set({ city: undefined, dest: undefined, legs: [], date: undefined });
  }

  back(): void {
    const s = this.state;
    if (s.legs.length) this.set({ legs: s.legs.slice(0, -1) });
    else if (s.dest !== undefined) this.set({ dest: undefined });
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
      await this.map.setFilters(s.filters);
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
    try {
      cf = await loadCity(net.ds, origin);
    } catch (e) {
      if (!stale()) this.panel.show({ kind: "error", message: `Could not load timetable data for ${originName}. ${(e as Error).message}` });
      return;
    }
    if (stale()) return;

    // ---- one city: reachable destinations
    if (s.dest === undefined) {
      const reach = computeReach(cf, net.ctx, s.filters);
      const focus = new Set([origin, ...reach.dests.keys()]);
      await this.map.setHighlight({ emphasis: { focus, active: true, origin }, corridors: reach.corridors });
      document.title = `${originName} – EuroTrainBusMap`;
      this.panel.show({ kind: "reach", city: origin, reach });
      this.frame([...focus], `r${origin}`);
      return;
    }

    const dest = s.dest;
    const date = s.date ?? this.today(origin);

    // ---- pair timetable
    if (!s.legs.length) {
      const deps = timetable(cf, net.ctx, s.filters, dest, date);
      const corridors = pairCorridors(cf, net.ctx, s.filters, dest);
      const next = deps.length ? [] : nextServiceDates(cf, net.ctx, s.filters, dest, date);
      await this.map.setHighlight({ emphasis: { focus: this.withCorridorEnds(new Set([origin, dest]), corridors), active: true, origin, dest }, corridors });
      document.title = `${originName} → ${net.cities[dest]!.name} – EuroTrainBusMap`;
      this.panel.show({
        kind: "timetable",
        city: origin,
        dest,
        date,
        today: this.today(origin),
        deps,
        next,
        inHorizon: inHorizon(net.cal, date),
        hasService: corridors.size > 0,
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
    const corridors = new Map<number, number>();
    const focus = new Set<number>([origin]);
    for (const i of infos) {
      i.corridors.forEach((c) => corridors.set(c, (corridors.get(c) ?? 0) | i.route.cat));
      focus.add(i.to);
    }
    for (const c of conns) for (const st of c.stops) focus.add(st.city);
    await this.map.setHighlight({ emphasis: { focus: this.withCorridorEnds(focus, corridors), active: true, origin, dest: last.to }, corridors });
    document.title = `Connections from ${net.cities[last.to]!.name} – EuroTrainBusMap`;
    this.panel.show({ kind: "connections", legs: infos, conns, windowMin: CONNECTION_WINDOW_MIN });
    this.frame(
      [origin, ...infos.map((i) => i.to)],
      `j${infos.map((i) => i.to).join("-")}`,
    );
  }

  private withCorridorEnds(focus: Set<number>, corridors: Map<number, number>): Set<number> {
    for (const cid of corridors.keys()) {
      const c = this.net.corridors[cid];
      if (c) focus.add(c.a).add(c.b);
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

  chooseConnection(c: Connection, stopIdx: number, fromCity: number): void {
    const leg: Leg = { from: fromCity, trip: c.trip, date: c.serviceDate, board: c.board, alight: stopIdx };
    this.set({ legs: [...this.state.legs, leg] });
  }

  shiftDate(days: number): void {
    const s = this.state;
    if (s.city === undefined) return;
    const d = addDays(s.date ?? this.today(s.city), days);
    this.set({ date: d }, { replace: true });
  }
}
