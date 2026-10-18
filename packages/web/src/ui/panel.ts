/** Side panel (desktop) / bottom sheet (mobile): search, mode chips and content views. */
import { CAVEAT_FLAGS, CYCLE_BUFFER_MIN, CYCLE_MAX_MIN, CYCLE_M_PER_MIN, Cat, StopLimit, WALK_MAX_MIN, changeAt, changeOf, distanceM, transitModeLabel, walkDistanceM, walkMinutes, type ChangeBy } from "@etbm/shared";
import { cityTransit } from "../data/load.ts";
import { cityTz, slugify, stationName, type Net } from "../data/net.ts";
import { addDays, formatDateShort, lastDate } from "../logic/calendar.ts";
import type { Connection, OnwardStop } from "../logic/connections.ts";
import { ALL_CATS, CAT_LABEL, CAT_ORDER, localOn, type Filters } from "../logic/filters.ts";
import type { Leg, LegInfo } from "../logic/journey.ts";
import type { Reach } from "../logic/reach.ts";
import { MAX_TRANSFERS, type Journey, type JourneyLeg, type TransferSettings } from "../logic/transfer.ts";
import type { ScheduleStop, TripSchedule } from "../logic/schedule.ts";
import type { ChangeOption, JourneySchedule } from "../logic/journeyschedule.ts";
import type { Departure } from "../logic/timetable.ts";
import { fmtDuration, fmtTime, localDate, toLocal } from "../logic/tz.ts";
import { h, icon } from "./dom.ts";
import { shortStationName } from "../map/features.ts";
import { caveatBadge, caveatNote, fmtKm, routeBadge, routeDisplayName, routeTag, timeAt, timeEl } from "./format.ts";
import { localIcon, modeIcon } from "./icons.ts";
import { datePicker, focusPicker } from "./datepicker.ts";
import { depCats, depsWith, type StationDeps } from "../logic/stations.ts";
import { groupJourneys, legBrand, type JourneyGroup } from "../logic/journeygroups.ts";
import { legsKey } from "../logic/tracks.ts";

export type View =
  | { kind: "intro" }
  | { kind: "loading"; title: string }
  | { kind: "error"; message: string }
  | {
      kind: "reach";
      city: number;
      /** the origin narrowed to this station of the city */
      station?: number;
      reach: Reach;
      /** departures/day by mode per station of the city (unfiltered; greys out stations without departures) */
      stationDeps: Map<number, StationDeps>;
      /** connections with changes (settings, travel day, destinations found so far) */
      xfer: XferView;
    }
  | {
      kind: "journeys";
      city: number;
      station?: number;
      dest: number;
      date: string;
      today: string;
      settings: TransferSettings;
      status: "loading" | "done" | "error";
      rows: JourneyRow[];
      message?: string;
      /**
       * Continuing a journey: the journeys from `city` (where `legs`, from `origin`, end) to `dest`, leaving after
       * the arrival; a journey picked is appended to the legs.
       */
      cont?: { legs: LegInfo[]; origin: number };
    }
  | {
      kind: "timetable";
      city: number;
      station?: number;
      dest: number;
      date: string;
      today: string;
      deps: Departure[];
      next: string[];
      inHorizon: boolean;
      hasService: boolean;
      /** origin-local dates with departures (date picker dots); computed on first use */
      serviceDays: () => ReadonlySet<string>;
    }
  | {
      kind: "schedule";
      legs: LegInfo[];
      /** the last leg's trip, every stop */
      sched: TripSchedule;
      windowMin: number;
      /** onward departures from a stop (pattern index): from its station, or `whole` from every station of its city; loads lazily */
      onward: (stop: number, whole: boolean) => Promise<number>;
    }
  | {
      kind: "journey";
      legs: LegInfo[];
      /** every leg's trip and the changes between them */
      js: JourneySchedule;
      /** per change: the departures of the same kind one could change to (the taken one marked) */
      options: ChangeOption[][];
      windowMin: number;
      /** onward departures from stop `stop` of leg `leg`'s trip (see the schedule view) */
      onward: (leg: number, stop: number, whole: boolean) => Promise<number>;
    }
  | {
      kind: "connections";
      legs: LegInfo[];
      /** the useful ones: places the journey does not already cover */
      conns: Connection[];
      /** every departure, also those (and the stops) left out because the journey covers them: shown on request */
      all: Connection[];
      windowMin: number;
      wholeCity: boolean;
      /** the departures and stops along the journey (`all` minus `conns`) are listed and drawn too */
      covered: boolean;
    };

/**
 * Where the shown view sits (the panel's top row): the views above it, the farthest first, each a link there (the last
 * one is where Back and Esc go); the edits of the journey that can be undone or redone (what they did).
 */
export interface Nav {
  crumbs: { label: string; title: string; go: () => void }[];
  undo?: string;
  redo?: string;
  /** the edit just made: a notice says what it did */
  notice?: string;
}

/** A place reached only with changes. */
export interface XferDest {
  city: number;
  /** 2 = one connection, 3 = two */
  level: number;
  minutes: number;
  /** change city of the fastest journey */
  via: number;
  cats: number;
}

export interface XferView {
  settings: TransferSettings;
  date: string;
  today: string;
  status: "off" | "loading" | "done" | "error" | "unavailable";
  dests: XferDest[];
  /** search rounds completed (1 = direct trips of the day) */
  rounds: number;
  message?: string;
}

/** A journey with changes; `route` is set when every leg was found in the boarding city's timetable. */
export interface JourneyRow {
  journey: Journey;
  /**
   * `walk`: minutes walked (or cycled, `by` "bike", or by local transport, `by` "transit" with the TransitMode bits
   * `modes`) between the two stations of the change before this leg
   */
  legs: { raw: JourneyLeg; info?: LegInfo; walk?: number; by?: ChangeBy; modes?: number; /** corridors ridden (map tracks) */ corridors?: number[] }[];
  route?: Leg[];
}

export interface PanelActions {
  state: { city?: number; station?: string; dest?: number; filters: Filters; legs: Leg[]; extend?: number };
  set(patch: Record<string, unknown>, opts?: { replace?: boolean }): void;
  clickCity(id: number): void;
  clickStation(id: number, city: number, name: string): void;
  back(): void;
  /** Where the shown view sits, for its top row (see Nav). */
  nav(): Nav;
  undo(): void;
  redo(): void;
  /** List (and draw) the onward departures only serving places along the journey too. */
  showCovered(on: boolean): void;
  chooseDeparture(d: Departure): void;
  chooseConnection(c: Connection, stop: OnwardStop, fromCity: number): void;
  /** Ride leg `leg` (default: the last) to stop `stop` and show the onward connections from there. */
  chooseStop(stop: number, wholeCity: boolean, leg?: number): void;
  /** Another departure at the change before the journey's last leg `leg`. */
  chooseOption(leg: number, o: ChangeOption): void;
  chooseJourney(legs: Leg[]): void;
  /** A journey of the continuation view: appended to the shown journey (`stay`: its first leg rides the last one on). */
  chooseExtension(legs: Leg[], stay?: boolean): void;
  /** Ride the journey's last leg on to its later stop `stop`, or board its first leg earlier, at `stop` (departing `depUtc`); `city`: the new end. */
  extendLeg(end: "first" | "last", stop: number, city: number, depUtc?: number): void;
  setTransfers(x: TransferSettings): void;
  showSchedule(leg: number): void;
  /** The journey so far (connections view): all its legs' stops and changes; back returns to the connections. */
  reviewJourney(): void;
  /** An item of the list (`data-hl`: a route option, destination, departure, leg) is hovered (null: none): its tracks on the map. */
  hoverItem(key: string | null): void;
  shiftDate(days: number): void;
  /** Remove the first or last leg of the shown journey (`label`: the vehicle, for the undo notice). */
  removeLeg(end: "first" | "last", label: string): void;
  today(city: number): string;
}

type SheetMode = "peek" | "half" | "full";

export class Panel {
  actions!: PanelActions;
  private body: HTMLElement;
  private sheet: HTMLElement;
  private chips: HTMLElement;
  private search: HTMLInputElement;
  private listbox: HTMLUListElement;
  private mode: SheetMode = "peek";
  private lastKind = "";
  private matches: number[] = [];
  private active = -1;
  onLayout?: () => void;
  /** How changes between stations are made (the transfer settings), for the changes shown without a search result. */
  changeBy: ChangeBy = "walk";

  constructor(
    private net: Net,
    root: HTMLElement,
  ) {
    this.sheet = root.querySelector<HTMLElement>(".sheet")!;
    this.body = root.querySelector<HTMLElement>(".sheet-body")!;
    this.chips = root.querySelector<HTMLElement>(".chips")!;
    this.search = root.querySelector<HTMLInputElement>("#search")!;
    this.listbox = root.querySelector<HTMLUListElement>("#search-list")!;
    root.querySelector(".sheet-handle")!.addEventListener("click", () => this.setMode(this.mode === "peek" ? "half" : this.mode === "half" ? "full" : "peek"));
    this.buildChips();
    this.bindSearch();
    this.bindTrackHover();
    this.setMode("peek");
  }

  // ---- sheet ------------------------------------------------------------------

  private setMode(m: SheetMode): void {
    this.mode = m;
    this.sheet.dataset.mode = m;
    const handle = this.sheet.querySelector(".sheet-handle")!;
    handle.setAttribute("aria-label", m === "full" ? "Collapse panel" : "Expand panel");
    handle.setAttribute("aria-expanded", String(m !== "peek"));
    this.onLayout?.();
  }

  /** Target height of the bottom sheet on mobile (for map padding; ignores the CSS transition). */
  sheetHeight(): number {
    const vh = innerHeight;
    return Math.min(this.mode === "peek" ? 150 : this.mode === "half" ? vh * 0.48 : vh * 0.86, vh * 0.88);
  }

  // ---- tracks on the map ----------------------------------------------------------

  private hoverKey: string | null = null;
  private scrollTimer = 0;

  /** Hovering an item with `data-hl` (mouse only) shows its tracks on the map. */
  private bindTrackHover(): void {
    const set = (key: string | null) => {
      if (key === this.hoverKey) return;
      this.hoverKey = key;
      this.actions?.hoverItem(key);
    };
    this.body.addEventListener("pointerover", (e) => {
      if (e.pointerType !== "mouse") return;
      set((e.target as Element).closest<HTMLElement>("[data-hl]")?.dataset.hl ?? null);
    });
    this.body.addEventListener("pointerleave", () => set(null));
  }

  /**
   * Mark the items whose tracks are hovered on the map (`keys`: their data-hl; null: none). With `scroll`, the
   * first one is scrolled into view when it is outside the list (after a short pause, so passing over tracks
   * does not jump the list around).
   */
  markTracks(keys: readonly string[] | null, scroll = true): void {
    clearTimeout(this.scrollTimer);
    for (const el of this.body.querySelectorAll(".is-track-hl")) el.classList.remove("is-track-hl");
    this.body.classList.toggle("has-track-hl", !!keys?.length);
    if (!keys?.length) return;
    const want = new Set(keys);
    const els = [...this.body.querySelectorAll<HTMLElement>("[data-hl]")].filter((el) => want.has(el.dataset.hl!));
    for (const el of els) el.classList.add("is-track-hl");
    // options not rendered yet (behind "more options"): the button is marked
    if (els.length < want.size) this.body.querySelector(".jr-more")?.classList.add("is-track-hl");
    const first = els[0];
    // the bottom sheet lowered (phones): the list stays where it is
    if (!scroll || !first || (this.mode === "peek" && matchMedia("(max-width: 719px)").matches)) return;
    this.scrollTimer = window.setTimeout(() => {
      const b = this.body.getBoundingClientRect(), r = first.getBoundingClientRect();
      if (r.top < b.top || r.top > b.bottom - 40) first.scrollIntoView({ block: r.height > b.height * 0.6 ? "start" : "nearest", behavior: "smooth" });
    }, 220);
  }

  // ---- chips ------------------------------------------------------------------

  /** A mode toggle: a check box, the mode's pictogram and its name. */
  private chip(attrs: Record<string, string>, pictogram: SVGSVGElement, label: string, onclick: () => void): HTMLElement {
    return h(
      "button",
      { type: "button", class: "chip", "aria-pressed": "true", ...attrs, onclick },
      h("span", { class: "chip-check", "aria-hidden": "true" }, icon("check", 12)),
      pictogram,
      label,
    );
  }

  private buildChips(): void {
    const items: HTMLElement[] = CAT_ORDER.map((cat) =>
      this.chip({ "data-cat": String(cat), style: `--c:var(--cat-${cat})`, title: `Show or hide ${CAT_LABEL[cat]!.toLowerCase()}` }, modeIcon(cat, 16), CAT_LABEL[cat]!, () => {
        const f = this.actions.state.filters;
        this.actions.set({ filters: { ...f, cats: f.cats ^ cat } });
      }),
    );
    const local = this.chip({ class: "chip chip-local", "data-local": "1", style: "--c:var(--urban)", title: "Metro, tram and city bus lines, shown when zoomed in" }, localIcon(16), "Local transport", () => {
      const f = this.actions.state.filters;
      this.actions.set({ filters: { ...f, local: !localOn(f) } });
    });
    items.push(local);
    this.chips.replaceChildren(...items);
  }

