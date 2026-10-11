/** Side panel (desktop) / bottom sheet (mobile): search, mode chips and content views. */
import { Cat } from "@etbm/shared";
import { cityTz, slugify, stationName, type Net } from "../data/net.ts";
import { addDays, dateFromDayNumber, formatDateShort, lastDate } from "../logic/calendar.ts";
import type { Connection } from "../logic/connections.ts";
import { CAT_LABEL, CAT_ORDER, type Filters } from "../logic/filters.ts";
import type { Leg, LegInfo } from "../logic/journey.ts";
import type { Reach } from "../logic/reach.ts";
import type { Departure } from "../logic/timetable.ts";
import { fmtDuration, localDate } from "../logic/tz.ts";
import { h, icon } from "./dom.ts";
import { catDot, routeBadge, timeEl } from "./format.ts";

export type View =
  | { kind: "intro" }
  | { kind: "loading"; title: string }
  | { kind: "error"; message: string }
  | { kind: "reach"; city: number; reach: Reach }
  | {
      kind: "timetable";
      city: number;
      dest: number;
      date: string;
      today: string;
      deps: Departure[];
      next: string[];
      inHorizon: boolean;
      hasService: boolean;
    }
  | { kind: "connections"; legs: LegInfo[]; conns: Connection[]; windowMin: number };

export interface PanelActions {
  state: { city?: number; dest?: number; filters: Filters; legs: Leg[] };
  set(patch: Record<string, unknown>, opts?: { replace?: boolean }): void;
  clickCity(id: number): void;
  back(): void;
  chooseDeparture(d: Departure): void;
  chooseConnection(c: Connection, stopIdx: number, fromCity: number): void;
  shiftDate(days: number): void;
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

  /** Height of the bottom sheet on mobile (for map padding). */
  sheetHeight(): number {
    return this.sheet.getBoundingClientRect().height;
  }

  // ---- chips ------------------------------------------------------------------

  private buildChips(): void {
    const items: HTMLElement[] = CAT_ORDER.map((cat) =>
      h(
        "button",
        {
          type: "button",
          class: "chip",
          "data-cat": cat,
          "aria-pressed": "true",
          onclick: () => {
            const f = this.actions.state.filters;
            this.actions.set({ filters: { ...f, cats: f.cats ^ cat } });
          },
        },
        catDot(cat),
        CAT_LABEL[cat]!,
      ),
    );
    items.push(
      h(
        "button",
        {
          type: "button",
          class: "chip chip--dt",
          "aria-pressed": "false",
          title: "Only regional services valid with the Deutschlandticket",
          onclick: () => {
            const f = this.actions.state.filters;
            this.actions.set({ filters: { ...f, dticket: !f.dticket } });
          },
        },
        h("span", { class: "dt-mark", "aria-hidden": "true" }, "D"),
        "Deutschlandticket",
      ),
    );
    this.chips.replaceChildren(...items);
  }

  setFilters(f: Filters): void {
    for (const b of this.chips.querySelectorAll<HTMLButtonElement>(".chip")) {
      const cat = Number(b.dataset.cat);
      const on = b.classList.contains("chip--dt") ? f.dticket : (f.cats & cat) !== 0;
      b.setAttribute("aria-pressed", String(on));
      if (!b.classList.contains("chip--dt")) b.disabled = f.dticket && (cat === Cat.LongDistance || cat === Cat.Coach);
    }
  }

  // ---- search -------------------------------------------------------------------

  private bindSearch(): void {
    const names = this.net.cities.map((c) => slugify(c.name));
    const update = () => {
      const q = slugify(this.search.value);
      if (!q) {
        this.closeList();
        return;
      }
      const scored: [number, number][] = [];
      names.forEach((n, i) => {
        const idx = n.indexOf(q);
        if (idx < 0) return;
        const c = this.net.cities[i]!;
        scored.push([i, (idx === 0 ? 2 : idx > 0 && n[idx - 1] === "-" ? 1 : 0) + c.importance]);
      });
      scored.sort((a, b) => b[1] - a[1]);
      this.matches = scored.slice(0, 8).map((s) => s[0]);
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
        return this.reach(v.city, v.reach);
      case "timetable":
        return this.timetable(v);
      case "connections":
        return this.connections(v);
    }
  }

  private header(title: string | Node, sub: string | Node | null, opts: { back?: boolean; extra?: Node } = {}): HTMLElement {
    return h(
      "div",
      { class: "view-head" },
      opts.back
        ? h("button", { type: "button", class: "icon-btn", "aria-label": "Back", title: "Back (Esc)", onclick: () => this.actions.back() }, icon("back"))
        : null,
      h("div", { class: "view-title" }, h("h2", { tabindex: "-1" }, title), sub ? h("p", { class: "sub" }, sub) : null),
      opts.extra ?? null,
      h(
        "button",
        { type: "button", class: "icon-btn", "aria-label": "Close", title: "Close", onclick: () => this.actions.set({ city: undefined, dest: undefined, legs: [], date: undefined }) },
        icon("close"),
      ),
    );
  }

