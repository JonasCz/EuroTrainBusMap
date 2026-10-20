import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cat, Flag, routeBrand } from "@etbm/shared";
import { classifyRoute, isHighSpeedService, type ClassifyContext, type RouteInfo } from "../src/core/classify.ts";
import { Db } from "../src/db.ts";
import { loadFeedsConfig, type FeedDef, type FeedsConfig } from "../src/feeds.ts";
import { runLoadHooks } from "../src/gtfs/load.ts";
import { applyOperators, loadOperatorFiles, OperatorConflictError, OperatorRegistry } from "../src/operators/registry.ts";
import type { FeedRef, OperatorAdapter } from "../src/operators/types.ts";
import { cleanTitsaStopName } from "../operators/es-titsa.ts";

const here = import.meta.dirname;
const feedDef = (id: string, country = "XX", options?: FeedDef["options"]): FeedDef => ({ id, country, name: id, tier: "core", keep: ["rail", "coach", "bus"], sources: [{ url: `https://example.org/${id}.zip` }], ...(options ? { options } : {}) });
const baseCfg = (feeds: FeedDef[]): FeedsConfig => ({ userAgent: "t", transitousBase: "https://example.org/", minBusKm: 15, dedicatedOperators: [], coachOperators: "flixbus", urbanAgencies: "bvg", feeds });
const route = (routeType: number, shortName: string, tripPrefix = "", agency = "X", longName = "", desc = ""): RouteInfo => ({ routeType, shortName, tripPrefix, agency, longName, desc });
const ref = (f: FeedDef): FeedRef => ({ key: f.id, id: f.id, country: f.country });

