import { describe, expect, it } from "vitest";
import { Cat, packScenario } from "@etbm/shared";
import { levelOf } from "./layers.ts";
import { ALL_CATS } from "../logic/filters.ts";

/** Minimal evaluator for the expression operators levelOf uses. */
function ev(e: unknown, p: Record<string, number>): unknown {
  if (!Array.isArray(e)) return e;
  const [op, ...a] = e as [string, ...unknown[]];
  switch (op) {
    case "get":
      return p[a[0] as string] ?? null;
    case "has":
      return (a[0] as string) in p;
    case "case":
      return ev(a[0], p) ? ev(a[1], p) : ev(a[2], p);
    case "%":
      return (ev(a[0], p) as number) % (ev(a[1], p) as number);
    case "/":
      return (ev(a[0], p) as number) / (ev(a[1], p) as number);
    case "floor":
      return Math.floor(ev(a[0], p) as number);
  }
  throw new Error(`op ${op}`);
}

describe("mode scenario levels in the style", () => {
  // coach: level 9 with everything on; 3 alone (digit 0), 5 with long-distance rail only (digit 1)
  const props = { l4: 9, s4: packScenario([3, 5, 9, 9, 9, 9, 9]) };
  it("picks the level of the active modes", () => {
    expect(ev(levelOf(Cat.Coach, { cats: ALL_CATS }), props)).toBe(9);
    expect(ev(levelOf(Cat.Coach, { cats: Cat.Coach }), props)).toBe(3);
    expect(ev(levelOf(Cat.Coach, { cats: Cat.Coach | Cat.LongDistance }), props)).toBe(5);
    expect(ev(levelOf(Cat.Coach, { cats: Cat.Coach | Cat.Bus }), props)).toBe(9);
  });
  it("falls back to the plain level without packed levels", () => {
    expect(ev(levelOf(Cat.Coach, { cats: Cat.Coach }), { l4: 6 })).toBe(6);
  });
});
