/** Application controller: state → data → map highlight + panel. */
import type { CityFile, Route } from "@etbm/shared";
import { loadCity, loadSchedule } from "./data/load.ts";
import { cityTz, ensureDetail, stationBySlug, stationName, stationSlug, type Net } from "./data/net.ts";
import { addDays, inHorizon } from "./logic/calendar.ts";
import { connections, transferMinutes, walkMinutesIn, type Arrival, type Connection, type OnwardStop } from "./logic/connections.ts";
import { sameFilters, type Filters } from "./logic/filters.ts";
import { encodeLegs, resolveLeg, type Leg, type LegInfo } from "./logic/journey.ts";
import { computeReach } from "./logic/reach.ts";
import { addTraffic, trafficCats, type CorridorTraffic } from "./logic/context.ts";
import { nextServiceDates, pairCandidates, pairTraffic, serviceDates, timetable, type Departure } from "./logic/timetable.ts";
import { stationDepartures } from "./logic/stations.ts";
import { tripSchedule, type TripSchedule } from "./logic/schedule.ts";
import { changeOptions, journeySchedule, type ChangeOption } from "./logic/journeyschedule.ts";
import { legBrand } from "./logic/journeygroups.ts";
import { localDate } from "./logic/tz.ts";
import { STATION_ZOOM } from "./map/lod.ts";
import type { MapView, Highlight } from "./map/mapview.ts";
import { Panel, type View } from "./ui/panel.ts";
import { parseHash, storeSettings, toHash, type AppState } from "./ui/state.ts";
import { groupJourneys } from "./logic/journeygroups.ts";
import { TransferClient, matchLeg, type ReachLines, type ReachRound } from "./data/transfer.ts";
import type { Journey, SearchParams, TransferSettings } from "./logic/transfer.ts";
import type { JourneyRow, XferDest, XferView } from "./ui/panel.ts";
import type { Reach } from "./logic/reach.ts";