  private intro(): Node[] {
    const n = this.net;
    const end = lastDate(n.cal);
    return [
      h(
        "div",
        { class: "intro" },
        h("h2", { tabindex: "-1" }, "Where can you go without changing?"),
        h(
          "p",
          null,
          "Tap a city to see every place you can reach on a single train or bus. Pick a second city for its timetable, then follow connections onward.",
        ),
        h(
          "ul",
          { class: "legend" },
          CAT_ORDER.map((cat) => h("li", null, h("span", { class: "legend-line", style: `--c:var(--cat-${cat})` }), CAT_LABEL[cat]!)),
        ),
        h(
          "p",
          { class: "muted small" },
          `${n.cities.length.toLocaleString("en")} cities · ${n.corridors.length.toLocaleString("en")} corridors · timetables ${formatDateShort(n.cal.startDate)} – ${formatDateShort(end)}`,
        ),
      ),
    ];
  }

  private reach(city: number, r: Reach): Node[] {
    const n = this.net;
    const c = n.cities[city]!;
    const dests = [...r.dests.values()].sort((a, b) => n.cities[b.city]!.importance - n.cities[a.city]!.importance || a.minutes - b.minutes);
    const stations = c.stations.map((s) => stationName(n, s));
    const out: Node[] = [
      this.header(c.name, `${dests.length} direct destination${dests.length === 1 ? "" : "s"} · ${countryName(c.country)}`),
    ];
    if (stations.length > 1) out.push(h("p", { class: "stations-line" }, `${stations.length} stations: `, stations.join(" · ")));
    if (!dests.length) {
      out.push(h("p", { class: "pad muted" }, "No direct services from here with the selected modes."));
      return out;
    }
    out.push(
      h(
        "ul",
        { class: "dest-list", "aria-label": `Direct destinations from ${c.name}` },
        dests.map((d) => {
          const dc = n.cities[d.city]!;
          return h(
            "li",
            null,
            h(
              "button",
              { type: "button", class: "dest", onclick: () => this.actions.set({ dest: d.city, legs: [] }) },
              h("span", { class: "dest-cats" }, CAT_ORDER.filter((k) => d.cats & k).map((k) => catDot(k, CAT_LABEL[k]))),
              h("span", { class: "dest-name" }, dc.name, dc.country !== c.country ? h("span", { class: "cc" }, dc.country) : null),
              h("span", { class: "dest-time" }, h("span", { class: "muted small" }, "from "), fmtDuration(d.minutes)),
            ),
          );
        }),
      ),
    );
    return out;
  }