  /** The local-transport chip only makes sense when the build has the layer. */
  private localAvailable = false;
  showLocalChip(on: boolean): void {
    this.localAvailable = on;
    const b = this.chips.querySelector<HTMLElement>(".chip-local");
    if (b) b.hidden = !on;
  }

  setFilters(f: Filters): void {
    for (const b of this.chips.querySelectorAll<HTMLButtonElement>(".chip")) {
      if (b.dataset.local) {
        b.setAttribute("aria-pressed", String(localOn(f)));
        continue;
      }
      const cat = Number(b.dataset.cat);
      b.setAttribute("aria-pressed", String((f.cats & cat) !== 0));
    }
  }

  // ---- search -------------------------------------------------------------------

  private bindSearch(): void {
    const update = () => {
      if (!slugify(this.search.value)) {
        this.closeList();
        return;
      }
      this.matches = this.matchCities(this.search.value, 8);
      this.active = this.matches.length ? 0 : -1;
      this.renderList();
    };
    this.search.addEventListener("input", update);
    this.search.addEventListener("focus", update);
    this.search.addEventListener("blur", () => setTimeout(() => this.closeList(), 150));
    this.search.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!this.matches.length) return;
        e.preventDefault();
        this.active = (this.active + (e.key === "ArrowDown" ? 1 : -1) + this.matches.length) % this.matches.length;
        this.renderList();
      } else if (e.key === "Enter") {
        const id = this.matches[this.active];
        if (id !== undefined) this.pick(id);
      } else if (e.key === "Escape") {
        this.search.value = "";
        this.closeList();
      }
    });
  }

  /** Cities whose name contains `text` (word starts first, then by importance), at most `limit`. */
  private matchCities(text: string, limit: number, skip?: (city: number) => boolean): number[] {
    const q = slugify(text);
    if (!q) return [];
    const scored: [number, number][] = [];
    this.net.nameKey.forEach((n, i) => {
      const idx = n.indexOf(q);
      if (idx < 0 || skip?.(i)) return;
      const c = this.net.cities[i]!;
      scored.push([i, (idx === 0 ? 2 : idx > 0 && n[idx - 1] === "-" ? 1 : 0) + c.importance]);
    });
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, limit).map((s) => s[0]);
  }

  /**
   * Continue the shown journey from `from`, where it ends: a map tap on another city does it; this field finds the
   * city by name. Both open the journeys from `from` to that city after the arrival.
   */
  private continueBox(from: number, origin: number): HTMLElement {
    const n = this.net;
    const name = n.cities[from]?.name ?? "";
    const input = h("input", { type: "search", class: "dest-filter", placeholder: "Continue to… (city)", autocomplete: "off", spellcheck: "false", "aria-label": `Continue the journey from ${name} to a city` }) as HTMLInputElement;
    const list = h("ul", { class: "cont-list", hidden: true });
    let matches: number[] = [];
    const go = (id: number) => this.actions.set({ extend: id });
    const update = () => {
      matches = this.matchCities(input.value, 6, (c) => c === from || c === origin);
      list.replaceChildren(
        ...matches.map((id) => {
          const c = n.cities[id]!;
          return h("li", null, h("button", { type: "button", class: "cont-opt", onclick: () => go(id) }, h("span", { class: "opt-name" }, c.name), h("span", { class: "opt-meta" }, c.country)));
        }),
      );
      if (!matches.length && input.value.trim()) list.append(h("li", { class: "opt-empty" }, "No matching city"));
      list.hidden = !list.childElementCount;
    };
    input.addEventListener("input", update);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && matches[0] !== undefined) go(matches[0]);
      else if (e.key === "Escape" && input.value) {
        e.preventDefault();
        input.value = "";
        update();
      }
    });
    return h(
      "div",
      { class: "cont-box" },
      h("p", { class: "cont-title" }, icon("next", 14), ` Continue from ${name}`),
      h("p", { class: "small muted" }, `Tap a city on the map, or name one: journeys from ${name} after this arrival, with your transfer settings – also beyond the number of changes searched at once.`),
      input,
      list,
    );
  }

  private renderList(): void {
    this.listbox.replaceChildren(
      ...this.matches.map((id, i) => {
        const c = this.net.cities[id]!;
        return h(
          "li",
          {
            role: "option",
            id: `opt-${id}`,
            "aria-selected": String(i === this.active),
            onmousedown: (e: Event) => {
              e.preventDefault();
              this.pick(id);
            },
          },
          h("span", { class: "opt-name" }, c.name),
          h("span", { class: "opt-meta" }, c.country),
        );
      }),
    );
    if (!this.matches.length && this.search.value) this.listbox.append(h("li", { class: "opt-empty", role: "presentation" }, "No matching city"));
    this.listbox.hidden = !this.listbox.childElementCount;
    this.search.setAttribute("aria-expanded", String(!this.listbox.hidden));
    if (this.active >= 0) this.search.setAttribute("aria-activedescendant", `opt-${this.matches[this.active]}`);
    else this.search.removeAttribute("aria-activedescendant");
  }

  private closeList(): void {
    this.listbox.hidden = true;
    this.search.setAttribute("aria-expanded", "false");
    this.search.removeAttribute("aria-activedescendant");
  }

  private pick(id: number): void {
    this.search.value = "";
    this.closeList();
    const s = this.actions.state;
    if (s.city !== undefined && s.dest === undefined && id !== s.city) this.actions.set({ dest: id, legs: [] });
    else this.actions.set({ city: id, dest: undefined, legs: [] });
    this.focusHeading = true;
  }

  // ---- views ------------------------------------------------------------------

  private focusHeading = false;

  show(v: View): void {
    if (v.kind === "loading" && this.lastKind !== "intro" && this.lastKind !== "") {
      this.body.setAttribute("aria-busy", "true");
      return;
    }
    this.viewCleanup?.();
    this.viewCleanup = null;
    this.body.removeAttribute("aria-busy");
    const content = this.view(v);
    this.body.replaceChildren(...content);
    this.sheet.dataset.view = v.kind;
    if (v.kind !== "loading") {
      if (this.lastKind === "intro" || this.lastKind === "" || this.lastKind === "loading") {
        if (v.kind !== "intro") this.setMode("half");
      }
      if (v.kind === "intro") this.setMode("peek");
      if (v.kind !== this.lastKind) this.body.scrollTop = 0;
      this.lastKind = v.kind;
    }
    if (this.focusHeading) {
      this.focusHeading = false;
      this.body.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
    }
  }

  private view(v: View): Node[] {
    switch (v.kind) {
      case "intro":
        return this.intro();
      case "loading":
        return [this.header(v.title, null), h("p", { class: "muted pad" }, "Loading timetable…")];
      case "error":
        return [this.header("Something went wrong", null), h("p", { class: "pad error" }, v.message)];
      case "reach":
        return this.reach(v);
      case "journeys":
        return this.journeys(v);
      case "timetable":
        return this.timetable(v);
      case "schedule":
        return this.schedule(v);
      case "journey":
        return this.journey(v);
      case "connections":
        return this.connections(v);
    }
  }

  /**
   * The view's heading. With `back`, a top row first: Back (one view up, see Nav), the breadcrumbs of the views above,
   * Undo / Redo of the journey's edits when there are any, Close.
   */
  private header(title: string | Node, sub: string | Node | null, opts: { back?: boolean; extra?: Node } = {}): HTMLElement {
    const nav = opts.back ? this.actions.nav() : null;
    const close = h(
      "button",
      { type: "button", class: "icon-btn", "aria-label": "Close", title: "Close", onclick: () => this.actions.set({ city: undefined, dest: undefined, legs: [], date: undefined }) },
      icon("close"),
    );
    const titleEl = h("div", { class: "view-title" }, h("h2", { tabindex: "-1" }, title), sub ? h("p", { class: "sub" }, sub) : null);
    if (!nav?.crumbs.length) return h("div", { class: "view-head" }, titleEl, opts.extra ?? null, close);
    const up = nav.crumbs[nav.crumbs.length - 1]!;
    const edits = nav.undo !== undefined || nav.redo !== undefined;
    const row = h(
      "nav",
      { class: "view-nav", "aria-label": "Views" },
      h("button", { type: "button", class: "icon-btn nav-back", "aria-label": `Back: ${up.title}`, title: `Back: ${up.title} (Esc)`, onclick: () => this.actions.back() }, icon("back")),
      h(
        "ol",
        { class: "nav-crumbs" },
        nav.crumbs.map((c, i) =>
          h(
            "li",
            null,
            i ? h("span", { class: "nav-sep", "aria-hidden": "true" }, "›") : null,
            h("button", { type: "button", class: "nav-crumb", title: c.title, onclick: c.go }, c.label),
          ),
        ),
      ),
      edits
        ? h(
            "span",
            { class: "nav-edits", role: "group", "aria-label": "Edits of the journey" },
            h("button", { type: "button", class: "icon-btn", "aria-label": nav.undo ? `Undo: ${nav.undo}` : "Undo", title: nav.undo ? `Undo: ${nav.undo} (Ctrl+Z)` : "Nothing to undo", disabled: nav.undo === undefined, onclick: () => this.actions.undo() }, icon("undo")),
            h("button", { type: "button", class: "icon-btn", "aria-label": nav.redo ? `Redo: ${nav.redo}` : "Redo", title: nav.redo ? `Redo: ${nav.redo} (Ctrl+Shift+Z)` : "Nothing to redo", disabled: nav.redo === undefined, onclick: () => this.actions.redo() }, icon("redo")),
          )
        : null,
      close,
    );
    // the edit just made: what it did, and the way back (also the Undo button above)
    return h(
      "div",
      { class: "view-head has-nav" },
      row,
      titleEl,
      opts.extra ?? null,
      nav.notice ? h("p", { class: "undo-note", role: "status" }, h("span", null, nav.notice), h("button", { type: "button", class: "link small", onclick: () => this.actions.undo() }, "Undo")) : null,
    );
  }

  private intro(): Node[] {
    const n = this.net;
    const end = lastDate(n.cal);
    const f = this.actions?.state.filters;
    // modes switched off at the top are greyed out here too
    const item = (on: boolean, pictogram: SVGSVGElement, line: HTMLElement, label: string, wide = false) =>
      h(
        "li",
        { class: `${wide ? "legend-wide" : ""}${on ? "" : " is-off"}`.trim() || undefined, title: on ? null : `${label}: hidden – switch it on above` },
        pictogram,
        line,
        label,
      );
    return [
      h(
        "div",
        { class: "intro" },
        h("h2", { tabindex: "-1" }, "Where can you go by train and bus?"),
        h(
          "p",
          null,
          "Direct trains and buses, and connections with changes: tap a city to see every place you can reach without changing, pick a second city for its timetable, then select a departure to see all its stops and the onward connections from each.",
        ),
        h(
          "ul",
          { class: "legend", "aria-label": "Transport modes on the map" },
          CAT_ORDER.map((cat) => item(!f || (f.cats & cat) !== 0, modeIcon(cat, 16), h("span", { class: "legend-line", style: `--c:var(--cat-${cat})` }), CAT_LABEL[cat]!)),
          this.localAvailable
            ? item(!f || localOn(f), localIcon(16), h("span", { class: "legend-line thin", style: "--c:var(--urban)" }), "Metro, tram, city bus – zoom in", true)
            : null,
        ),
        h(
          "p",
          { class: "muted small" },
          `${n.cities.length.toLocaleString("en")} cities · ${n.counts.corridors.toLocaleString("en")} corridors · timetables ${formatDateShort(n.cal.startDate)} – ${formatDateShort(end)}`,
        ),
      ),
    ];
  }

  private reach(v: Extract<View, { kind: "reach" }>): Node[] {
    const n = this.net;
    const { city, reach: r, station, stationDeps } = v;
    const x = v.xfer;
    const c = n.cities[city]!;
    const byImportance = <T extends { city: number; minutes: number }>(a: T, b: T) => n.cities[b.city]!.importance - n.cities[a.city]!.importance || a.minutes - b.minutes;
    const dests = [...r.dests.values()].sort(byImportance);
    const count = `${dests.length} direct destination${dests.length === 1 ? "" : "s"}`;
    const out: Node[] = station !== undefined ? [this.header(stationName(n, station), `${count} from this station · ${c.name}`)] : [this.header(c.name, count)];
    out.push(this.xferSummary(x));
    if (c.stations.length > 1) out.push(this.stationsLine(city, station, stationDeps));
    const xd = x.status === "off" ? [] : [...x.dests].sort(byImportance);
    if (!dests.length && !xd.length) {
      out.push(h("p", { class: "pad muted" }, x.status === "loading" ? "No direct services from here with the selected modes." : "No services from here with the selected modes."));
      return out;
    }
    type Row = { city: number; minutes: number; cats: number; via?: number };
    const row = (d: Row) => {
      const dc = n.cities[d.city]!;
      return h(
        "li",
        { "data-q": slugify(dc.name), ...(d.via === undefined ? { "data-hl": `c:${d.city}` } : {}) },
        h(
          "button",
          { type: "button", class: `dest${d.via !== undefined ? " dest--xfer" : ""}`, onclick: () => this.actions.set({ dest: d.city, legs: [] }) },
          h("span", { class: "dest-cats" }, CAT_ORDER.filter((k) => d.cats & k).map((k) => modeIcon(k, 14, CAT_LABEL[k]))),
          h(
            "span",
            { class: "dest-name" },
            dc.name,
            dc.country !== c.country ? h("span", { class: "cc" }, dc.country) : null,
            d.via !== undefined && d.via >= 0 ? h("span", { class: "dest-via" }, `via ${n.cities[d.via]?.name ?? "?"}`) : null,
          ),
          // a trip whose feed has no real times between two cities gives 0 minutes: show no duration rather than "0 min"
          h("span", { class: "dest-time" }, d.minutes >= 1 ? [h("span", { class: "muted small" }, "from "), fmtDuration(d.minutes)] : null),
        ),
      );
    };
    // groups: per level (direct, 1 connection, 2 …) major places first, then everything else (still by importance)
    const levels: [string, Row[]][] = [[x.status === "off" ? "" : " (direct)", dests]];
    for (let lv = 2; lv <= 1 + x.settings.transfers; lv++) {
      const items = xd.filter((d) => d.level === lv);
      if (items.length) levels.push([` (with ${connWord(lv - 1)})`, items]);
    }
    const all = levels.flatMap(([, items]) => items);
    const groups: [string, Row[]][] = [];
    for (const [suffix, items] of levels) {
      const major = items.filter((d) => n.cities[d.city]!.importance >= 0.6);
      const minor = items.filter((d) => n.cities[d.city]!.importance < 0.6);
      if (major.length && minor.length && (items.length > 20 || levels.length > 1)) groups.push([`Major destinations${suffix}`, major], [`Other places${suffix} · ${minor.length}`, minor]);
      else if (items.length) groups.push([levels.length > 1 ? (major.length ? `Major destinations${suffix}` : `Other places${suffix}`) : "", items]);
    }
    // the mode icon column is as wide as the most modes any destination has
    const ncats = Math.max(1, ...all.map((d) => CAT_ORDER.filter((k) => d.cats & k).length));
    const lists = groups.map(([title, items]) =>
      h(
        "section",
        { class: "dest-group", style: `--ncats:${ncats}` },
        title ? h("h3", { class: "section" }, title) : null,
        this.lazyList(h("ul", { class: "dest-list", "aria-label": title || `Direct destinations from ${c.name}` }), items, row, items[0]?.via !== undefined ? 300 : Infinity),
      ),
    );
    const empty = h("p", { class: "pad muted", hidden: true }, "No destination matches.");
    if (all.length > 12) {
      const input = h("input", {
        type: "search",
        class: "dest-filter",
        placeholder: `Filter ${all.length} destinations…`,
        "aria-label": "Filter destinations",
        oninput: (e: Event) => {
          const q = slugify((e.target as HTMLInputElement).value);
          // a filter searches every place: render the capped lists completely
          if (q) for (const ul of this.body.querySelectorAll<HTMLElement & { expand?: () => void }>(".dest-list")) ul.expand?.();
          let shown = 0;
          for (const li of this.body.querySelectorAll<HTMLLIElement>(".dest-list li:not(.dest-more)")) {
            const hit = !q || li.dataset.q!.includes(q);
            li.hidden = !hit;
            if (hit) shown++;
          }
          for (const sec of this.body.querySelectorAll<HTMLElement>(".dest-group")) sec.hidden = !sec.querySelector("li:not([hidden])");
          empty.hidden = shown > 0;
        },
      });
      out.push(h("div", { class: "dest-filter-wrap" }, input));
    }
    out.push(...lists, empty);
    return out;
  }

  /**
   * "{n} destinations with {k} same-day connection(s)" with the pencil that opens the settings (number of
   * connections, minimum transfer, maximum wait); with connections on, the travel day under it.
   */
  private xferSummary(x: XferView): HTMLElement {
    const k = x.settings.transfers;
    const edit = h(
      "button",
      { type: "button", class: "icon-btn xfer-edit", "aria-label": "Connections with changes: settings", title: "Connections, minimum transfer time, maximum wait and walking, cycling or local transport between stations", onclick: () => this.openTransfers(x.settings) },
      icon("edit", 16),
    );
    const kind = x.settings.maxWait === null ? "same-day " : "";
    const lines: (Node | string)[] = [];
    if (x.status === "off") lines.push(h("span", { class: "muted" }, "Direct only – tap the pencil to add destinations with connections"));
    else if (x.status === "unavailable") lines.push(h("span", { class: "muted" }, "Connections with changes are not available for this data build."));
    else if (x.status === "error") lines.push(h("span", { class: "error" }, `Could not search connections: ${x.message ?? ""}`));
    else {
      for (let lv = 2; lv <= 1 + k; lv++) {
        const m = x.dests.filter((d) => d.level === lv).length;
        const pending = x.status === "loading" && x.rounds < lv;
        lines.push(
          h(
            "span",
            { class: `xfer-count${pending ? " is-loading" : ""}` },
            pending ? `Searching destinations with ${lv - 1} ${kind}${connNoun(lv - 1)}…` : `${m} destination${m === 1 ? "" : "s"} with ${lv - 1} ${kind}${connNoun(lv - 1)}`,
          ),
        );
      }
    }
    const rules =
      x.status === "off" || x.status === "unavailable"
        ? null
        : h(
            "span",
            { class: "xfer-rules muted small" },
            `min. ${x.settings.minTransfer} min to change${x.settings.maxWait === null ? ", same day" : `, max. ${fmtWait(x.settings.maxWait)} wait`}${byRule(x.settings.changeBy)}`,
          );
    return h(
      "div",
      { class: "xfer" },
      h("div", { class: "xfer-line" }, h("div", { class: "xfer-text" }, lines, rules), edit),
      x.status === "off" || x.status === "unavailable" ? null : this.dateBar(x.date, x.today, () => new Set(), true),
    );
  }

  /** Settings dialog of connections with changes. */
  private openTransfers(cur: TransferSettings): void {
    document.querySelector("dialog.xfer-dialog")?.remove();
    const dlg = h("dialog", { class: "xfer-dialog", "aria-labelledby": "xfer-title" });
    let k = cur.transfers;
    const kBtns = [0, 1, 2].filter((i) => i <= MAX_TRANSFERS).map((i) =>
      h(
        "button",
        { type: "button", class: "scope-opt", "aria-pressed": String(i === k), onclick: () => {
          k = i;
          for (const b of kBtns) b.setAttribute("aria-pressed", String(b === kBtns[i]));
          note.hidden = k < 2;
        } },
        i === 0 ? "Direct only" : connWord(i),
      ),
    );
    let by: ChangeBy = cur.changeBy ?? "walk";
    const byOpts: [ChangeBy, string][] = [["walk", "Walk"], ["bike", "Cycle"], ["transit", "Transit"]];
    const byBtns = byOpts.map(([v, label]) =>
      h(
        "button",
        { type: "button", class: "scope-opt", "aria-pressed": String(v === by), onclick: () => {
          by = v;
          byBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(byOpts[i]![0] === by)));
        } },
        icon(v === "transit" ? "transit" : v, 14),
        ` ${label}`,
      ),
    );
    const note = h("p", { class: "small muted xfer-note", hidden: k < 2 }, "Two connections reach most of Europe from a big city and take a few seconds to compute (and several MB of timetable data).");
    const min = h("input", { type: "number", id: "xfer-min", min: "0", max: "120", step: "1", inputmode: "numeric", value: String(cur.minTransfer) });
    const step = (d: number) => {
      min.value = String(Math.max(0, Math.min(120, (Number(min.value) || 0) + d)));
    };
    const waits: [string, string][] = [["60", "1 hour"], ["120", "2 hours"], ["180", "3 hours"], ["240", "4 hours"], ["360", "6 hours"], ["480", "8 hours"], ["720", "12 hours"], ["day", "Same day (until 23:59)"]];
    const curWait = cur.maxWait === null ? "day" : String(cur.maxWait);
    if (!waits.some(([v]) => v === curWait)) waits.unshift([curWait, fmtWait(cur.maxWait!)]);
    const wait = h("select", { id: "xfer-wait" }, waits.map(([v, label]) => h("option", { value: v, selected: v === curWait }, label)));
    const close = () => {
      dlg.close();
      dlg.remove();
    };
    const apply = () => {
      const m = Math.max(0, Math.min(120, Math.round(Number(min.value) || 0)));
      const w = wait.value === "day" ? null : Number(wait.value);
      close();
      this.actions.setTransfers({ transfers: k, minTransfer: m, maxWait: w, changeBy: by });
    };
    dlg.append(
      h(
        "form",
        { class: "dialog-inner", onsubmit: (e: Event) => {
          e.preventDefault();
          apply();
        } },
        h("div", { class: "view-head" }, h("div", { class: "view-title" }, h("h2", { id: "xfer-title" }, "Connections with changes")), h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close"))),
        h(
          "div",
          { class: "xfer-form" },
          h("div", { class: "xfer-field" }, h("span", { class: "xfer-label", id: "xfer-k" }, "Connections"), h("div", { class: "scope", role: "group", "aria-labelledby": "xfer-k" }, kBtns), note),
          h(
            "div",
            { class: "xfer-field" },
            h("label", { class: "xfer-label", for: "xfer-min" }, "Minimum transfer time"),
            h(
              "div",
              { class: "xfer-stepper" },
              h("button", { type: "button", class: "icon-btn", "aria-label": "1 minute less", onclick: () => step(-1) }, "−"),
              min,
              h("span", { class: "muted" }, "minutes"),
              h("button", { type: "button", class: "icon-btn", "aria-label": "1 minute more", onclick: () => step(1) }, "+"),
            ),
            h("p", { class: "small muted" }, "At the same station. Changing between stations of a city takes at least the walk or ride between them."),
          ),
          h(
            "div",
            { class: "xfer-field" },
            h("span", { class: "xfer-label", id: "xfer-by" }, "Between stations"),
            h("div", { class: "scope", role: "group", "aria-labelledby": "xfer-by" }, byBtns),
            h(
              "p",
              { class: "small muted" },
              `Estimated from the distance: walking at a slow pace (4.5 km/h) up to ${WALK_MAX_MIN / 60} h, or cycling at ${Math.round((CYCLE_M_PER_MIN * 60) / 1000)} km/h with stops plus ${CYCLE_BUFFER_MIN} min to take and park the bike, up to ${CYCLE_MAX_MIN / 60} h (short changes are still walked). Stations farther apart are not combined.`,
            ),
            h(
              "p",
              { class: "small muted" },
              "Transit: by metro, tram or suburban rail (RER, S-Bahn) where that beats walking, timed from the local timetables for the hour of the arrival: the slowest case within that hour, so a train every 15 minutes late in the evening counts the full 15 minutes of waiting, with the walk to and from the platforms and changes of line. Where these do not run at that hour (at night), or a city has no such data, the change is walked. Buses are not used.",
            ),
          ),
          h("div", { class: "xfer-field" }, h("label", { class: "xfer-label", for: "xfer-wait" }, "Maximum waiting time"), wait),
          h("p", { class: "small muted" }, "Destinations are searched for the travel day shown under the count; direct destinations are those served on any day."),
        ),
        h("div", { class: "xfer-actions" }, h("button", { type: "button", class: "btn", onclick: close }, "Cancel"), h("button", { type: "submit", class: "btn btn--primary" }, "Apply")),
      ),
    );
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) close();
    });
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      close();
    });
    document.body.append(dlg);
    dlg.showModal();
  }

  /** Journeys with changes between a pair without a direct service (connections enabled). */
  private journeys(v: Extract<View, { kind: "journeys" }>): Node[] {
    const n = this.net;
    const a = n.cities[v.city]!;
    const b = n.cities[v.dest]!;
    const originTz = cityTz(n, v.city);
    const cont = v.cont;
    const from = v.station !== undefined ? shortStationName(stationName(n, v.station), a.name) : a.name;
    const title = h("span", { class: "pair" }, v.station !== undefined ? `${from} (${a.name})` : from, h("span", { class: "pair-arrow", "aria-label": "to" }, icon("arrow", 16)), b.name);
    const k = v.settings.transfers;
    const found = `${v.rows.length} journey${v.rows.length === 1 ? "" : "s"} with up to ${connWord(k)}${v.rows.length > 1 ? ` in ${countOptions(v.rows, n)}` : ""}`;
    const rules = `min. ${v.settings.minTransfer} min to change${v.settings.maxWait === null ? ", same day" : `, max. ${fmtWait(v.settings.maxWait)} wait`}${byRule(v.settings.changeBy)}`;
    const arrived = cont ? cont.legs[cont.legs.length - 1]! : null;
    const sub = cont
      ? v.status === "done"
        ? `${found} · after arriving ${fmtTime(arrived!.arrUtc, originTz)}`
        : `Searching journeys after arriving ${fmtTime(arrived!.arrUtc, originTz)}…`
      : v.status === "done"
        ? `${found} · no direct service`
        : `No direct service · searching journeys with up to ${connWord(k)}…`;
    const out: Node[] = [this.header(title, sub, { back: true })];
    if (cont) {
      const o = n.cities[cont.origin]!.name;
      out.push(
        h(
          "div",
          { class: "cont-head" },
          h(
            "p",
            null,
            h("span", { class: "muted" }, "Continuing "),
            `${o} → ${a.name}`,
            h("span", { class: "muted" }, ` (${formatDateShort(localDate(cont.legs[0]!.depUtc, cityTz(n, cont.origin)))}, arrives ${fmtTime(arrived!.arrUtc, originTz)} at ${stationName(n, arrived!.arrStation)}). Pick a journey to add it.`),
          ),
          h("button", { type: "button", class: "link small", onclick: () => this.actions.set({ dest: v.dest, legs: [] }) }, `Search ${o} → ${b.name} instead`),
        ),
      );
    } else out.push(this.dateBar(v.date, v.today, () => new Set(), true));
    if (v.status === "loading") {
      out.push(h("p", { class: "pad muted" }, "Searching connections…"));
      return out;
    }
    if (v.status === "error") {
      out.push(h("p", { class: "pad error" }, `Could not search connections: ${v.message ?? ""}`));
      return out;
    }
    if (!v.rows.length) {
      out.push(
        h(
          "p",
          { class: "pad muted" },
          cont
            ? `No journey to ${b.name} with up to ${connWord(k)} after arriving in ${a.name} at ${fmtTime(arrived!.arrUtc, originTz)} (${rules}).`
            : `No journey with up to ${connWord(k)} on ${formatDateShort(v.date)} (${rules}).`,
        ),
      );
      return out;
    }
    const nowUtc = Date.now();
    const groups = journeyGroups(v.rows, n);
    const cityName = (c: number) => n.cities[c]?.name ?? "";
    const row = (r: JourneyRow, g: JourneyGroup<JourneyRow>) => {
      const j = r.journey;
      const first = j.legs[0]!, last = j.legs[j.legs.length - 1]!;
      const depStation = first.stations[first.board]!, arrStation = last.stations[last.alight]!;
      const mins = Math.round((j.arrUtc - j.depUtc) / 60000);
      const changes: Node[] = [];
      for (let i = 1; i < j.legs.length; i++) {
        const p = j.legs[i - 1]!, l = j.legs[i]!;
        const sa = p.stations[p.alight]!, sb = l.stations[l.board]!;
        const wait = Math.round((l.depUtc - p.arrUtc) / 60000);
        const at = cityName(n.ctx.stationCity[sb]!);
        const many = g.cities.length > 1 ? ` in ${at}` : "";
        const walk = r.legs[i]?.walk, by = r.legs[i]?.by, bike = by === "bike", km = walkKm(n, sa, sb, "");
        const country = n.cities[n.ctx.stationCity[sb]!]?.country ?? "";
        const tl = by === "transit" ? transitModeLabel(r.legs[i]?.modes ?? 0, country) : "";
        changes.push(
          sa === sb
            ? h("span", { title: `Change at ${stationName(n, sb)}: ${fmtDuration(wait)} between the trains` }, `${fmtDuration(wait)} change${many}${g.stations[i - 1] ? "" : ` at ${shortStationName(stationName(n, sb), at)}`}`)
            : by === "transit"
              ? h(
                  "span",
                  { class: "jr-walk", title: `Change in ${at}: ${tl} from ${stationName(n, sa)} to ${stationName(n, sb)}, about ${fmtDuration(walk ?? 0)} door to door (${fmtDuration(wait)} between the trains). ${TRANSIT_NOTE}` },
                  `${fmtDuration(wait)} change${many} · `,
                  icon("transit", 13),
                  ` ≈${fmtDuration(walk ?? 0)} ${tl} ${shortStationName(stationName(n, sa), at)} → ${shortStationName(stationName(n, sb), at)}`,
                )
              : h(
                  "span",
                  { class: "jr-walk", title: `Change in ${at}: ${bike ? "cycle" : "walk"} from ${stationName(n, sa)} to ${stationName(n, sb)}${walk !== undefined ? ` (about ${walk} min${km ? `, ${km}` : ""} ${bike ? "by bike" : "on foot"}; ${fmtDuration(wait)} between the trains)` : ""}` },
                  `${fmtDuration(wait)} change${many} · `,
                  icon(bike ? "bike" : "walk", 13),
                  ` ${walk !== undefined ? `${walk} min ` : ""}${shortStationName(stationName(n, sa), at)} → ${shortStationName(stationName(n, sb), at)}`,
                ),
        );
      }
      // staying on board the vehicle the journey arrives on: its stop here instead of a change
      if (g.stay && arrived) {
        const stop = Math.round((first.depUtc - arrived.arrUtc) / 60000);
        changes.unshift(h("span", { title: `Stay on board at ${stationName(n, depStation)}: the same ${vehicleWord(first.cat)} runs on, no change` }, icon("seat", 13), ` Stay on board${stop > 0 ? ` · ${fmtDuration(stop)} stop` : ""}`));
      }
      const numbers = r.legs.map((l) => l.info?.number).filter((x): x is string => !!x);
      const sameEnds = g.rows.every((o) => o.journey.legs[0]!.stations[o.journey.legs[0]!.board] === depStation && o.journey.legs[o.journey.legs.length - 1]!.stations[o.journey.legs[o.journey.legs.length - 1]!.alight] === arrStation);
      return h(
        "li",
        { class: j.depUtc < nowUtc ? "past" : "", "data-hl": `j:${v.rows.indexOf(r)}` },
        h(
          "button",
          {
            type: "button",
            class: "tt-row",
            disabled: !r.route,
            title: r.route ? `${r.legs.map((l) => (l.info ? [routeDisplayName(l.info.route), l.info.number].filter(Boolean).join(" ") : CAT_LABEL[l.raw.cat])).join(" + ")}: ${g.stay ? "stay on board – the journey rides on" : cont ? "add it to the journey" : "show the legs and the stops"}` : "This journey could not be matched to the timetable",
            onclick: () => r.route && (cont ? this.actions.chooseExtension(r.route, !!j.stay) : this.actions.chooseJourney(r.route)),
          },
          h("span", { class: "tt-times" }, timeEl(n, j.depUtc, depStation, { strong: true }), timeEl(n, j.arrUtc, arrStation, { refDate: localDate(j.depUtc, originTz), refTz: originTz })),
          h(
            "span",
            { class: "tt-main" },
            h("span", { class: "tt-meta" }, changes.map((m, i) => [i ? h("span", { class: "sep" }, "·") : null, m])),
            numbers.length || !sameEnds
              ? h(
                  "span",
                  { class: "tt-stations" },
                  numbers.length ? numbers.join(" + ") : null,
                  numbers.length && !sameEnds ? h("span", { class: "sep" }, " · ") : null,
                  sameEnds ? null : [stationName(n, depStation), h("span", { class: "arr" }, " → "), stationName(n, arrStation)],
                )
              : null,
          ),
          h("span", { class: "tt-dur" }, fmtDuration(mins)),
        ),
      );
    };
    const groupEl = (g: JourneyGroup<JourneyRow>) => {
          const r0 = g.rows[0]!;
          const tags: Node[] = [];
          g.brands.forEach((brand, i) => {
            if (i) {
              const st = g.stations[i - 1];
              const city = cityName(g.cities[i - 1]!);
              const place = st && st.arr === st.dep ? stationName(n, st.dep) : city;
              tags.push(h("span", { class: "jr-sep", "aria-hidden": "true" }, icon("next", 12)), h("span", { class: "jr-via", title: st && st.arr === st.dep ? stationName(n, st.dep) : `Change in ${city}` }, place), h("span", { class: "jr-sep", "aria-hidden": "true" }, icon("next", 12)));
            }
            const info = r0.legs[i]?.info;
            const cat = r0.journey.legs[i]!.cat;
            // the route name when every journey of the group rides the same one ("C2"), else the brand ("TER")
            const names = new Set(g.rows.map((r) => r.legs[i]?.info ? routeDisplayName(r.legs[i]!.info!.route) : undefined));
            const name = names.size === 1 && info ? routeDisplayName(info.route) : brand.startsWith("cat") ? (CAT_LABEL[cat] ?? brand) : brand;
            // a booking caveat when any journey of the group rides such a service on this leg
            const caveat = g.rows.reduce((f, r) => f | ((r.legs[i]?.info?.route.flags ?? 0) & CAVEAT_FLAGS), 0);
            tags.push(info ? routeTag({ ...info.route, name, flags: (info.route.flags & ~CAVEAT_FLAGS) | caveat }) : modeIcon(cat, 16, CAT_LABEL[cat]));
          });
          const k = g.cities.length;
          const dur = g.minMin === g.maxMin ? fmtDuration(g.minMin) : `${fmtDuration(g.minMin)} – ${fmtDuration(g.maxMin)}`;
          const sum = g.stay
            ? [`arrives ${fmtTime(r0.journey.arrUtc, cityTz(n, v.dest))}`, dur, k ? `then ${k} change${k === 1 ? "" : "s"}` : "no change"].join(" · ")
            : [dur, k ? `${k} change${k === 1 ? "" : "s"}` : "direct", g.rows.length > 1 ? `${g.rows.length} a day` : "once a day"].join(" · ");
          // staying on board: said first (the same vehicle, to the destination or to the first change)
          if (g.stay) tags.unshift(h("span", { class: "jr-stay" }, icon("seat", 14), k ? " Stay on board" : ` Stay on board to ${b.name}`));
          return h(
            "li",
            { class: g.stay ? "jr-group is-stay" : "jr-group", "data-hl": `g:${g.key}` },
            h("div", { class: "jr-head" }, h("span", { class: "tt-line jr-legs" }, tags), h("span", { class: "jr-sum" }, sum)),
            h("ol", { class: "tt-list jr-list" }, g.rows.map((r) => row(r, g))),
          );
    };
    // the best options first; the rest on request
    const FIRST_GROUPS = 8;
    const shown = groups.slice(0, Math.max(FIRST_GROUPS, groups.filter((g) => g.stay).length + 1));
    const items: HTMLElement[] = [];
    shown.forEach((g, i) => {
      // after staying on board: the other options (another vehicle, a break)
      if (i && shown[i - 1]!.stay && !g.stay) items.push(h("li", { class: "jr-or" }, `Or get off in ${a.name} and change`));
      items.push(groupEl(g));
    });
    const list = h("ol", { class: "jr-groups", "aria-label": `Journeys ${a.name} to ${b.name}` }, items);
    if (groups.length > shown.length) {
      const rest = groups.slice(shown.length);
      const more: HTMLElement = h(
        "li",
        { class: "jr-more" },
        h("button", { type: "button", class: "btn", onclick: () => more.replaceWith(...rest.map(groupEl)) }, `${rest.length} more option${rest.length === 1 ? "" : "s"} (${rest.reduce((k, g) => k + g.rows.length, 0)} journeys)`),
      );
      list.append(more);
    }
    out.push(list);
    out.push(h("p", { class: "hint" }, `Times are local. Grouped by the trains or buses taken and where to change; per option the departures not beaten by a later one arriving no later. Changes include the ${byWords(v.settings.changeBy)} between stations${groups.some((g) => g.stay) ? "; staying on board needs no time to change" : ""}. ${cont ? "Select a journey to add it." : "Select a journey for its legs and stops."}`));
    return out;
  }

  /**
   * Long lists: render the first rows now and append the rest in idle chunks (keeps taps responsive on phones).
   * With `cap`, only that many rows are rendered until "Show all" is pressed (or a filter is typed): lists of
   * places reached with connections can hold thousands of rows.
   */
  private lazyList<T>(ul: HTMLElement, items: T[], row: (x: T) => HTMLElement, cap = Infinity): HTMLElement {
    const FIRST = 40, CHUNK = 150;
    ul.append(...items.slice(0, FIRST).map(row));
    let i = FIRST;
    let limit = Math.min(items.length, cap);
    let more: HTMLElement | null = null;
    const next = () => {
      if (!ul.isConnected && i > FIRST) return; // view replaced
      const end = Math.min(i + CHUNK, limit);
      const rows = items.slice(i, end).map(row);
      if (more) more.before(...rows);
      else ul.append(...rows);
      i = end;
      const f = this.body.querySelector<HTMLInputElement>(".dest-filter");
      if (f?.value) f.dispatchEvent(new Event("input")); // apply an active filter to the new rows
      if (i < limit) schedule();
      else if (i >= items.length) {
        more?.remove();
        more = null;
        ul.dispatchEvent(new Event("rendered"));
      }
    };
    const schedule = () => ("requestIdleCallback" in window ? requestIdleCallback(next, { timeout: 500 }) : setTimeout(next, 16));
    const expand = () => {
      if (limit >= items.length) return;
      const start = i < limit;
      limit = items.length;
      if (more) more.querySelector("button")!.disabled = true;
      if (!start) schedule();
    };
    if (items.length > cap) {
      more = h(
        "li",
        { class: "dest-more", "data-q": "" },
        h("button", { type: "button", class: "link small", onclick: expand }, `Show all ${items.length.toLocaleString("en")}`),
      );
      ul.append(more);
      (ul as HTMLElement & { expand?: () => void }).expand = expand;
    }
    if (i < limit) schedule();
    return ul;
  }

  /**
   * The stations of a city (rail first, by service), each a button that narrows the origin to that station;
   * with a station chosen, "all stations" goes back to the whole city. Stations without departures under the
   * mode filter are listed last and disabled (the tooltip says which modes serve them). "+N more" expands the
   * list; long lists get a search field to find a station by name.
   */
  private stationsLine(city: number, current: number | undefined, deps: Map<number, StationDeps>): HTMLElement {
    const n = this.net;
    const c = n.cities[city]!;
    const f = this.actions.state.filters;
    const rail = (s: number) => ((n.file.stations[s]!.cats & (Cat.LongDistance | Cat.Regional)) !== 0 ? 0 : 1);
    const usable = (s: number) => depsWith(deps.get(s), f) > 0;
    const off = (s: number) => (usable(s) ? 0 : 1);
    const order = [...c.stations].sort((a, b) => off(a) - off(b) || rail(a) - rail(b) || n.ctx.stationRank[a]! - n.ctx.stationRank[b]!);
    const nUsable = order.filter(usable).length;
    const TOP = 8;
    const SEARCH_FROM = 16; // lists at least this long get a search field
    const btn = (s: number) => {
      const full = stationName(n, s);
      const label = shortStationName(full, c.name);
      const disabled = s !== current && !usable(s);
      return h(
        "button",
        {
          type: "button",
          class: `station-pick${s === current ? " is-current" : ""}${disabled ? " is-off" : ""}`,
          "aria-pressed": String(s === current),
          "aria-disabled": disabled ? "true" : null,
          "data-q": slugify(full),
          title: s === current ? "Show all stations of the city" : disabled ? noDepartures(full, deps.get(s)) : `Departures from ${full} only`,
          onclick: disabled ? null : () => this.actions.clickStation(s, city, label),
        },
        label,
      );
    };
    const line = h("div", { class: "stations-line" });
    const count =
      nUsable < order.length
        ? `${order.length} stations, ${nUsable} with departures${f.cats === ALL_CATS ? "" : " by the selected modes"}`
        : `${order.length} stations`;
    line.append(h("span", { class: "muted stations-count" }, current !== undefined ? `${count} in ${c.name}: ` : `${count} (tap one to see only its departures): `), ...order.slice(0, TOP).map(btn));
    const tail: HTMLElement[] = [];
    if (order.length > TOP) {
      const rest = order.slice(TOP);
      const empty = h("span", { class: "muted stations-empty", hidden: true }, "No station matches.");
      const input = h("input", {
        type: "search",
        class: "dest-filter station-filter",
        placeholder: `Find a station in ${c.name}…`,
        "aria-label": `Find a station in ${c.name}`,
        oninput: () => {
          const q = slugify(input.value);
          let shown = 0;
          for (const b of line.querySelectorAll<HTMLButtonElement>(".station-pick")) {
            b.hidden = !!q && !b.dataset.q!.includes(q);
            if (!b.hidden) shown++;
          }
          empty.hidden = shown > 0;
        },
        onkeydown: (e: Event) => {
          const k = (e as KeyboardEvent).key;
          if (k === "Enter") {
            const hits = [...line.querySelectorAll<HTMLButtonElement>(".station-pick:not([hidden]):not([aria-disabled])")];
            if (hits.length === 1) hits[0]!.click();
          } else if (k === "Escape" && input.value) {
            e.preventDefault(); // clear the field, do not leave the city
            input.value = "";
            input.dispatchEvent(new Event("input"));
          }
        },
      });
      const search = h("div", { class: "stations-search", hidden: true }, input);
      const expand = (focus: boolean) => {
        more.parentElement!.remove();
        line.insertBefore(h("span", { class: "stations-rest" }, rest.map(btn), empty), line.querySelector(".stations-all"));
        if (order.length >= SEARCH_FROM) {
          search.hidden = false;
          if (focus) input.focus();
        }
      };
      const more = h("button", { type: "button", class: "link small", "aria-expanded": "false", onclick: () => expand(false) }, `+${rest.length} more`);
      const find =
        order.length >= SEARCH_FROM
          ? h("button", { type: "button", class: "icon-btn station-find", "aria-label": `Search the ${order.length} stations of ${c.name}`, title: "Find a station by name", onclick: () => expand(true) }, icon("search", 15))
          : null;
      line.insertBefore(search, line.children[1] ?? null);
      tail.push(h("span", { class: "stations-more" }, more, find));
    }
    if (current !== undefined) tail.push(h("button", { type: "button", class: "link small stations-all", onclick: () => this.actions.set({ station: undefined, legs: [] }) }, `All of ${c.name}`));
    line.append(...tail);
    return line;
  }

  private timetable(v: Extract<View, { kind: "timetable" }>): Node[] {
    const n = this.net;
    const a = n.cities[v.city]!;
    const b = n.cities[v.dest]!;
    const originTz = cityTz(n, v.city);
    const from = v.station !== undefined ? shortStationName(stationName(n, v.station), a.name) : a.name;
    const title = h("span", { class: "pair" }, v.station !== undefined ? `${from} (${a.name})` : from, h("span", { class: "pair-arrow", "aria-label": "to" }, icon("arrow", 16)), b.name);
    const swap = h(
      "button",
      { type: "button", class: "icon-btn", "aria-label": "Reverse direction", title: "Reverse direction", onclick: () => this.actions.set({ city: v.dest, dest: v.city, legs: [] }) },
      icon("swap"),
    );
    const out: Node[] = [this.header(title, v.deps.length ? `${v.deps.length} direct departure${v.deps.length === 1 ? "" : "s"}` : "Direct trips", { back: true, extra: swap })];
    out.push(this.dateBar(v.date, v.today, v.serviceDays));
    if (!v.hasService) {
      out.push(h("p", { class: "pad muted" }, `No direct service between ${a.name} and ${b.name} with the selected modes.`));
      return out;
    }
    if (!v.deps.length) {
      out.push(
        h(
          "div",
          { class: "empty pad" },
          h("p", null, v.inHorizon ? `No direct departures on ${formatDateShort(v.date)}.` : `${formatDateShort(v.date)} is outside the timetable period (${formatDateShort(n.cal.startDate)} – ${formatDateShort(lastDate(n.cal))}).`),
          v.next.length
            ? h(
                "p",
                { class: "next-runs" },
                "Next runs: ",
                v.next.map((d, i) => [
                  i ? ", " : "",
                  h("button", { type: "button", class: "link", onclick: () => this.actions.set({ date: d }, { replace: true }) }, formatDateShort(d)),
                ]),
              )
            : h("p", { class: "muted" }, "No further runs in the timetable period."),
        ),
      );
      return out;
    }
    const nowUtc = Date.now();
    let marked = false;
    out.push(
      h(
        "ol",
        { class: "tt-list", "aria-label": `Departures ${a.name} to ${b.name}` },
        v.deps.map((d) => {
          const past = d.depUtc < nowUtc;
          const isNext = !past && !marked && v.date === v.today;
          if (isNext) marked = true;
          const meta: (Node | string)[] = [];
          if (d.startStation !== null) meta.push(h("span", null, `from ${stationName(n, d.startStation)}`));
          for (const s of d.altBoard) meta.push(h("span", null, "also ", stationName(n, s.station), " ", timeEl(n, s.utc, s.station)));
          if (d.note) meta.push(h("span", { class: "note" }, d.note));
          const depLocal = localDate(d.depUtc, originTz);
          return h(
            "li",
            { class: `${past ? "past" : ""}${isNext ? " is-next" : ""}`, "data-hl": routeKey(d.route) },
            h(
              "button",
              {
                type: "button",
                class: "tt-row",
                "aria-label": `${routeDisplayName(d.route)} ${d.number ?? ""} departs ${stationName(n, d.depStation)}, arrives ${stationName(n, d.arrStation)}, ${fmtDuration(d.minutes)}. Show its stops and onward connections.`,
                onclick: () => this.actions.chooseDeparture(d),
              },
              h("span", { class: "tt-times" }, timeEl(n, d.depUtc, d.depStation, { strong: true }), timeEl(n, d.arrUtc, d.arrStation, { refDate: depLocal, refTz: originTz })),
              h(
                "span",
                { class: "tt-main" },
                h("span", { class: "tt-line" }, routeTag(d.route, d.number), h("span", { class: "headsign" }, d.headsign)),
                h("span", { class: "tt-stations" }, stationName(n, d.depStation), h("span", { class: "arr" }, " → "), stationName(n, d.arrStation)),
                meta.length ? h("span", { class: "tt-meta" }, meta.map((m, i) => [i ? h("span", { class: "sep" }, "·") : null, m])) : null,
              ),
              h("span", { class: "tt-dur" }, d.minutes >= 1 ? fmtDuration(d.minutes) : "–"),
            ),
          );
        }),
      ),
    );
    out.push(h("p", { class: "hint" }, "Times are local. Select a departure to see all its stops and the connections from each."));
    queueMicrotask(() => this.body.querySelector(".is-next")?.scrollIntoView({ block: "nearest" }));
    return out;
  }

  /**
   * Previous / next day around the date; the date opens a month calendar with a dot under each day the
   * pair's service runs (days outside the timetable period disabled).
   */
  private dateBar(date: string, today: string, serviceDays: () => ReadonlySet<string>, plain = false): HTMLElement {
    const n = this.net;
    const label = date === today ? `Today, ${formatDateShort(date)}` : date === addDays(today, 1) ? `Tomorrow, ${formatDateShort(date)}` : formatDateShort(date);
    const wrap = h("div", { class: "datebar-wrap" });
    let picker: HTMLElement | null = null;
    const close = (refocus: boolean) => {
      picker?.remove();
      picker = null;
      toggle.setAttribute("aria-expanded", "false");
      if (refocus) toggle.focus();
    };
    const toggle = h(
      "button",
      {
        type: "button",
        class: "date-label",
        "aria-haspopup": "dialog",
        "aria-expanded": "false",
        "aria-label": `Travel date: ${label}. Choose a date`,
        onclick: () => {
          if (picker) return close(false);
          picker = datePicker({
            date,
            today,
            min: n.cal.startDate,
            max: lastDate(n.cal),
            serviceDays: serviceDays(),
            plain,
            onPick: (d) => {
              close(false);
              this.actions.set({ date: d }, { replace: true });
            },
            onClose: () => close(true),
          });
          wrap.append(picker);
          toggle.setAttribute("aria-expanded", "true");
          focusPicker(picker);
        },
      },
      icon("calendar", 16),
      h("span", { class: "date-text" }, label),
    );
    wrap.append(
      h(
        "div",
        { class: "datebar" },
        h("button", { type: "button", class: "icon-btn", "aria-label": "Previous day", onclick: () => this.actions.shiftDate(-1) }, icon("prev")),
        toggle,
        h("button", { type: "button", class: "icon-btn", "aria-label": "Next day", onclick: () => this.actions.shiftDate(1) }, icon("next")),
        date !== today ? h("button", { type: "button", class: "link small", onclick: () => this.actions.set({ date: undefined }, { replace: true }) }, "Today") : null,
      ),
    );
    return wrap;
  }

  /** Same vehicle continues from leg i−1 into leg i (stay on board). */
  private static isThrough(legs: LegInfo[], i: number): boolean {
    const p = legs[i - 1];
    const l = legs[i]!;
    return !!p && p.arrStation === l.depStation && p.route.name === l.route.name && p.number !== undefined && p.number === l.number;
  }

  /**
   * The legs ridden so far with the transfers between them, as one button: hovering it shows all of them on the map,
   * a click (or Enter / Space) opens them together (`open`: their stops and changes in one list).
   */
  private legsBox(legs: LegInfo[], open: () => void): HTMLElement {
    const n = this.net;
    const first = legs[0]!, last = legs[legs.length - 1]!;
    const changes = legs.filter((_, i) => i > 0 && !Panel.isThrough(legs, i)).length;
    const from = n.cities[n.file.stations[first.depStation]!.city]!.name, to = n.cities[last.to]!.name;
    const what = legs.length === 1 ? "trip" : "journey";
    const label = `Open ${what} so far: ${from} → ${to}, ${changes === 0 ? "direct" : `${changes} change${changes > 1 ? "s" : ""}`}`;
    return h(
      "button",
      {
        type: "button",
        class: "legs",
        "data-hl": legsKey(legs.length),
        "aria-label": label,
        title: legs.length === 1 ? "Show all stops of this trip" : "Show the journey so far: every stop and change in one list",
        onclick: open,
      },
      legs.map((l, i) => {
        const prev = legs[i - 1];
        const xfer = prev ? Math.round((l.depUtc - prev.arrUtc) / 60000) : null;
        return [
          xfer !== null
            ? h(
                "span",
                { class: "leg-xfer" },
                Panel.isThrough(legs, i)
                  ? [icon("seat", 14), ` stay on board at ${stationName(n, l.depStation)} (${fmtDuration(xfer)})`]
                  : prev!.arrStation === l.depStation
                    ? `change at ${stationName(n, l.depStation)} · ${fmtDuration(xfer)}`
                    : [icon(byIcon(changeBetween(n, prev!.arrStation, l.depStation, this.changeBy, prev!.arrUtc)?.change?.by), 14), ` ${fmtDuration(xfer)} · ${stationName(n, prev!.arrStation)} → ${stationName(n, l.depStation)}${walkNote(n, prev!.arrStation, l.depStation, this.changeBy, prev!.arrUtc)}`],
              )
            : null,
          h(
            "span",
            { class: "leg" },
            routeTag(l.route, l.number),
            h(
              "span",
              { class: "leg-times" },
              timeEl(n, l.depUtc, l.depStation, { strong: true }),
              " ",
              stationName(n, l.depStation),
              h("span", { class: "arr" }, " → "),
              timeEl(n, l.arrUtc, l.arrStation, { strong: true, refDate: localDate(l.depUtc, cityTz(n, n.file.stations[l.depStation]!.city)) }),
              " ",
              stationName(n, l.arrStation),
            ),
          ),
        ];
      }),
      h("span", { class: "legs-open", "aria-hidden": "true" }, `View ${what}`, icon("next", 12)),
    );
  }

  /** Cleanup of the current view (observers), run before the next view replaces it. */
  private viewCleanup: (() => void) | null = null;

  /**
   * The schedule of a trip, drawn as a line with a dot per stop in the mode's colour (grey before boarding and after
   * alighting). Every stop after boarding opens the onward connections from it (its count arrives lazily, when the row
   * scrolls into view); stops in a city with several stations also offer the connections from all of them.
   */
  private schedule(v: Extract<View, { kind: "schedule" }>): Node[] {
    const n = this.net;
    const sc = v.sched;
    const stops = sc.stops;
    const board = stops[sc.board]!;
    const alight = stops[sc.alight]!;
    const mins = Math.round((alight.arrUtc! - board.depUtc!) / 60000);
    const tag = [routeDisplayName(sc.route), sc.number].filter(Boolean).join(" ");
    const cityName = (st: ScheduleStop) => n.cities[st.city]?.name ?? "";
    const stopName = (st: ScheduleStop) => st.minorName ?? stationName(n, st.station);
    const title = h("span", { class: "sched-title" }, routeTag(sc.route, sc.number), h("span", { class: "headsign" }, sc.headsign));
    const out: Node[] = [this.header(title, `${formatDateShort(sc.refDate)} · ${cityName(board)} → ${cityName(alight)} · ${fmtDuration(mins)}`, { back: true })];
    if (v.legs.length > 1) out.push(this.legsBox(v.legs.slice(0, -1), () => this.actions.showSchedule(v.legs.length - 2)));
    const before = sc.board, after = stops.length - 1 - sc.alight;
    out.push(
      h(
        "p",
        { class: "sched-meta" },
        sc.route.agency ? h("span", null, sc.route.agency) : null,
        h("span", null, `${stops.length} stops`),
        before ? h("span", null, `from ${stopName(stops[0]!)}`) : null,
        after ? h("span", null, `continues to ${stopName(stops[stops.length - 1]!)}`) : null,
      ),
    );
    const caveat = caveatNote(sc.route);
    if (caveat) out.push(caveat);
    const counts: OnwardCount[] = [];
    const start = v.legs[0]!;
    const origin = n.file.stations[start.depStation]!.city;
    // the trip's own stops beyond the journey: ride on to a later one; board earlier only when it is the journey's first leg
    const extend = (i: number) => extendAt(sc, i, v.legs.length === 1, true, origin);
    const row = (_st: ScheduleStop, i: number) => this.schedRow(sc, i, { windowMin: v.windowMin, counts, count: (stop, whole) => v.onward(stop, whole), choose: (stop, whole) => this.actions.chooseStop(stop, whole), extend });
    const list = h("ol", { class: "sched", style: `--mode:var(--cat-${sc.route.cat})`, "aria-label": `Stops of ${tag}` }, stops.map(row));
    out.push(list, this.continueBox(alight.city, origin), h("p", { class: "hint" }, schedHint(v.windowMin, stops.some((_, i) => extend(i) !== null))));
    this.lazyCounts(counts);
    queueMicrotask(() => list.querySelector(".is-end")?.scrollIntoView({ block: "nearest" }));
    return out;
  }


  /**
   * One stop of a trip's schedule (`sc.stops[i]`): its time(s), the dot on the line and its name; a stop after
   * boarding opens the onward connections from it (`choose`), with the count filled in lazily (`counts`).
   */
  private schedRow(
    sc: TripSchedule,
    i: number,
    o: {
      windowMin: number;
      counts: OnwardCount[];
      count: (stop: number, whole: boolean) => Promise<number>;
      choose: (stop: number, whole: boolean) => void;
      order?: number;
      /** Whether stop i extends the journey on this vehicle: ride on to it ("last"), board there ("first"); see extendAt. */
      extend?: (i: number) => "first" | "last" | null;
    },
  ): HTMLElement {
    const n = this.net;
    const stops = sc.stops;
    const st = stops[i]!;
    const stopName = (x: ScheduleStop) => x.minorName ?? stationName(n, x.station);
    const countEl = () => h("span", { class: "sched-count is-loading" }, "…");
    const last = i === stops.length - 1;
    const strong = i === sc.board || i === sc.alight;
    const ref = { refDate: sc.refDate, refTz: sc.refTz };
    const place = n.cities[st.city]?.name ?? stopName(st);
    const time = (utc: number, t: { refDate?: string; refTz?: string; strong?: boolean }) => timeAt(utc, st.tz, place, t);
    const times =
      st.show === "both"
        ? // the zone name (if foreign) once, under the departure
          [h("span", { class: "sched-arr", title: "arrival" }, time(st.arrUtc!, { refDate: sc.refDate })), time(st.depUtc!, { ...ref, strong })]
        : [time((st.show === "dep" ? st.depUtc : st.arrUtc)!, { ...ref, strong })];
    const name = stopName(st);
    const city = n.cities[st.city]?.name ?? "";
    const role = i === sc.board ? "board" : i === sc.alight ? "get off" : null;
    const label = [
      h("span", { class: "sched-name" }, name),
      city && !slugify(name).includes(slugify(city)) ? h("span", { class: "sched-cityname" }, city) : null,
      role ? h("span", { class: "sched-role" }, role) : null,
      st.limit ? limitBadge(st.limit) : null,
    ];
    // a larger place with several stations: connections from all of them, offered once per city (and shown
    // once it is known to add departures)
    const c = n.cities[st.city];
    const multi = st.onward && st.cityRep && !!c && c.stations.length > 1 && c.importance >= WHOLE_CITY_MIN_IMPORTANCE;
    const order = (o.order ?? 0) + i;
    let body: HTMLElement[];
    const ext = o.extend?.(i) ?? null;
    const conns = `Connections from ${name} within ${o.windowMin / 60} h of arriving`;
    if (ext === "first") {
      // before boarding: board here instead (the journey starts earlier, on the same vehicle)
      body = [
        h(
          "button",
          { type: "button", class: "sched-main is-extend", title: `Board here – start the journey at ${name} (departs ${fmtTime(st.depUtc!, st.tz)})`, onclick: () => this.actions.extendLeg("first", st.stop, st.city, st.depUtc!) },
          h("span", { class: "sched-label" }, label, h("span", { class: "sched-act" }, "board here")),
        ),
      ];
    } else if (st.onward) {
      const el = countEl();
      // after getting off: stay on board to here (the journey ends here, no change); the count opens the connections
      const main =
        ext === "last"
          ? h(
              "div",
              { class: "sched-line" },
              h(
                "button",
                { type: "button", class: "sched-main is-extend", title: `Stay on board to ${name} (arrives ${fmtTime(st.arrUtc!, st.tz)}) – the journey then ends here`, onclick: () => this.actions.extendLeg("last", st.stop, st.city) },
                h("span", { class: "sched-label" }, label, h("span", { class: "sched-act" }, "stay on to here")),
              ),
              h("button", { type: "button", class: "sched-conn", title: conns, "aria-label": conns, onclick: () => o.choose(st.stop, false) }, el),
            )
          : h("button", { type: "button", class: "sched-main", title: conns, onclick: () => o.choose(st.stop, false) }, h("span", { class: "sched-label" }, label), el);
      body = [main];
      if (multi) {
        const wel = countEl();
        const btn = h(
          "button",
          { type: "button", class: "sched-whole", hidden: true, title: `Connections from every station of ${city}, with the ${byWords(this.changeBy)} between stations`, onclick: () => o.choose(st.stop, true) },
          `All stations of ${city}`,
          wel,
        );
        body.push(btn);
        o.counts.push({ order, el, count: (whole) => o.count(i, whole), whole: { el: wel, btn } });
      } else o.counts.push({ order, el, count: (whole) => o.count(i, whole) });
    } else body = [h("div", { class: "sched-main" }, h("span", { class: "sched-label" }, label))];
    return h(
      "li",
      {
        class: [
          "sched-stop",
          `is-${st.part}`,
          st.rideIn ? "ride-in" : "",
          st.rideOut ? "ride-out" : "",
          strong ? "is-end" : "",
          st.stop < 0 ? "is-minor" : "",
          i === 0 ? "is-first" : "",
          last ? "is-last" : "",
        ]
          .filter(Boolean)
          .join(" "),
      },
      h("span", { class: "sched-time" }, times),
      h("span", { class: "sched-rail", "aria-hidden": "true" }, h("span", { class: "sched-dot" })),
      h("div", { class: "sched-body" }, body),
    );
  }

  /**
   * A journey with changes as one list along a line: each leg's header (route, direction, times), its stops – the
   * first leg from the start of its run, the last to its end, greyed outside the ride as in a trip's schedule; at the
   * changes the stops the vehicles make beyond them are folded – and between the legs the change: the walk or the
   * same station, the time to change and the other departures of the same kind one could take.
   */
  private journey(v: Extract<View, { kind: "journey" }>): Node[] {
    const n = this.net;
    const js = v.js;
    const first = js.legs[0]!.sched, lastS = js.legs[js.legs.length - 1]!.sched;
    const b0 = first.stops[first.board]!, al = lastS.stops[lastS.alight]!;
    const cityName = (st: ScheduleStop) => n.cities[st.city]?.name ?? st.minorName ?? stationName(n, st.station);
    const title = h("span", { class: "pair" }, cityName(b0), h("span", { class: "pair-arrow", "aria-label": "to" }, icon("arrow", 16)), cityName(al));
    const k = js.changeCount;
    const sub = `${formatDateShort(first.refDate)} · ${fmtTime(js.depUtc, b0.tz)} – ${fmtTime(js.arrUtc, al.tz)} · ${fmtDuration(js.minutes)} · ${k ? `${k} change${k === 1 ? "" : "s"}` : "direct"}`;
    const out: Node[] = [this.header(title, sub, { back: true })];
    const counts: OnwardCount[] = [];
    const items: HTMLElement[] = [];
    const k0 = js.legs.length;
    js.legs.forEach((part, li) => {
      const sc = part.sched;
      const mode = `--mode:var(--cat-${sc.route.cat})`;
      const row = (i: number) => {
        const el = this.schedRow(sc, i, {
          windowMin: v.windowMin,
          counts,
          count: (stop, whole) => v.onward(li, stop, whole),
          choose: (stop, whole) => this.actions.chooseStop(stop, whole, li),
          order: li * 10000,
          extend: (i) => extendAt(sc, i, li === 0, li === k0 - 1, b0.city),
        });
        el.setAttribute("style", mode);
        el.dataset.hl = `l:${li}`;
        return el;
      };
      if (li > 0) items.push(this.changeItem(v, li - 1));
      // leg header
      const bd = sc.stops[sc.board]!, ar = sc.stops[sc.alight]!;
      const mins = Math.round((ar.arrUtc! - bd.depUtc!) / 60000);
      items.push(
        h(
          "li",
          { class: "jsched-leg", style: mode, "data-hl": `l:${li}` },
          h("span", { class: "jsched-leg-icon", "aria-hidden": "true" }, modeIcon(sc.route.cat, 16)),
          h(
            "div",
            { class: "jsched-leg-main" },
            h("span", { class: "sched-title" }, routeBadge(sc.route, sc.number), caveatBadge(sc.route), h("span", { class: "headsign" }, h("span", { class: "muted" }, "towards "), sc.headsign)),
            h("span", { class: "jsched-leg-meta" }, [sc.route.agency || null, fmtDuration(mins), stopsBetween(sc)].filter(Boolean).join(" · ")),
            caveatNote(sc.route),
          ),
          k0 > 1 && (li === 0 || li === k0 - 1) ? this.removeLegButton(js, li) : null,
        ),
      );
      const fold = (kind: "before" | "after", a: number, b: number) => {
        const count = b - a + 1;
        const word = kind === "before" ? "previous" : "next";
        const end = kind === "before" ? `from ${sc.stops[0]!.minorName ?? stationName(n, sc.stops[0]!.station)}` : `to ${sc.stops[sc.stops.length - 1]!.minorName ?? stationName(n, sc.stops[sc.stops.length - 1]!.station)}`;
        let rows: HTMLElement[] | null = null;
        const label = h("span", null, `Show ${word} stops (${count})`);
        const btn = h("button", { type: "button", class: "jsched-fold-btn", "aria-expanded": "false" }, icon("next", 12), label, h("span", { class: "jsched-fold-end" }, end));
        const li = h("li", { class: `jsched-fold is-${kind}`, style: mode }, h("span", { class: "sched-time" }), h("span", { class: "sched-rail", "aria-hidden": "true" }), h("div", { class: "sched-body" }, btn));
        btn.addEventListener("click", () => {
          if (rows) {
            for (const r of rows) r.remove();
            rows = null;
          } else {
            rows = [];
            for (let i = a; i <= b; i++) rows.push(row(i));
            li.after(...rows);
            this.lazyCounts(counts.splice(0)); // the new rows' counts
          }
          const open = !!rows;
          btn.setAttribute("aria-expanded", String(open));
          li.classList.toggle("is-open", open);
          label.textContent = `${open ? "Hide" : "Show"} ${word} stops (${count})`;
        });
        return li;
      };
      if (part.foldBefore) items.push(fold("before", 0, part.foldBefore - 1));
      for (let i = part.from; i <= part.to; i++) items.push(row(i));
      if (part.foldAfter) items.push(fold("after", part.to + 1, sc.stops.length - 1));
    });
    const list = h("ol", { class: "sched jsched", "aria-label": "Stops and changes of the journey" }, items);
    const ext = js.legs.some((part, li) => part.sched.stops.some((_, i) => extendAt(part.sched, i, li === 0, li === k0 - 1, b0.city) !== null));
    out.push(list, this.continueBox(al.city, b0.city), h("p", { class: "hint" }, schedHint(v.windowMin, ext)));
    this.lazyCounts(counts.splice(0));
    return out;
  }

  /**
   * The × of the first or last leg of a journey: removes that train (bus) – the journey then starts where the next leg
   * boards, or ends where the previous one is left.
   */
  private removeLegButton(js: JourneySchedule, li: number): HTMLElement {
    const n = this.net;
    const first = li === 0;
    const sc = js.legs[li]!.sched;
    const other = js.legs[first ? 1 : li - 1]!.sched;
    const at = first ? other.stops[other.board]! : other.stops[other.alight]!;
    const place = at.minorName ?? stationName(n, at.station);
    const tag = [routeDisplayName(sc.route), sc.number].filter(Boolean).join(" ");
    const what = vehicleWord(sc.route.cat);
    const title = `Remove this ${what} – ${first ? "start" : "end"} the journey at ${place}`;
    return h(
      "button",
      { type: "button", class: "icon-btn jsched-leg-remove", title, "aria-label": `Remove ${tag} – ${first ? "start" : "end"} the journey at ${place}`, onclick: () => this.actions.removeLeg(first ? "first" : "last", tag) },
      icon("close", 14),
    );
  }

  /** The change between legs `k` and `k + 1` of a journey (a row of the journey's list). */
  private changeItem(v: Extract<View, { kind: "journey" }>, k: number): HTMLElement {
    const n = this.net;
    const c = v.js.changes[k]!;
    const next = v.js.legs[k + 1]!.sched;
    const here = n.file.stations[c.depStation]?.city ?? -1;
    const cityN = n.cities[here]?.name ?? "";
    const short = (st: number) => shortStationName(stationName(n, st), cityN);
    const lines: Node[] = [];
    if (c.through) lines.push(h("div", { class: "jsched-x-main" }, icon("seat", 15), h("span", null, `Stay on board at ${stationName(n, c.depStation)}`)));
    else if (c.arrStation !== c.depStation) {
      const sa = n.file.stations[c.arrStation], sb = n.file.stations[c.depStation];
      const d = sa && sb ? distanceM(sa.lon, sa.lat, sb.lon, sb.lat) : null;
      const est = d !== null ? (changeBetween(n, c.arrStation, c.depStation, this.changeBy, c.arrUtc)?.change ?? { min: walkMinutes(d), by: "walk" as const }) : null;
      const walk = c.walk ?? est?.min ?? null;
      const by = c.walk !== undefined ? c.by : est?.by;
      const bike = by === "bike";
      const modes = c.walk !== undefined ? c.modes : est && "modes" in est ? est.modes : undefined;
      const tl = by === "transit" ? transitModeLabel(modes ?? 0, n.cities[here]?.country ?? "") : "";
      lines.push(
        by === "transit"
          ? h(
              "div",
              { class: "jsched-x-main", title: TRANSIT_NOTE },
              icon("transit", 15),
              h("span", null, h("strong", null, walk !== null ? `≈${fmtDuration(walk)} ${tl}` : tl), ` ${short(c.arrStation)} → ${short(c.depStation)}`, h("span", { class: "muted" }, " · worst case for this hour, waiting included")),
            )
          : h(
              "div",
              { class: "jsched-x-main" },
              icon(bike ? "bike" : "walk", 15),
              h("span", null, h("strong", null, walk !== null ? `${fmtDuration(walk)} ${bike ? "cycle" : "walk"}` : bike ? "Cycle" : "Walk"), ` ${short(c.arrStation)} → ${short(c.depStation)}`, d !== null ? h("span", { class: "muted" }, ` · ${fmtKm(walkDistanceM(d) / 1000)}`) : null),
            ),
      );
    } else lines.push(h("div", { class: "jsched-x-main" }, icon("swap", 15), h("span", null, h("strong", null, "Change"), ` at ${stationName(n, c.depStation)}`)));
    if (!c.through) {
      // the walk (ride) taking (about) all the time between the trains needs no second line
      const spare = c.walk !== undefined ? c.wait - c.walk : null;
      if (spare === null || spare > 2) lines.push(h("div", { class: "jsched-x-wait" }, `${fmtDuration(c.wait)} between the trains${spare !== null ? ` · ${fmtDuration(spare)} to spare after the ${c.by === "bike" || c.by === "transit" ? "ride" : "walk"}` : ""}`));
    }
    const opts = v.options[k] ?? [];
    if (opts.some((o) => !o.taken)) {
      const brand = legBrand("", next.route.cat, next.route) || routeDisplayName(next.route);
      const clickable = k + 1 === v.js.legs.length - 1;
      const tz = cityTz(n, here);
      const ref = localDate(c.arrUtc, tz);
      lines.push(
        h(
          "div",
          { class: "jsched-x-opts" },
          h("span", { class: "jsched-x-opts-label" }, `${brand} from ${cityN}:`),
          opts.map((o) => {
            const t = timeEl(n, o.depUtc, o.depStation, { refDate: ref });
            const label = [t, h("span", { class: "jsched-opt-wait" }, o.taken ? `${fmtDuration(o.wait)}` : `+${fmtDuration(o.wait)}`)];
            const title = `${[routeDisplayName(next.route), o.number].filter(Boolean).join(" ")} from ${stationName(n, o.depStation)} at ${fmtTime(o.depUtc, tz)}, arrives ${fmtTime(o.arrUtc, cityTz(n, n.file.stations[o.arrStation]?.city ?? here))} at ${stationName(n, o.arrStation)} – ${fmtDuration(o.wait)} after arriving`;
            return o.taken
              ? h("span", { class: "jsched-opt is-taken", title: `${title} (this journey)`, "aria-current": "true" }, label)
              : clickable
                ? h("button", { type: "button", class: "jsched-opt", title: `${title}: take this one instead`, onclick: () => this.actions.chooseOption(k + 1, o) }, label)
                : h("span", { class: "jsched-opt", title }, label);
          }),
        ),
      );
    }
    return h(
      "li",
      { class: `jsched-change${c.through ? " is-through" : ""}` },
      h("span", { class: "sched-time" }, c.through ? null : h("span", { class: "jsched-x-dur" }, fmtDuration(c.wait))),
      h("span", { class: "jsched-x-rail", "aria-hidden": "true" }, h("span", { class: "jsched-x-arrow" })),
      h("div", { class: "jsched-x-body" }, lines),
    );
  }

  /**
   * Fill in onward counts for the rows that scroll into view, two at a time; a stop's "all stations" button appears
   * when the whole city has more departures than the stop's own station.
   */
  private lazyCounts(items: OnwardCount[]): void {
    if (!items.length) return;
    const queue: (typeof items)[number][] = [];
    let running = 0;
    let stopped = false;
    const set = (el: HTMLElement, k: number | null) => {
      el.classList.remove("is-loading");
      el.classList.toggle("is-zero", k === 0);
      el.textContent = k === null ? "" : k === 0 ? "none" : String(k);
      if (k !== null) el.setAttribute("aria-label", `${k} onward connection${k === 1 ? "" : "s"}`);
    };
    const pump = () => {
      while (!stopped && running < 2 && queue.length) {
        const it = queue.shift()!;
        running++;
        const job = async () => {
          const k = await it.count(false);
          set(it.el, k);
          if (!it.whole || stopped) return;
          const kw = await it.count(true);
          set(it.whole.el, kw);
          it.whole.btn.hidden = kw <= k;
        };
        void job()
          .catch(() => set(it.el, null))
          .finally(() => {
            running--;
            // yield between computations so scrolling stays smooth
            setTimeout(pump, 0);
          });
      }
    };
    const byEl = new Map(items.map((it) => [it.el, it]));
    if (typeof IntersectionObserver === "undefined") {
      queue.push(...items);
      pump();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);
          const it = byEl.get(e.target as HTMLElement);
          if (it) queue.push(it);
        }
        // in order along the run
        queue.sort((a, b) => a.order - b.order);
        pump();
      },
      { rootMargin: "150px 0px" },
    );
    for (const it of items) io.observe(it.el);
    const prev = this.viewCleanup;
    this.viewCleanup = () => {
      prev?.();
      stopped = true;
      io.disconnect();
    };
  }

  private connections(v: Extract<View, { kind: "connections" }>): Node[] {
    const n = this.net;
    const legs = v.legs;
    const first = legs[0]!;
    const last = legs[legs.length - 1]!;
    const here = last.to;
    const hereTz = cityTz(n, here);
    const arrDate = localDate(last.arrUtc, hereTz);
    const changes = legs.filter((_, i) => i > 0 && !Panel.isThrough(legs, i)).length;
    const total = Math.round((last.arrUtc - first.depUtc) / 60000);
    const city = n.cities[here]!;
    const arrName = stationName(n, last.arrStation);
    const multi = city.stations.length > 1;
    const out: Node[] = [
      this.header(
        h("span", null, "Connections from ", multi && !v.wholeCity ? arrName : city.name),
        `${fmtDuration(total)} so far · ${changes === 0 ? "direct" : `${changes} change${changes > 1 ? "s" : ""}`}`,
        { back: true },
      ),
      this.legsBox(legs, () => this.actions.reviewJourney()),
    ];
    if (multi) {
      const opt = (label: string, on: boolean, whole: boolean, title: string) =>
        h("button", { type: "button", class: "scope-opt", "aria-pressed": String(on), title, onclick: on ? null : () => this.actions.set({ wholeCity: whole || undefined }, { replace: true }) }, label);
      out.push(
        h(
          "div",
          { class: "scope", role: "group", "aria-label": "Departures from" },
          opt(shortStationName(arrName, city.name), !v.wholeCity, false, `Only departures from ${arrName}`),
          opt(`All stations of ${city.name}`, v.wholeCity, true, `Departures from every station of ${city.name}, with the ${byWords(this.changeBy)} from ${arrName}`),
        ),
      );
    }
    out.push(h("h3", { class: "section" }, `Departures within ${v.windowMin / 60} h of arrival`));
    // departures (or stops of them) left out because the journey covers those places: listed on request
    const hidden = v.all.length - v.conns.length;
    const trimmed = v.conns.filter((c) => !v.all.includes(c)).length;
    const row = (c: Connection) => {
      const transferNote = c.through
        ? h("span", { class: "tag tag--through" }, icon("seat", 13), " stay on board")
        : c.depStation !== last.arrStation
          ? c.changeBy === "transit"
            ? h("span", { class: "walk", title: TRANSIT_NOTE }, icon("transit", 13), ` ≈${fmtDuration(c.transfer)} ${transitModeLabel(c.transitModes ?? 0, city.country)} to ${stationName(n, c.depStation)}`)
            : h("span", { class: "walk" }, icon(c.changeBy === "bike" ? "bike" : "walk", 13), ` ${c.transfer} min ${c.changeBy === "bike" ? "cycle" : "walk"} to ${stationName(n, c.depStation)}${walkKm(n, last.arrStation, c.depStation, " · ")}`)
          : h("span", { class: "muted" }, `same station · min. ${c.transfer} min`);
      return h(
        "li",
        { class: "conn" },
        h(
          "div",
          { class: "conn-head" },
          h("span", { class: "conn-time" }, timeEl(n, c.depUtc, c.depStation, { strong: true, refDate: arrDate }), h("span", { class: "wait" }, `${fmtDuration(c.wait)} wait`)),
          h(
            "span",
            { class: "conn-main" },
            h("span", { class: "tt-line" }, routeTag(c.route, c.number), h("span", { class: "headsign" }, c.headsign)),
            h("span", { class: "tt-meta" }, transferNote, c.note ? [h("span", { class: "sep" }, "·"), h("span", { class: "note" }, c.note)] : null),
          ),
        ),
        h(
          "div",
          { class: "conn-stops", role: "group", "aria-label": `Stops of ${routeDisplayName(c.route)} ${c.number ?? ""}` },
          c.stops.map((s) =>
            h(
              "button",
              {
                type: "button",
                class: "stop-chip",
                title: `Continue to ${n.cities[s.city]!.name} (${stationName(n, s.station)})`,
                onclick: () => this.actions.chooseConnection(c, s, here),
              },
              h("span", { class: "stop-name" }, n.cities[s.city]!.name),
              timeEl(n, s.arrUtc, s.station, { refDate: arrDate, refTz: hereTz }),
            ),
          ),
        ),
      );
    };
    const list = h("ol", { class: "conn-list" });
    const empty = h("p", { class: "pad muted" });
    let all = v.covered;
    const note = h("p", { class: "pad muted small conn-hidden" });
    const render = () => {
      const conns = all ? v.all : v.conns;
      list.replaceChildren(...conns.map(row));
      list.hidden = !conns.length;
      empty.hidden = !!conns.length;
      const none = hidden && !all ? "No onward departures to other places in this window" : "No onward departures in this window";
      empty.textContent = `${none} with the selected modes${multi && !v.wholeCity ? ` from ${arrName} – try all stations of ${city.name}` : ""}.`;
      if (!hidden && !trimmed) {
        note.hidden = true;
        return;
      }
      const what = hidden
        ? `${hidden} departure${hidden > 1 ? "s" : ""} only to places this journey passed, or reaches sooner by staying on board, ${all ? (hidden > 1 ? "are" : "is") + " listed too" : (hidden > 1 ? "are" : "is") + " not listed"}`
        : `Stops this journey passed, or reaches sooner by staying on board, ${all ? "are listed too" : "are left out"}`;
      const title = all
        ? "List only the departures to places the journey does not reach yet"
        : "Also list the departures and stops along this journey: to stop over, or for a later train the same way";
      note.replaceChildren(`${what}. `, h("button", { type: "button", class: "link small", "aria-pressed": String(all), title, onclick: () => ((all = !all), render(), this.actions.showCovered(all)) }, all ? "Hide them" : "Show them"));
    };
    render();
    // above the list, where it is seen before scrolling through it
    out.push(note, list, empty);
    return out;
  }

}

