/**
 * Month calendar for the travel date: one button per day, a dot under each day the selected service
 * runs, days outside the timetable period disabled. Arrow keys move between days (across months),
 * Enter / Space picks, Escape closes.
 */
import { addDays, dayNumber, formatDateShort, weekday } from "../logic/calendar.ts";
import { h, icon } from "./dom.ts";

export interface DatePickerOpts {
  /** selected date (YYYY-MM-DD) */
  date: string;
  today: string;
  /** first / last date with timetable data (inclusive) */
  min: string;
  max: string;
  /** dates with at least one departure */
  serviceDays: ReadonlySet<string>;
  onPick(date: string): void;
  onClose(): void;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WD = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

const monthOf = (d: string) => d.slice(0, 7);
const firstOfMonth = (m: string) => `${m}-01`;
function shiftMonth(m: string, n: number): string {
  const [y, mo] = m.split("-").map(Number);
  const k = y! * 12 + (mo! - 1) + n;
  return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`;
}
function daysInMonth(m: string): number {
  return dayNumber(firstOfMonth(shiftMonth(m, 1))) - dayNumber(firstOfMonth(m));
}

/** The weeks (Mon..Sun) of a month as dates, null for the padding days of other months. */
export function monthGrid(m: string): (string | null)[][] {
  const first = firstOfMonth(m);
  const lead = (weekday(first) + 6) % 7; // Monday = 0
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let i = 0; i < daysInMonth(m); i++) cells.push(addDays(first, i));
  while (cells.length % 7) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function datePicker(o: DatePickerOpts): HTMLElement {
  const clamp = (d: string) => (d < o.min ? o.min : d > o.max ? o.max : d);
  let month = monthOf(clamp(o.date));
  let focusDate = clamp(o.date);
  const root = h("div", { class: "datepicker", role: "dialog", "aria-label": "Choose a travel date" });
  const title = h("span", { class: "dp-title", "aria-live": "polite" });
  const prev = h("button", { type: "button", class: "icon-btn", "aria-label": "Previous month", onclick: () => go(shiftMonth(month, -1)) }, icon("prev", 16));
  const next = h("button", { type: "button", class: "icon-btn", "aria-label": "Next month", onclick: () => go(shiftMonth(month, 1)) }, icon("next", 16));
  const grid = h("table", { class: "dp-grid", role: "grid" });
  const anyService = o.serviceDays.size > 0;
  root.append(
    h("div", { class: "dp-head" }, prev, title, next),
    grid,
    h(
      "p",
      { class: "dp-legend" },
      anyService ? [h("span", { class: "dp-dot", "aria-hidden": "true" }), " runs on this day"] : "No direct service with the selected modes",
      ` · timetables ${formatDateShort(o.min)} – ${formatDateShort(o.max)}`,
    ),
  );

  function go(m: string, focus = false): void {
    month = m;
    if (monthOf(focusDate) !== m) focusDate = clamp(firstOfMonth(m) < o.min ? o.min : firstOfMonth(m));
    render(focus);
  }

  function render(focus: boolean): void {
    const [y, mo] = month.split("-").map(Number);
    title.textContent = `${MONTHS[mo! - 1]} ${y}`;
    prev.disabled = month <= monthOf(o.min);
    next.disabled = month >= monthOf(o.max);
    grid.replaceChildren(
      h("thead", null, h("tr", null, WD.map((w) => h("th", { scope: "col", abbr: w }, w)))),
      h(
        "tbody",
        null,
        monthGrid(month).map((week) =>
          h(
            "tr",
            null,
            week.map((d) => {
              if (!d) return h("td", null);
              const out = d < o.min || d > o.max;
              const runs = o.serviceDays.has(d);
              const cls = ["dp-day", d === o.date ? "is-selected" : "", d === o.today ? "is-today" : "", runs && !out ? "has-service" : ""].filter(Boolean).join(" ");
              return h(
                "td",
                null,
                h(
                  "button",
                  {
                    type: "button",
                    class: cls,
                    "data-date": d,
                    disabled: out,
                    tabindex: d === focusDate ? "0" : "-1",
                    "aria-pressed": String(d === o.date),
                    "aria-label": `${formatDateShort(d)}${d === o.today ? ", today" : ""}${out ? ", no timetable data" : runs ? ", runs" : ", no direct service"}`,
                    title: out ? "Outside the timetable period" : runs ? null : "No direct service on this day",
                    onclick: () => o.onPick(d),
                  },
                  String(Number(d.slice(8))),
                  runs && !out ? h("span", { class: "dp-dot", "aria-hidden": "true" }) : null,
                ),
              );
            }),
          ),
        ),
      ),
    );
    if (focus) grid.querySelector<HTMLButtonElement>(`[data-date="${focusDate}"]`)?.focus();
  }

  grid.addEventListener("keydown", (e) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const d = (e.target as HTMLElement).dataset?.date;
    if (!d) return;
    let target: string | null = null;
    if (e.key in step) target = addDays(d, step[e.key]!);
    else if (e.key === "Home") target = addDays(d, -((weekday(d) + 6) % 7));
    else if (e.key === "End") target = addDays(d, 6 - ((weekday(d) + 6) % 7));
    else if (e.key === "PageUp" || e.key === "PageDown") target = firstOfMonth(shiftMonth(monthOf(d), e.key === "PageUp" ? -1 : 1));
    if (!target) return;
    e.preventDefault();
    focusDate = clamp(target);
    if (monthOf(focusDate) !== month) go(monthOf(focusDate), true);
    else render(true);
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault(); // not "back" (main.ts): only the picker closes
      e.stopPropagation();
      o.onClose();
    }
  });
  render(false);
  return root;
}

/** Focus the selected (or first enabled) day of an open picker. */
export function focusPicker(root: HTMLElement): void {
  (root.querySelector<HTMLButtonElement>('.dp-day[tabindex="0"]:not(:disabled)') ?? root.querySelector<HTMLButtonElement>(".dp-day:not(:disabled)"))?.focus();
}