  private timetable(v: Extract<View, { kind: "timetable" }>): Node[] {
    const n = this.net;
    const a = n.cities[v.city]!;
    const b = n.cities[v.dest]!;
    const originTz = cityTz(n, v.city);
    const title = h("span", { class: "pair" }, a.name, h("span", { class: "pair-arrow", "aria-label": "to" }, icon("arrow", 16)), b.name);
    const swap = h(
      "button",
      { type: "button", class: "icon-btn", "aria-label": "Reverse direction", title: "Reverse direction", onclick: () => this.actions.set({ city: v.dest, dest: v.city, legs: [] }) },
      icon("swap"),
    );
    const out: Node[] = [this.header(title, v.deps.length ? `${v.deps.length} direct departure${v.deps.length === 1 ? "" : "s"}` : "Direct trips", { back: true, extra: swap })];
    out.push(this.dateBar(v.date, v.today));
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
            { class: `${past ? "past" : ""}${isNext ? " is-next" : ""}` },
            h(
              "button",
              {
                type: "button",
                class: "tt-row",
                "aria-label": `${d.route.name} ${d.number ?? ""} departs ${stationName(n, d.depStation)}, arrives ${stationName(n, d.arrStation)}, ${fmtDuration(d.minutes)}. Show connections.`,
                onclick: () => this.actions.chooseDeparture(d),
              },
              h("span", { class: "tt-times" }, timeEl(n, d.depUtc, d.depStation, { strong: true }), timeEl(n, d.arrUtc, d.arrStation, { refDate: depLocal, refTz: originTz })),
              h(
                "span",
                { class: "tt-main" },
                h("span", { class: "tt-line" }, routeBadge(d.route, d.number), h("span", { class: "headsign" }, d.headsign)),
                h("span", { class: "tt-stations" }, stationName(n, d.depStation), h("span", { class: "arr" }, " → "), stationName(n, d.arrStation)),
                meta.length ? h("span", { class: "tt-meta" }, meta.map((m, i) => [i ? h("span", { class: "sep" }, "·") : null, m])) : null,
              ),
              h("span", { class: "tt-dur" }, fmtDuration(d.minutes)),
            ),
          );
        }),
      ),
    );
    out.push(h("p", { class: "hint" }, "Times are local. Select a departure to see onward connections."));
    queueMicrotask(() => this.body.querySelector(".is-next")?.scrollIntoView({ block: "nearest" }));
    return out;
  }

  private dateBar(date: string, today: string): HTMLElement {
    const n = this.net;
    const input = h("input", {
      type: "date",
      value: date,
      min: n.cal.startDate,
      max: dateFromDayNumber(n.cal.start + n.cal.days - 1),
      "aria-label": "Travel date",
      onchange: (e: Event) => {
        const v = (e.target as HTMLInputElement).value;
        if (v) this.actions.set({ date: v }, { replace: true });
      },
    });
    return h(
      "div",
      { class: "datebar" },
      h("button", { type: "button", class: "icon-btn", "aria-label": "Previous day", onclick: () => this.actions.shiftDate(-1) }, icon("prev")),
      h("label", { class: "date-label" }, h("span", { class: "date-text" }, date === today ? `Today, ${formatDateShort(date)}` : date === addDays(today, 1) ? `Tomorrow, ${formatDateShort(date)}` : formatDateShort(date)), input),
      h("button", { type: "button", class: "icon-btn", "aria-label": "Next day", onclick: () => this.actions.shiftDate(1) }, icon("next")),
      date !== today ? h("button", { type: "button", class: "link small", onclick: () => this.actions.set({ date: undefined }, { replace: true }) }, "Today") : null,
    );
  }

  private connections(v: Extract<View, { kind: "connections" }>): Node[] {
    const n = this.net;
    const legs = v.legs;
    const first = legs[0]!;
    const last = legs[legs.length - 1]!;
    const here = last.to;
    const hereTz = cityTz(n, here);
    const arrDate = localDate(last.arrUtc, hereTz);
    const crumbs = h(
      "ol",
      { class: "crumbs", "aria-label": "Journey" },
      h("li", null, h("button", { type: "button", class: "crumb", onclick: () => this.actions.set({ legs: [] }) }, n.cities[n.file.stations[first.depStation]!.city]!.name)),
      legs.map((l, i) =>
        h(
          "li",
          null,
          h("span", { class: "crumb-sep", "aria-hidden": "true" }, icon("next", 14)),
          i === legs.length - 1
            ? h("span", { class: "crumb current", "aria-current": "step" }, n.cities[l.to]!.name)
            : h("button", { type: "button", class: "crumb", onclick: () => this.actions.set({ legs: this.actions.state.legs.slice(0, i + 1) }) }, n.cities[l.to]!.name),
        ),
      ),
    );
    const changes = legs.length - 1;
    const total = Math.round((last.arrUtc - first.depUtc) / 60000);
    const legList = h(
      "ol",
      { class: "legs" },
      legs.map((l, i) => {
        const prev = legs[i - 1];
        const xfer = prev ? Math.round((l.depUtc - prev.arrUtc) / 60000) : null;
        return h(
          "li",
          null,
          xfer !== null
            ? h("div", { class: "leg-xfer" }, prev!.arrStation === l.depStation ? `${fmtDuration(xfer)} at ${stationName(n, l.depStation)}` : [icon("walk", 14), ` ${fmtDuration(xfer)} · ${stationName(n, prev!.arrStation)} → ${stationName(n, l.depStation)}`])
            : null,
          h(
            "div",
            { class: "leg" },
            routeBadge(l.route, l.number),
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
        );
      }),
    );
    const out: Node[] = [
      this.header(
        h("span", null, "Connections from ", n.cities[here]!.name),
        `${fmtDuration(total)} so far · ${changes === 0 ? "direct" : `${changes} change${changes > 1 ? "s" : ""}`}`,
        { back: true },
      ),
      crumbs,
      legList,
      h("h3", { class: "section" }, `Departures within ${v.windowMin / 60} h of arrival`),
    ];
    if (!v.conns.length) {
      out.push(h("p", { class: "pad muted" }, "No onward departures in this window with the selected modes."));
      return out;
    }
    out.push(
      h(
        "ol",
        { class: "conn-list" },
        v.conns.map((c) => {
          const transferNote = c.through
            ? h("span", { class: "tag tag--through" }, icon("seat", 13), " stay on board")
            : c.depStation !== last.arrStation
              ? h("span", { class: "walk" }, icon("walk", 13), ` ${c.transfer} min to ${stationName(n, c.depStation)}`)
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
                h("span", { class: "tt-line" }, routeBadge(c.route, c.number), h("span", { class: "headsign" }, c.headsign)),
                h("span", { class: "tt-meta" }, transferNote, c.note ? [h("span", { class: "sep" }, "·"), h("span", { class: "note" }, c.note)] : null),
              ),
            ),
            h(
              "div",
              { class: "conn-stops", role: "group", "aria-label": `Stops of ${c.route.name} ${c.number ?? ""}` },
              c.stops.map((s) =>
                h(
                  "button",
                  {
                    type: "button",
                    class: "stop-chip",
                    title: `Continue to ${n.cities[s.city]!.name} (${stationName(n, s.station)})`,
                    onclick: () => this.actions.chooseConnection(c, s.stop, here),
                  },
                  h("span", { class: "stop-name" }, n.cities[s.city]!.name),
                  timeEl(n, s.arrUtc, s.station, { refDate: arrDate, refTz: hereTz }),
                ),
              ),
            ),
          );
        }),
      ),
    );
    return out;
  }

}

const regionNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;
function countryName(cc: string): string {
  try {
    return regionNames?.of(cc) ?? cc;
  } catch {
    return cc;
  }
}