/** "train", "coach", "bus": what a route's vehicle is called. */
function vehicleWord(cat: number): string {
  return cat === Cat.Coach ? "coach" : cat === Cat.Bus ? "bus" : "train";
}

/**
 * Label of a stop where passengers may not board or not get off (GTFS pickup / drop-off type 1; ScheduleStop.limit):
 * "drop-off only" with an arrow down, "boarding only" with an arrow up.
 */
export function limitBadge(bits: number): HTMLElement {
  const noBoard = (bits & StopLimit.NoBoarding) !== 0, noAlight = (bits & StopLimit.NoAlighting) !== 0;
  const [mark, text, title] =
    noBoard && noAlight
      ? ["×", "no boarding or getting off", "The vehicle stops here, but passengers can neither get on nor get off"]
      : noBoard
        ? ["↓", "drop-off only", "Only for getting off: passengers cannot board here"]
        : ["↑", "boarding only", "Only for getting on: passengers cannot get off here"];
  return h("span", { class: "sched-limit", title, "aria-label": title }, h("span", { class: "sched-limit-mark", "aria-hidden": "true" }, mark), text);
}

/** Places from this importance (towns of ~50 000 and up) with several stations offer the onward connections from all their stations. */
const WHOLE_CITY_MIN_IMPORTANCE = 0.6;