export const CONNECTION_WINDOW_MIN = 180;
/** Places reached with connections drawn as emphasised dots / labels (the most important ones). */
const MAP_XFER_CITIES = 1500;
/** Most journeys listed in the journeys view (whole route options, the best first). */
const JOURNEY_ROWS = 150;

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
  /** connections with changes: worker client, last reach result */
  readonly transfers: TransferClient;
  private xferCache: { key: string; view: XferView; lines: string | null; levels: Map<number, number> } | null = null;

  constructor(
    readonly net: Net,
    private map: MapView,
    private panel: Panel,
    private padding: () => { top: number; bottom: number; left: number; right: number },
  ) {
    this.state = parseHash(net, location.hash);
    this.transfers = new TransferClient(net);
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
    // the trip schedule and the onward scope belong to the last leg: a new leg (or step) resets them unless named
    if ("legs" in patch && !("schedule" in patch)) delete next.schedule;
    if (("legs" in patch || "schedule" in patch) && !("journey" in patch)) delete next.journey;
    if (("legs" in patch || "schedule" in patch) && !("wholeCity" in patch)) delete next.wholeCity;
    if (!next.legs.length) {
      delete next.schedule;
      delete next.wholeCity;
    }
    if (!next.schedule) delete next.journey;
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
    // connections → the schedule of the trip that got there → the previous step (departures list / connections);
    // a journey picked from the journeys list goes back to the list
    if (s.legs.length && !s.schedule) this.set({ schedule: true });
    else if (s.journey) this.set({ legs: [] });
    else if (s.legs.length) this.set({ legs: s.legs.slice(0, -1) });
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
      const date = s.date ?? this.today(origin);
      const xs = s.xfer;
      const params: SearchParams = { origin, ...(originStation !== undefined ? { originStation } : {}), date, cats: s.filters.cats, ...xs };
      const key = JSON.stringify(params);
      const cached = xs.transfers > 0 && this.xferCache?.key === key ? this.xferCache : null;
      const xv: XferView = cached?.view ?? {
        settings: xs,
        date,
        today: this.today(origin),
        status: xs.transfers === 0 ? "off" : this.transfers.available ? "loading" : "unavailable",
        dests: [],
        rounds: 0,
      };
      const reachView: View = { kind: "reach", city: origin, ...(originStation !== undefined ? { station: originStation } : {}), reach, stationDeps: stationDepartures(cf, net.ctx), xfer: xv };
      this.panel.show(reachView);
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      if (stale()) return;
      const emphasis = { focus, active: true, origin, ...(originStation !== undefined ? { originStation } : {}) };
      await this.map.setHighlight({ emphasis: { ...emphasis, ...(cached ? { levels: cached.levels } : {}) }, corridors: reach.corridors, traffic: reach.traffic, ...(cached?.lines ? { xferJson: cached.lines } : {}) });
      // frame the origin and its most important destinations (not every bus stop)
      const top = [...reach.dests.keys()].sort((a, b) => net.cities[b]!.importance - net.cities[a]!.importance).slice(0, 25);
      // a station picked at station zoom keeps the view (the panel lists its destinations); a city fits its destinations
      if (originStation !== undefined && this.map.map.getZoom() >= STATION_ZOOM) this.lastFocusKey = `r${origin}`;
      else this.frame([origin, ...top], `r${origin}`);
      if (xv.status !== "loading") return;
      // ---- connections with changes: rounds arrive from the worker; each one updates the list and the map
      let chain = Promise.resolve();
      const t0 = performance.now();
      let lastLines: string | null = null;
      const onRound = (m: ReachRound) => {
        chain = chain.then(async () => {
          if (stale()) return;
          const st = this.xferState(m, reach, origin, xv);
          this.xferCache = { key, view: st.view, lines: lastLines, levels: st.levels };
          if (import.meta.env.DEV) console.debug(`[perf] transfers round ${m.round}: ${Math.round(performance.now() - t0)} ms since start`);
          this.panel.show({ ...reachView, xfer: st.view });
          // keep the lines of the previous round until this round's arrive
          await this.map.setHighlight({ emphasis: { ...emphasis, levels: st.levels }, corridors: reach.corridors, traffic: reach.traffic, ...(lastLines ? { xferJson: lastLines } : {}) });
        });
      };
      const onLines = (l: ReachLines) => {
        chain = chain.then(() => {
          if (stale()) return;
          lastLines = l.lines;
          if (this.xferCache?.key === key) this.xferCache.lines = l.lines;
          if (import.meta.env.DEV) console.debug(`[perf] transfers lines of round ${l.round}: ${Math.round(performance.now() - t0)} ms since start, ${(l.lines.length / 1e6).toFixed(1)} MB GeoJSON built in ${l.ms} ms`);
          this.map.setXferLines(l.lines);
        });
      };
      try {
        await this.transfers.reach(params, reach.corridors.keys(), onRound, onLines, originName);
        await chain;
      } catch (e) {
        if (!stale()) this.panel.show({ ...reachView, xfer: { ...xv, status: "error", message: (e as Error).message } });
      }
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
      if (!corridors.size && s.xfer.transfers > 0 && this.transfers.available) {
        await this.renderJourneys(cf, origin, originStation, dest, date, stale);
        return;
      }
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
    const legFiles: CityFile[] = [];
    let from = origin;
    let lastCf: CityFile = cf;
    for (const leg of s.legs) {
      const l: Leg = { ...leg, from };
      const lcf = from === origin ? cf : await loadCity(net.ds, from).catch(() => null);
      if (stale()) return;
      const info = lcf ? resolveLeg(lcf, net.ctx, l) : null;
      if (!info) break;
      infos.push(info);
      legFiles.push(lcf!);
      lastCf = lcf!;
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
    // every leg is one trip: one trip/day of width on its corridors; the rest of each run is drawn faded
    const traffic: CorridorTraffic = new Map();
    const context = new Map<number, number>();
    const focus = new Set<number>([origin]);
    for (const i of infos) {
      addTraffic(traffic, i.corridors, i.route.cat, 1);
      for (const c of i.outside) if (c >= 0) context.set(c, (context.get(c) ?? 0) | i.route.cat);
      focus.add(i.to);
    }
    const corridors = trafficCats(traffic);

    // ---- a journey with changes: every leg's stops in one list, with the changes between them
    if (s.schedule && infos.length > 1) {
      await this.renderJourney(infos, legFiles, origin, focus, corridors, traffic, context, stale);
      return;
    }

    // ---- the schedule of the last leg's trip: every stop, each with its onward connections
    if (s.schedule) {
      // the full stop list is only needed here: loaded on demand (only when the pattern leaves stops out)
      const pat = lastCf.patterns[lastCf.trips[last.leg.trip]?.[0] ?? -1];
      const sf = pat?.run !== undefined ? await loadSchedule(net.ds, last.leg.from) : null;
      if (stale()) return;
      const sched = tripSchedule(lastCf, net.ctx, last.leg, sf);
      if (!sched) {
        this.set({ schedule: undefined }, { replace: true });
        return;
      }
      for (const st of sched.stops) if (st.city >= 0) focus.add(st.city);
      await this.map.setHighlight({ emphasis: { focus: this.withCorridorEnds(focus, corridors), active: true, origin, dest: last.to }, corridors, traffic, context });
      if (stale()) return;
      const tag = [last.route.name, last.number].filter(Boolean).join(" ");
      document.title = `${tag} → ${last.headsign} – EuroTrainBusMap`;
      this.panel.show({ kind: "schedule", legs: infos, sched, windowMin: CONNECTION_WINDOW_MIN, onward: (stop, whole) => this.onwardCount(sched, stop, whole) });
      this.frame([...new Set([origin, ...sched.stops.flatMap((x) => (x.city >= 0 ? [x.city] : []))])], `t${encodeLegs(s.legs)}`);
      return;
    }

    let conns: Connection[] = [];
    try {
      const bcf = await loadCity(net.ds, last.to);
      if (stale()) return;
      conns = connections(
        bcf,
        net.ctx,
        s.filters,
        { ...arrivalOf(last), onlyStation: !s.wholeCity },
        CONNECTION_WINDOW_MIN,
      );
    } catch (e) {
      if (!stale()) this.panel.show({ kind: "error", message: `Could not load ${net.cities[last.to]!.name}. ${(e as Error).message}` });
      return;
    }
    for (const c of conns) for (const st of c.stops) focus.add(st.city);
    await this.map.setHighlight({ emphasis: { focus: this.withCorridorEnds(focus, corridors), active: true, origin, dest: last.to }, corridors, traffic, context });
    if (stale()) return;
    document.title = `Connections from ${s.wholeCity ? net.cities[last.to]!.name : stationName(net, last.arrStation)} – EuroTrainBusMap`;
    this.panel.show({ kind: "connections", legs: infos, conns, windowMin: CONNECTION_WINDOW_MIN, wholeCity: !!s.wholeCity });
    this.frame(
      [origin, ...infos.map((i) => i.to)],
      `j${infos.map((i) => i.to).join("-")}`,
    );
  }

  /**
   * The schedule of a whole journey: each leg's trip (stop lists loaded where a pattern leaves stops out), the
   * changes between them with the other departures of the same kind one could change to, the walks on the map.
   */
  private async renderJourney(
    infos: LegInfo[],
    files: CityFile[],
    origin: number,
    focus: Set<number>,
    corridors: Map<number, number>,
    traffic: CorridorTraffic,
    context: Map<number, number>,
    stale: () => boolean,
  ): Promise<void> {
    const net = this.net;
    const s = this.state;
    const scheds: TripSchedule[] = [];
    for (const [i, info] of infos.entries()) {
      const lcf = files[i]!;
      const pat = lcf.patterns[lcf.trips[info.leg.trip]?.[0] ?? -1];
      const sf = pat?.run !== undefined ? await loadSchedule(net.ds, info.leg.from).catch(() => null) : null;
      if (stale()) return;
      const sc = tripSchedule(lcf, net.ctx, info.leg, sf);
      if (!sc) {
        this.set({ schedule: undefined }, { replace: true });
        return;
      }
      scheds.push(sc);
    }
    const js = journeySchedule(scheds, (i) => walkMinutesIn(files[i]!, infos[i - 1]!.arrStation, infos[i]!.depStation))!;
    // departures one could change to: same kind of service from the change city towards the next leg's end
    const options: ChangeOption[][] = js.changes.map((c, k) => {
      const next = infos[k + 1]!;
      if (c.through) return [];
      const ccf = files[k + 1]!;
      const tz = cityTz(net, next.leg.from);
      const end = c.arrUtc + Math.max(CONNECTION_WINDOW_MIN, c.wait + 60) * 60000;
      const dates = [...new Set([localDate(c.arrUtc, tz), localDate(end, tz)])];
      const brand = (r: Route) => `${r.cat}|${legBrand("", r.cat, r) || r.name}`;
      try {
        const deps = dates.flatMap((d) => timetable(ccf, net.ctx, s.filters, next.to, d));
        return changeOptions(deps, {
          arrUtc: c.arrUtc,
          arrStation: c.arrStation,
          taken: { trip: next.leg.trip, date: next.leg.date, depUtc: next.depUtc },
          key: (d) => brand(d.route),
          takenKey: brand(next.route),
          transfer: (st) => transferMinutes(ccf, c.arrStation, st),
          windowMin: CONNECTION_WINDOW_MIN,
        });
      } catch {
        return [];
      }
    });
    for (const sc of scheds) for (const st of sc.stops) if (st.city >= 0) focus.add(st.city);
    const walks: [number, number][][] = [];
    for (const c of js.changes) {
      const a = net.file.stations[c.arrStation], b = net.file.stations[c.depStation];
      if (c.arrStation !== c.depStation && a && b) walks.push([[a.lon, a.lat], [b.lon, b.lat]]);
    }
    await this.map.setHighlight({ emphasis: { focus: this.withCorridorEnds(focus, corridors), active: true, origin, dest: infos[infos.length - 1]!.to }, corridors, traffic, context, walks });
    if (stale()) return;
    document.title = `${net.cities[origin]!.name} → ${net.cities[infos[infos.length - 1]!.to]!.name} – EuroTrainBusMap`;
    this.panel.show({
      kind: "journey",
      legs: infos,
      js,
      options,
      windowMin: CONNECTION_WINDOW_MIN,
      onward: (leg, stop, whole) => this.onwardCount(scheds[leg]!, stop, whole),
    });
    const shown = js.legs.flatMap((l) => l.sched.stops.slice(l.from, l.to + 1).flatMap((x) => (x.city >= 0 ? [x.city] : [])));
    this.frame([...new Set([origin, ...shown])], `J${encodeLegs(s.legs)}`);
  }

  /** The panel / map state of a reach-with-changes round. */
  private xferState(m: ReachRound, reach: Reach, origin: number, base: XferView): { view: XferView; levels: Map<number, number> } {
    const dests: XferDest[] = [];
    for (let c = 0; c < m.level.length; c++) {
      const lv = m.level[c]!;
      if (lv < 2 || c === origin || reach.dests.has(c)) continue;
      dests.push({ city: c, level: lv, minutes: m.minutes[c]!, via: m.via[c]!, cats: m.cats[c]! });
    }
    // on the map: the most important places reached with connections (thousands of extra labels would slow every frame)
    const cities = this.net.cities;
    const levels = new Map<number, number>();
    for (const d of [...dests].sort((a, b) => a.level - b.level || cities[b.city]!.importance - cities[a.city]!.importance).slice(0, MAP_XFER_CITIES)) levels.set(d.city, d.level);
    return { view: { ...base, status: m.done ? "done" : "loading", dests, rounds: m.round }, levels };
  }

  /**
   * A pair without a direct service, with connections enabled: the journeys with changes on the day, each
   * resolved to the legs of the boarding cities' timetables (route names, schedule view).
   */
  private async renderJourneys(cf: CityFile, origin: number, originStation: number | undefined, dest: number, date: string, stale: () => boolean): Promise<void> {
    const net = this.net;
    const s = this.state;
    const xs = s.xfer;
    const base = {
      kind: "journeys" as const,
      city: origin,
      ...(originStation !== undefined ? { station: originStation } : {}),
      dest,
      date,
      today: this.today(origin),
      settings: xs,
    };
    document.title = `${originStation !== undefined ? stationName(net, originStation) : net.cities[origin]!.name} → ${net.cities[dest]!.name} – EuroTrainBusMap`;
    this.panel.show({ ...base, status: "loading", rows: [] });
    this.frame([origin, dest], `p${origin}-${dest}`);
    const emphasis = { focus: new Set([origin, dest]), active: true, origin, dest, ...(originStation !== undefined ? { originStation } : {}) };
    await this.map.setHighlight({ emphasis, corridors: new Map() });
    const params: SearchParams = { origin, ...(originStation !== undefined ? { originStation } : {}), date, cats: s.filters.cats, ...xs, target: dest };
    let res: Awaited<ReturnType<TransferClient["journeys"]>>;
    try {
      res = await this.transfers.journeys(params, `${net.cities[origin]!.name}→${net.cities[dest]!.name}`);
      if (!res || stale()) return;
      await this.transfers.loadLines(res.chunks);
    } catch (e) {
      if (!stale()) this.panel.show({ ...base, status: "error", rows: [], message: (e as Error).message });
      return;
    }
    if (stale()) return;
    const rows: JourneyRow[] = [];
    const traffic: CorridorTraffic = new Map();
    const files = new Map<number, Promise<CityFile | null>>([[origin, Promise.resolve(cf)]]);
    const fileOf = (c: number) => {
      let p = files.get(c);
      if (!p) files.set(c, (p = loadCity(net.ds, c).catch(() => null)));
      return p;
    };
    // the best route options first, up to JOURNEY_ROWS journeys (each resolved against the boarding cities' timetables)
    const picked: Journey[] = [];
    for (const g of groupJourneys(res.journeys, (j) => j, () => [], net.ctx.stationCity)) {
      if (picked.length && picked.length + g.rows.length > JOURNEY_ROWS) break;
      picked.push(...g.rows);
    }
    for (const j of picked) rows.push(await this.journeyRow(j, fileOf, traffic));
    if (stale()) return;
    const corridors = trafficCats(traffic);
    this.panel.show({ ...base, status: "done", rows });
    await this.map.setHighlight({ emphasis: { ...emphasis, focus: this.withCorridorEnds(new Set([origin, dest]), corridors) }, corridors, traffic });
  }

  private async journeyRow(j: Journey, fileOf: (city: number) => Promise<CityFile | null>, traffic: CorridorTraffic): Promise<JourneyRow> {
    const ctx = this.net.ctx;
    const legs: JourneyRow["legs"] = [];
    let ok = true;
    for (const [i, jl] of j.legs.entries()) {
      const from = ctx.stationCity[jl.stations[jl.board]!]!;
      const lcf = await fileOf(from);
      // a change between two stations of the city: the walk the search assumed (shown with the change)
      const prev = j.legs[i - 1];
      const sa = prev?.stations[prev.alight], sb = jl.stations[jl.board]!;
      const walk = prev && sa !== sb && lcf ? walkMinutesIn(lcf, sa!, sb) : undefined;
      const leg = lcf ? matchLeg(lcf, jl, from) : null;
      const info = leg && lcf ? resolveLeg(lcf, ctx, leg) : null;
      if (!info) ok = false;
      const corr = info ? info.corridors : this.transfers.legCorridors(jl);
      addTraffic(traffic, corr, jl.cat, 1);
      legs.push({ raw: jl, ...(info ? { info } : {}), ...(walk !== undefined ? { walk } : {}) });
    }
    return { journey: j, legs, ...(ok ? { route: legs.map((l) => l.info!.leg) } : {}) };
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

  /** A departure of the pair timetable: show its trip's schedule (every stop). */
  chooseDeparture(d: Departure): void {
    this.set({ legs: [{ from: this.state.city!, trip: d.trip, date: d.serviceDate, board: d.board, alight: d.alight }], schedule: true });
  }

  /**
   * A stop of the schedule view: ride the last leg's trip to stop `stop` (pattern index) and show the onward
   * connections from there – from that station only, or with `wholeCity` from every station of its city.
   */
  chooseStop(stop: number, wholeCity: boolean, leg = this.state.legs.length - 1): void {
    const legs = this.state.legs;
    const l = legs[leg];
    if (!l || stop <= l.board) return;
    this.set({ legs: [...legs.slice(0, leg), { ...l, alight: stop }], schedule: undefined, wholeCity: wholeCity || undefined });
  }

  /** Another departure at the change before leg `leg` (the journey's last leg): the journey with it instead. */
  chooseOption(leg: number, o: ChangeOption): void {
    const legs = this.state.legs;
    if (leg !== legs.length - 1 || leg < 1) return;
    this.set({ legs: [...legs.slice(0, leg), { from: -1, trip: o.trip, date: o.serviceDate, board: o.board, alight: o.alight }], schedule: true, journey: this.state.journey });
  }

  /** Show the schedule of leg `i` (dropping the legs after it). */
  showSchedule(i: number): void {
    this.set({ legs: this.state.legs.slice(0, i + 1), schedule: true });
  }

  private onward = new Map<string, Promise<number>>();
  /**
   * Number of onward departures (CONNECTION_WINDOW_MIN after arriving, the trip itself excluded) from stop `stop`
   * of a schedule; loads that city's shard on first use. Cached per trip, stop, scope and mode filter.
   */
  onwardCount(sched: TripSchedule, stop: number, whole: boolean): Promise<number> {
    const st = sched.stops[stop];
    if (!st || st.arrUtc === null) return Promise.resolve(0);
    const f = this.state.filters;
    const key = `${sched.leg.from}|${sched.leg.trip}|${sched.leg.date}|${stop}|${whole ? 1 : 0}|${f.cats}`;
    let p = this.onward.get(key);
    if (!p) {
      const arrival = { city: st.city, station: st.station, utc: st.arrUtc, routeName: sched.route.name, ...(sched.number !== undefined ? { number: sched.number } : {}), onlyStation: !whole };
      p = loadCity(this.net.ds, st.city).then((bcf) => connections(bcf, this.net.ctx, f, arrival, CONNECTION_WINDOW_MIN).filter((c) => !c.through).length);
      p.catch(() => this.onward.delete(key));
      this.onward.set(key, p);
    }
    return p;
  }

  chooseConnection(c: Connection, stop: OnwardStop, fromCity: number): void {
    const v = stop.via ?? { trip: c.trip, serviceDate: c.serviceDate, board: c.board };
    const leg: Leg = { from: fromCity, trip: v.trip, date: v.serviceDate, board: v.board, alight: stop.stop };
    this.set({ legs: [...this.state.legs, leg] });
  }

  /** A journey with changes (journeys view): its legs, showing the last leg's schedule. */
  chooseJourney(legs: Leg[]): void {
    if (legs.length) this.set({ legs, schedule: true, journey: legs.length > 1 || undefined });
  }

  /** New settings for connections with changes (the dialog); the minimum transfer and maximum wait are remembered. */
  setTransfers(x: TransferSettings): void {
    storeSettings(x);
    this.set({ xfer: x }, { replace: true });
  }

  shiftDate(days: number): void {
    const s = this.state;
    if (s.city === undefined) return;
    const d = addDays(s.date ?? this.today(s.city), days);
    this.set({ date: d }, { replace: true });
  }
}

/** The arrival of a leg, as the start of onward connections. */
function arrivalOf(l: LegInfo): Arrival {
  return { city: l.to, station: l.arrStation, utc: l.arrUtc, routeName: l.route.name, ...(l.number !== undefined ? { number: l.number } : {}) };
}