describe("operator adapters of the repository", () => {
  let cfg: FeedsConfig;
  beforeAll(async () => {
    cfg = await loadFeedsConfig(join(here, "../feeds.json"));
  });
  /** classify as gtfs/load.ts does: the feed's (effective) options and the hooks of its adapters for the agency */
  const classifyIn = (feedId: string, r: RouteInfo, over: Partial<ClassifyContext> = {}) => {
    const def = cfg.feeds.find((f) => f.id === feedId)!;
    const ops = cfg.operators!.forFeed(ref(def));
    return classifyRoute(r, { keep: def.keep, opts: def.options ?? {}, country: def.country, coachRe: new RegExp(cfg.coachOperators, "i"), urbanRe: null, hooks: ops.classifyHooks(r.agency), ...over });
  };
  const extras = (feedId: string, agency: string, name: string, cat: number) => {
    const def = cfg.feeds.find((f) => f.id === feedId)!;
    return cfg.operators!.routeExtras({ feed: ref(def), agency, name, short: "", long: "", cat, routeType: 2 });
  };

  it("load without conflicts, in id order, and only add to feeds.json", () => {
    const ids = cfg.operators!.adapters.map((a) => a.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toContain("sncf");
    const i = cfg.feeds.findIndex((f) => f.id === "fr-transilien");
    expect(cfg.feeds[i + 1]?.id).toBe("fr-paca-zou-intermetropole");
    expect(cfg.feeds.find((f) => f.id === "fr-sncf-national")?.options?.prefixNames?.CRE).toBe("Car");
    expect(cfg.dedicatedOperators.map((d) => d.pattern).sort()).toEqual(["\\bli[- ]?bus\\b|livno ?bus", "blablacar|ouibus", "european sleeper", "eurostar|thalys", "flix"]);
  });

  it("sncf: Car TER / car à réservation trips on rail routes are buses, CRE with the booking caveat", () => {
    expect(classifyIn("fr-sncf-national", route(2, "560D", "CRE", "SNCF VOYAGEURS", "Paris - Cahors"))).toEqual({ cls: "bus", cat: Cat.Bus, flags: Flag.ReservationOnly });
    const cte = classifyIn("fr-sncf-national", route(2, "P15", "CTE", "SNCF VOYAGEURS", "Colmar - Metzeral"))!;
    expect([cte.cat, cte.flags]).toEqual([Cat.Bus, 0]);
    expect(classifyIn("fr-sncf-national", route(2, "560D", "CRE"), { keep: ["rail"] })).toBeNull();
    expect(classifyIn("fr-sncf-national", route(2, "560A", "IC", "SNCF VOYAGEURS"))?.cls).toBe("rail");
    // CRE trips on bus routes (TGV station shuttles "Navettes Lorraine TGV") are sold with the train: no caveat
    expect(classifyIn("fr-sncf-national", route(3, "E02", "CRE", "SNCF VOYAGEURS", "Navettes Lorraine TGV - Nancy"))?.flags).toBe(0);
    // scoped to the SNCF feed: the same category elsewhere is left to the generic rules
    expect(classifyIn("fr-transilien", route(2, "P15", "CTE", "SNCF VOYAGEURS"))?.cls).toBe("rail");
  });

  it("gb-mixed-rail: GWR / EMR routes are left to the per-trip heuristic in GB only", () => {
    expect(classifyIn("gb-great-britain", route(2, "GWR", "", "GWR"))?.cat).toBeNull();
    expect(classifyIn("gb-great-britain", route(2, "Northern", "", "Northern Rail"))?.cat).toBe(Cat.Regional);
    expect(classifyIn("ie-tfi", route(2, "GWR", "", "GWR"))?.cat).toBe(Cat.Regional);
  });

  it("se-train-operators: bus routes of train operators are dropped in Trafiklab, their trains kept", () => {
    expect(classifyIn("se-trafiklab", route(3, "60629", "", "SJ", "Karlstad - Oslo"))).toBeNull();
    expect(classifyIn("se-trafiklab", route(2, "60629", "", "SJ"))?.cls).toBe("rail");
    expect(classifyIn("se-trafiklab", route(3, "60629", "", "Västtrafik"))?.cls).toBe("bus");
    expect(classifyIn("no-entur", route(3, "60629", "", "SJ"))?.cls).toBe("bus");
  });

  it("hu-volanbusz: coach route types count as buses (option from the adapter, not feeds.json)", () => {
    expect(cfg.feeds.find((f) => f.id === "hu-volanbusz")?.options?.coachTypesAsBus).toBe(true);
    expect(classifyIn("hu-volanbusz", route(200, "9", "", "MÁV Személyszállítási Zrt. - Helyközi busz"))?.cls).toBe("bus");
  });

  it("ma-oncf: the Supratours marker leaves the headsigns, other agencies' headsigns stay", async () => {
    const db = await Db.open(":memory:");
    await db.run(`CREATE TABLE t_kt AS SELECT * FROM (VALUES (1, 10, 'Agadir (suprat.)'), (2, 10, 'Inezgane (suprat)'), (3, 10, 'Fnideq (supra.)'),
        (4, 10, 'Marrakech'), (5, 20, 'Tanger Ville (suprat.)')) v(trip_key, rc, headsign)`);
    const def = cfg.feeds.find((f) => f.id === "ma-oncf")!;
    await runLoadHooks(db, cfg.operators!.forFeed(ref(def)), "ma-oncf", new Map(), [[10, 0, "coach", 4, 0, "Supratours"], [20, 0, "rail", 1, 0, "ONCF"]]);
    expect((await db.all<{ headsign: string }>(`SELECT headsign FROM t_kt ORDER BY trip_key`)).map((r) => r.headsign)).toEqual(["Agadir", "Inezgane", "Fnideq", "Marrakech", "Tanger Ville (suprat.)"]);
    db.close();
  });

  it("es-titsa: the (T) marker, double spaces and ALL CAPS leave the stop names of TITSA only", async () => {
    expect(cleanTitsaStopName("ARICO EL VIEJO (T)")).toBe("Arico el Viejo");
    expect(cleanTitsaStopName("ADEJE (LAS TORRES) (T)")).toBe("Adeje (Las Torres)");
    expect(cleanTitsaStopName("ALDEA BLANCA  (T)")).toBe("Aldea Blanca");
    expect(cleanTitsaStopName("HOSP. DEL SUR EL MOJÓN")).toBe("Hosp. del Sur el Mojón");
    expect(cleanTitsaStopName("Puerto de la Cruz (T)")).toBe("Puerto de la Cruz");
    const db = await Db.open(":memory:");
    await db.run(`CREATE TABLE t_kt AS SELECT * FROM (VALUES (1, 10), (2, 20)) v(trip_key, rc)`);
    await db.run(`CREATE TABLE t_st AS SELECT * FROM (VALUES (1, 'a'), (1, 'b'), (2, 'c')) v(trip_key, stop_id)`);
    await db.run(`CREATE TABLE t_stops_all AS SELECT * FROM (VALUES ('a', 'ABAMA (T)'), ('b', 'AMBULATORIO  RAVELO'), ('c', 'OTHER (T)')) v(stop_id, name)`);
    const def = cfg.feeds.find((f) => f.id === "es-titsa")!;
    await runLoadHooks(db, cfg.operators!.forFeed(ref(def)), "es-titsa", new Map(), [[10, 0, "bus", 8, 0, "TITSA"], [20, 0, "bus", 8, 0, "Xunta"]]);
    expect((await db.all<{ name: string }>(`SELECT name FROM t_stops_all ORDER BY stop_id`)).map((r) => r.name)).toEqual(["Abama", "Ambulatorio Ravelo", "OTHER (T)"]);
    db.close();
  });

  it("trenitalia / eurostar: brand and high speed of routes named by their ends", () => {
    const fr = extras("fr-trenitalia", "Trenitalia", "Paris-Gare-de-Lyon/Marseille-St-Charles", Cat.LongDistance);
    expect(fr).toEqual({ brand: "Frecciarossa", highSpeed: true });
    expect(routeBrand("Paris-Gare-de-Lyon/Marseille-St-Charles", "Trenitalia", Cat.LongDistance, fr.brand)).toBe("Frecciarossa");
    expect(isHighSpeedService({ agency: "Trenitalia", names: ["Paris-Gare-de-Lyon/Marseille-St-Charles"], highSpeed: fr.highSpeed })).toBe(true);
    expect(extras("it-trenitalia", "TRENITALIA", "Milano Centrale/Roma Termini", Cat.LongDistance)).toEqual({ brand: "Frecciarossa" });
    expect(extras("it-trenitalia", "TRENITALIA", "Milano Centrale/Roma Termini", Cat.Regional)).toEqual({});
    expect(extras("it-trenitalia", "TRENITALIA", "FR", Cat.LongDistance)).toEqual({});
    expect(extras("eu-eurostar", "Eurostar", "FRPNO -> GBSPX", Cat.LongDistance)).toEqual({ highSpeed: true });
    expect(extras("de-delfi", "DB Fernverkehr AG", "Paris Est/Frankfurt Hbf", Cat.LongDistance)).toEqual({});
  });
});

describe("operator registry", () => {
  const feeds = [feedDef("a", "AA"), feedDef("b", "AA"), feedDef("c", "CC", { railCat: "Regional" })];
  const op = (o: Partial<OperatorAdapter> & { id: string }): OperatorAdapter => ({ description: o.id, appliesTo: { feeds: ["a"] }, ...o });

  it("runs adapters in id order whatever the order they come in", () => {
    const x = [op({ id: "zz", extraFeeds: [{ after: "a", def: feedDef("z1") }] }), op({ id: "mm", appliesTo: { feeds: ["m1"] }, extraFeeds: [{ after: "a", def: feedDef("m1") }] })];
    x[0]!.appliesTo = { feeds: ["z1"] };
    const one = applyOperators(baseCfg(feeds), x);
    const two = applyOperators(baseCfg(feeds), [...x].reverse());
    expect(one.operators!.adapters.map((a) => a.id)).toEqual(["mm", "zz"]);
    expect(one.feeds.map((f) => f.id)).toEqual(two.feeds.map((f) => f.id));
    expect(one.feeds.map((f) => f.id)).toEqual(["a", "z1", "m1", "b", "c"]);
  });

  it("merges feed options without clobbering feeds.json or another adapter", () => {
    const cfg = baseCfg(feeds);
    const out = applyOperators(cfg, [op({ id: "x", feedOptions: { night: true } })]);
    expect(out.feeds[0]!.options).toEqual({ night: true });
    expect(cfg.feeds[0]!.options).toBeUndefined(); // the input is not changed (re-runnable)
    expect(() => applyOperators(cfg, [op({ id: "x", feedOptions: { night: true } }), op({ id: "y", feedOptions: { night: false } })])).toThrow(/x and y both set option night of feed a/);
    expect(() => applyOperators(cfg, [op({ id: "x", appliesTo: { feeds: ["c"] }, feedOptions: { railCat: "LongDistance" } })])).toThrow(/feeds.json already sets/);
    expect(() => applyOperators(cfg, [op({ id: "x", appliesTo: { feeds: ["a"], agencies: [/q/] }, feedOptions: { night: true } })])).toThrow(OperatorConflictError);
  });

  it("refuses bad scopes, unknown feeds, duplicate feeds and ids", () => {
    const cfg = baseCfg(feeds);
    expect(() => applyOperators(cfg, [op({ id: "x", appliesTo: {} })])).toThrow(/generic rule/);
    expect(() => applyOperators(cfg, [op({ id: "x", appliesTo: { feeds: ["nope"] } })])).toThrow(/unknown feed "nope"/);
    expect(() => applyOperators(cfg, [op({ id: "x", appliesTo: { feeds: ["a"] }, extraFeeds: [{ after: "a", def: feedDef("a") }] })])).toThrow(/already exists/);
    expect(() => applyOperators(cfg, [op({ id: "x" }), op({ id: "x" })])).toThrow(/two adapters/);
    expect(() => applyOperators(cfg, [op({ id: "Bad_Id" })])).toThrow(/invalid id/);
    expect(() => applyOperators(cfg, [op({ id: "x", exclusive: { pattern: "q", feeds: ["a"] } }), op({ id: "y", exclusive: { pattern: "r", feeds: ["a"] } })])).toThrow(/both claim feed a/);
  });

  it("refuses two adapters with the same hook on the same whole feed", () => {
    const after = { after: () => undefined };
    expect(() => new OperatorRegistry([op({ id: "x", classify: after }), op({ id: "y", appliesTo: { countries: ["AA"] }, classify: after })], feeds)).toThrow(/x and y both have a classify.after hook for feed a/);
    // disjoint feeds, or another hook kind: fine
    new OperatorRegistry([op({ id: "x", classify: after }), op({ id: "y", appliesTo: { feeds: ["b"] }, classify: after })], feeds);
    new OperatorRegistry([op({ id: "x", classify: after }), op({ id: "y", route: () => undefined })], feeds);
  });

  it("scopes hooks to their feeds and agencies", () => {
    const seen: string[] = [];
    const reg = new OperatorRegistry(
      [op({ id: "x", appliesTo: { feeds: ["a"], agencies: [/^Alpha$/] }, classify: { before: (r) => (seen.push(`${r.agency}`), { mode: "bus" }) } })],
      feeds,
    );
    const ctx = (hooks: ClassifyContext["hooks"]): ClassifyContext => ({ keep: ["rail", "bus"], opts: {}, country: "AA", coachRe: /flixbus/i, urbanRe: null, hooks });
    const fa = reg.forFeed(ref(feeds[0]!)), fb = reg.forFeed(ref(feeds[1]!));
    expect(classifyRoute(route(2, "RE1", "", "Alpha"), ctx(fa.classifyHooks("Alpha")))?.cls).toBe("bus");
    expect(classifyRoute(route(2, "RE1", "", "Beta"), ctx(fa.classifyHooks("Beta")))?.cls).toBe("rail");
    expect(fb.classifyHooks("Alpha")).toBeUndefined();
    expect(seen).toEqual(["Alpha"]);
    expect(reg.summary()).toEqual({ x: { "classify.before@a": 1 } });
  });

  it("fails when two adapters set the same field of the same row", () => {
    const reg = new OperatorRegistry(
      [
        op({ id: "x", appliesTo: { agencies: [/rail/i] }, route: () => ({ brand: "One" }) }),
        op({ id: "y", appliesTo: { agencies: [/^north/i] }, route: () => ({ brand: "Two" }) }),
        op({ id: "z", appliesTo: { agencies: [/^north/i] }, route: () => ({ highSpeed: true }) }),
      ],
      feeds,
    );
    const facts = (agency: string) => ({ feed: ref(feeds[0]!), agency, name: "A/B", short: "", long: "", cat: Cat.LongDistance, routeType: 2 });
    expect(reg.routeExtras(facts("South Rail"))).toEqual({ brand: "One" });
    expect(reg.routeExtras(facts("North Coaches"))).toEqual({ brand: "Two", highSpeed: true });
    expect(() => reg.routeExtras(facts("North Rail"))).toThrow(/x and y both set route.brand/);
    const two = new OperatorRegistry(
      [op({ id: "x", appliesTo: { feeds: ["a"], agencies: [/rail/i] }, classify: { before: () => ({ mode: "bus" }) } }), op({ id: "y", appliesTo: { feeds: ["a"], agencies: [/north/i] }, classify: { before: () => ({ mode: "coach" }) } })],
      feeds,
    );
    const h = two.forFeed(ref(feeds[0]!)).classifyHooks("North Rail")!;
    expect(() => h.before!(route(2, "X", "", "North Rail"), "rail")).toThrow(/x and y both set classify.before/);
    // undefined is "no opinion", not a conflict
    expect(two.forFeed(ref(feeds[0]!)).classifyHooks("South Rail")!.before!(route(2, "X", "", "South Rail"), "rail")).toEqual({ mode: "bus" });
  });

  it("changes its load fingerprint with the load-time adapters only", () => {
    const fp = (x: OperatorAdapter[]) => new OperatorRegistry(x, feeds).loadFingerprint();
    const base = [op({ id: "x", feedOptions: { night: true } })];
    expect(fp(base)).toBe(fp([op({ id: "x", feedOptions: { night: true } })]));
    expect(fp(base)).not.toBe(fp([op({ id: "x", feedOptions: { night: false } })]));
    expect(fp(base)).toBe(fp([...base, op({ id: "y", appliesTo: { agencies: [/q/] }, route: () => ({ brand: "Q" }) })]));
  });
});

describe("adapter files", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(here, "tmp-operators-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("loads every file sorted by name, skips the template, needs id = file name", async () => {
    await writeFile(join(dir, "b-op.ts"), `export default { id: "b-op", description: "b", appliesTo: { feeds: ["a"] } };\n`);
    await writeFile(join(dir, "a-op.ts"), `export default { id: "a-op", description: "a", appliesTo: { feeds: ["a"] } };\n`);
    await writeFile(join(dir, "_template.ts"), `export default { id: "template" };\n`);
    await writeFile(join(dir, "README.md"), `# x\n`);
    const { adapters, sources } = await loadOperatorFiles(dir);
    expect(adapters.map((a) => a.id)).toEqual(["a-op", "b-op"]);
    expect(sources.get("a-op")).toContain('description: "a"');
    await writeFile(join(dir, "c-op.ts"), `export default { id: "other", description: "c", appliesTo: { feeds: ["a"] } };\n`);
    await expect(loadOperatorFiles(dir)).rejects.toThrow(/must equal the file name/);
  });
});