/** A stop's onward count (and the whole city's) in the schedule view. */
interface OnwardCount {
  /** position along the list (counts load in this order) */
  order: number;
  el: HTMLElement;
  count: (whole: boolean) => Promise<number>;
  whole?: { el: HTMLElement; btn: HTMLElement };
}

/** Stops ridden past between boarding and getting off: "non-stop", "1 stop", "6 stops" (stops only listed included). */
/** Route options of a journeys list (as shown, see groupJourneys). */
export function journeyGroups(rows: JourneyRow[], n: Net): JourneyGroup<JourneyRow>[] {
  return groupJourneys(rows, (r) => r.journey, (r) => r.legs.map((l) => (l.info ? { route: l.info.route } : {})), n.ctx.stationCity);
}

/** `data-hl` of the departures of a route (timetable view). */
export function routeKey(r: { cat: number; name: string }): string {
  return `rt:${r.cat}:${r.name}`;
}

/**
 * Whether stop i of a journey leg's schedule extends the journey on that vehicle: "last" for a stop after getting off
 * the journey's last leg (`last`) where one may get off, outside the origin city – riding on to it; "first" for a stop
 * before boarding its first leg (`first`) where one may board, in another city than the boarding and alighting ones –
 * boarding there. Null otherwise (connections from there, or nothing).
 */
export function extendAt(sc: TripSchedule, i: number, first: boolean, last: boolean, origin: number): "first" | "last" | null {
  const st = sc.stops[i];
  if (!st || st.stop < 0 || st.city < 0) return null;
  if (last && i > sc.alight && st.onward && st.city !== origin) return "last";
  const b = sc.stops[sc.board]!, a = sc.stops[sc.alight]!;
  if (first && i < sc.board && st.depUtc !== null && !((st.limit ?? 0) & StopLimit.NoBoarding) && st.city !== b.city && st.city !== a.city) return "first";
  return null;
}

/** The hint under a schedule: what tapping a stop does. */
function schedHint(windowMin: number, extend: boolean): string {
  const conns = `connections from there within ${windowMin / 60} h of arriving; numbers count them (the same vehicle not included)`;
  return extend
    ? `Times are local. Tap a greyed stop of the run to stay on board to it (or board there) – the journey is extended, no change. Tap a stop of the ride, or a number, for the ${conns}.`
    : `Times are local. Tap a stop for the ${conns}.`;
}

function stopsBetween(sc: TripSchedule): string {
  const k = sc.alight - sc.board - 1;
  return k <= 0 ? "non-stop" : `${k} stop${k === 1 ? "" : "s"}`;
}

/** "1 connection", "2 connections" */
function connWord(k: number): string {
  return `${k} ${connNoun(k)}`;
}
function connNoun(k: number): string {
  return k === 1 ? "connection" : "connections";
}
/** Maximum wait: "3 h", "90 min" */
function fmtWait(min: number): string {
  return min % 60 === 0 ? `${min / 60} h` : fmtDuration(min);
}