describe("onLoad hooks", () => {
  it("see only their scope: trips of other agencies' routes are not dropped, writes need the framework", async () => {
    const db = await Db.open(":memory:");
    await db.run(`CREATE TABLE t_kt AS SELECT * FROM (VALUES (1, 10, 'rail'), (2, 10, 'rail'), (3, 20, 'rail')) v(trip_key, rc, cls);
      CREATE TABLE t_st AS SELECT * FROM (VALUES (1, 1), (1, 2), (2, 1), (2, 2), (3, 1), (3, 2)) v(trip_key, seq)`);
    const rcRows = [[10, 0, "rail", 2, 0, "Alpha Rail"], [20, 0, "rail", 2, 0, "Beta Rail"]];
    const feeds = [feedDef("a")];
    let denied = "";
    const x: OperatorAdapter = {
      id: "x",
      description: "x",
      appliesTo: { feeds: ["a"], agencies: [/^alpha/i] },
      async onLoad(api) {
        expect(api.columns("stops.txt")).toBeNull();
        expect([...api.columns("trips.txt")!]).toEqual(["trip_id"]);
        await api.dropTrips(`SELECT trip_key FROM t_kt`, "test");
        await api.all(`DELETE FROM t_st`).catch((e: Error) => (denied = e.message));
      },
    };
    const reg = new OperatorRegistry([x], feeds);
    await runLoadHooks(db, reg.forFeed(ref(feeds[0]!)), "a", new Map([["trips.txt", new Map([["trip_id", '"trip_id"']])]]), rcRows);
    expect(await db.all(`SELECT DISTINCT trip_key FROM t_st ORDER BY 1`)).toEqual([{ trip_key: 3 }]);
    expect(denied).toMatch(/only single SELECT/);
    expect(reg.summary()).toEqual({ x: { "onLoad.dropTrips@a": 2 } });
    // two adapters whose agencies share a route class
    const y: OperatorAdapter = { ...x, id: "y", appliesTo: { feeds: ["a"], agencies: [/rail/i] }, onLoad: async () => {} };
    const both = new OperatorRegistry([x, y], feeds);
    await expect(runLoadHooks(db, both.forFeed(ref(feeds[0]!)), "a", new Map(), rcRows)).rejects.toThrow(/x and y both have an onLoad hook/);
    db.close();
  });
});