/** Tooltip of a station without departures under the mode filter. */
function noDepartures(name: string, d: StationDeps | undefined): string {
  const cats = depCats(d).map((k) => CAT_LABEL[k]!);
  if (!cats.length) return `No departures to other cities from ${name}`;
  const list = cats.length === 1 ? cats[0]! : `${cats.slice(0, -1).join(", ")} and ${cats[cats.length - 1]}`;
  return `No departures with the selected modes – ${name} is only served by ${list}`;
}

/** "3 options": the route options (journeys view groups) of the rows. */
function countOptions(rows: JourneyRow[], n: Net): string {
  const k = groupJourneys(rows, (r) => r.journey, (r) => r.legs.map((l) => (l.info ? { route: l.info.route } : {})), n.ctx.stationCity).length;
  return `${k} option${k === 1 ? "" : "s"}`;
}

/** Estimated walking distance between two (loaded) stations, prefixed by `sep`; "" while unknown. */
function walkKm(n: Net, a: number, b: number, sep: string): string {
  const sa = n.file.stations[a], sb = n.file.stations[b];
  return sa && sb ? `${sep}${fmtKm(walkDistanceM(distanceM(sa.lon, sa.lat, sb.lon, sb.lat)) / 1000)}` : "";
}

/**
 * The change between two (loaded) stations estimated from their distance (as the search does, see walk.ts), or with
 * "transit" from the city's transit times for the hour of `utc` (the arrival) when its file is loaded: minutes, how
 * (walk / bike / transit, with the transit modes) and the straight-line distance; null while unknown, `change`
 * undefined beyond range.
 */
function changeBetween(n: Net, a: number, b: number, by: ChangeBy, utc?: number): { change: { min: number; by: ChangeBy; modes?: number } | undefined; d: number } | null {
  const sa = n.file.stations[a], sb = n.file.stations[b];
  if (!sa || !sb) return null;
  const d = distanceM(sa.lon, sa.lat, sb.lon, sb.lat);
  if (by === "transit" && utc !== undefined) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const tr = cityTransit(sa.city)?.find((t) => t[0] === lo && t[1] === hi);
    const c = changeAt(walkMinutes(d), tr, 3, by, toLocal(utc, cityTz(n, sa.city)).minutes);
    return { change: c && c.by === "transit" ? { ...c, modes: tr![2]! } : c, d };
  }
  return { change: changeOf(walkMinutes(d), by), d };
}

/** " (walk ≈ 75 min, 5.4 km)" / " (cycle ≈ 27 min, 5.4 km)" / " (metro ≈ 32 min)" between two (loaded) stations; "" while unknown. */
function walkNote(n: Net, a: number, b: number, by: ChangeBy, utc?: number): string {
  const x = changeBetween(n, a, b, by, utc);
  if (!x) return "";
  const c = x.change ?? { min: walkMinutes(x.d), by: "walk" as const };
  if (c.by === "transit") return ` (${transitModeLabel(c.modes ?? 0, n.cities[n.file.stations[a]!.city]?.country ?? "")} ≈ ${fmtDuration(c.min)})`;
  return ` (${c.by === "bike" ? "cycle" : "walk"} ≈ ${fmtDuration(c.min)}, ${fmtKm(walkDistanceM(x.d) / 1000)})`;
}

/** Icon of a change between stations. */
function byIcon(by: ChangeBy | undefined): string {
  return by === "bike" ? "bike" : by === "transit" ? "transit" : "walk";
}

/** "walk", "walk or ride", "walk or transit ride": how changes between stations are made with a setting. */
function byWords(by: ChangeBy | undefined): string {
  return by === "bike" ? "walk or ride" : by === "transit" ? "walk or local transit ride" : "walk";
}

/** Settings summary suffix for the change mode. */
function byRule(by: ChangeBy | undefined): string {
  return by === "bike" ? ", cycling between stations" : by === "transit" ? ", metro / tram / suburban rail between stations" : "";
}

/** Tooltip of a change by transit. */
const TRANSIT_NOTE =
  "A conservative estimate from the local timetables (metro, tram, suburban rail) for this time of day: the slowest case within the hour, including waiting for the train, the walk to and from the platforms and changes of line. Where they do not run at that hour the change is walked.";
