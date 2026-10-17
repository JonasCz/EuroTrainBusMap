/**
 * Density-aware level of detail. The base LOD rules (lod.ts) give every corridor line a
 * minimum zoom from its own traffic; in sparse regions (inland Spain, Scandinavia, Ireland)
 * that leaves the map empty at zooms where a dense region (Ruhr, London, Paris) is already
 * full. Here lines may appear earlier where there is room:
 *
 *  - the map is cut into cells of CELL_PX × CELL_PX screen pixels at each LOD level's zoom,
 *  - a cell's "ink" is the drawn line length (px, one line per category) visible at that level,
 *  - level by level (ascending), lines not yet visible are promoted in importance order
 *    (category, then trips/day) while the ink of the (2 RADIUS + 1)² cells around the cells they
 *    cross stays within the budget (INK_BUDGET per 256 × 256 px: a hub in an empty region has
 *    some room, but a small window keeps the ink even – a sparse region next to a dense one
 *    (Northern England next to Manchester, Scotland next to the sea) fills up on its own),
 *  - the unit of promotion is a whole line (a chain of corridors, see lines.ts), never a single
 *    hop: a route is revealed at once, not piece by piece,
 *  - a promoted line must touch the visible network at one of its nodes (cities in the map
 *    data), so lines grow out of the network instead of appearing as floating pieces.
 *
 * Promotion never goes earlier than a per-category floor (long-distance rail first, then regional
 * rail, coaches, buses), but otherwise as far as the budget allows: the target is a roughly even
 * amount of ink everywhere.
 *
 * Mode scenarios (`promoteScenarios`): the UI can hide categories. Where a hidden category's ink is
 * gone, the remaining ones have room, so levels are computed per category subset ("mask", bit i =
 * cats[i]) with only that subset's ink counted; the map data stores the level of every subset and
 * the style picks the one of the active filter. A subset's lines may also grow out of the nodes
 * visible in the first (reference, all-categories) scenario, so coaches alone still start at the
 * big cities.
 */
import { Cat } from "./schema.ts";
import { LEVELS, levelIndex } from "./lod.ts";

/** Ink grid cell (screen px at the level's zoom). */
export const CELL_PX = 64;
/** The neighbourhood of a cell is (2 RADIUS + 1)² cells (192 px). */
export const RADIUS = 1;
/** Area the budget refers to (px × px). */
const BUDGET_PX = 256;
/**
 * Max ink per BUDGET_PX × BUDGET_PX screen area around a line (px); a line straight across such an
 * area is 256 px. About the density of Scotland or southern Ireland at z6.
 */
export const INK_BUDGET = 3000;
/** Max number of LEVELS a line may move forward (all of them: the floors and the budget limit it). */
export const MAX_PROMOTE = LEVELS.length;
/**
 * A line is promoted if at least this share of the ink it adds lies in cells with room (a long
 * line crossing a busy town on its way must not be held back by that one cell).
 */
export const ROOM_SHARE = 0.75;
/** Earliest zoom a promoted line of each category may get. */
export const PROMOTE_FLOOR: Record<number, number> = { [Cat.LongDistance]: 3, [Cat.Regional]: 4, [Cat.Coach]: 4, [Cat.Bus]: 5 };

export interface DensityInput {
  /** Segment polylines (lon/lat); undefined for gaps in sparse networks. */
  segCoords: ((readonly [number, number])[] | undefined)[];
  /**
   * Corridors: end nodes (for connectivity: a line must touch a node of the visible network),
   * segment codes (signed), Cat bits, trips/day per Cat bit.
   */
  corridors: ({ a: number; b: number; segs: number[]; cats: number; tpd: Partial<Record<number, number>> } | undefined)[];
  /** Category bits, in the order of the level arrays. */
  cats: readonly number[];
  /** Corridor × cat base level index (127 = not drawn); modified in place by promoteSparse. */
  levels: Int8Array;
  /** Corridor × cat: may not be promoted (e.g. unsnapped long hops). */
  fixed?: Uint8Array;
  /** Corridor × cat line group (lines.ts, −1 = none); members share one level and are promoted together. Default: one group per corridor × cat. */
  group?: Int32Array;
}

export interface DensityResult {
  /** promotions per category index */
  promoted: number[];
}

export interface DensityOptions {
  /** Max ink per 256 × 256 px around a line, default INK_BUDGET. */
  budget?: number;
  maxPromote?: number;
  /** Cell size of the ink grid (px), default CELL_PX. */
  cellPx?: number;
  /** The neighbourhood of a cell is (2 radius + 1)² cells, default RADIUS. */
  radius?: number;
}

export interface ScenarioResult extends DensityResult {
  mask: number;
  /** Corridor × cat level index (127 = not drawn, also for categories outside the mask). */
  levels: Int8Array;
}

const sid = (code: number) => (code >= 0 ? code : -code - 1);
const CAT_RANK: Record<number, number> = { [Cat.LongDistance]: 0, [Cat.Regional]: 1, [Cat.Coach]: 2, [Cat.Bus]: 3 };
const CELL_ROW = 1_048_576;

/** Single scenario with every category: promotes `inp.levels` in place. */
export function promoteSparse(inp: DensityInput, opts: DensityOptions = {}): DensityResult {
  const [r] = promoteScenarios(inp, [(1 << inp.cats.length) - 1], opts);
  inp.levels.set(r!.levels);
  return { promoted: r!.promoted };
}

/**
 * Density-aware levels for several category subsets at once (`masks`, bit i = cats[i]); `inp.levels`
 * is not modified. masks[0] is the reference scenario: nodes visible there count as visible network
 * in the others too. The segment → cell decomposition of each level is shared by all scenarios.
 */
export function promoteScenarios(inp: DensityInput, masks: readonly number[], opts: DensityOptions = {}): ScenarioResult[] {
  const maxPromote = opts.maxPromote ?? MAX_PROMOTE;
  const cellPx = opts.cellPx ?? CELL_PX;
  const R = opts.radius ?? RADIUS;
  // budget of a whole neighbourhood (sum of its cells)
  const budget = (opts.budget ?? INK_BUDGET) * ((cellPx * (2 * R + 1)) / BUDGET_PX) ** 2;
  const NC = inp.cats.length;
  const nS = inp.segCoords.length;
  const nC = inp.corridors.length;
  // segment vertices in Web Mercator units [0, 1)
  const mx: Float64Array[] = new Array(nS), my: Float64Array[] = new Array(nS);
  for (let s = 0; s < nS; s++) {
    const co = inp.segCoords[s];
    if (!co) continue;
    const xs = new Float64Array(co.length), ys = new Float64Array(co.length);
    co.forEach(([lon, lat], i) => {
      xs[i] = (lon + 180) / 360;
      const sn = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
      ys[i] = 0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI);
    });
    mx[s] = xs;
    my[s] = ys;
  }

  // candidates: lines (groups of corridor × cat), most important first
  const group = inp.group ?? Int32Array.from({ length: nC * NC }, (_, i) => i);
  const members = new Map<number, number[]>();
  for (let c = 0; c < nC; c++) {
    const cr = inp.corridors[c];
    if (!cr?.segs.length) continue;
    for (let k = 0; k < NC; k++) {
      const ck = c * NC + k;
      if (inp.levels[ck] === 127 || inp.fixed?.[ck] || group[ck]! < 0) continue;
      (members.get(group[ck]!) ?? members.set(group[ck]!, []).get(group[ck]!)!).push(ck);
    }
  }
  const catOf = (ck: number) => inp.cats[ck % NC]!;
  const tpdOf = (ck: number) => inp.corridors[Math.floor(ck / NC)]!.tpd[catOf(ck)] ?? 0;
  type Line = { g: number; ms: number[]; cat: number; tpd: number; nodes: number[]; segs: number[] };
  const lines: Line[] = [...members.entries()].map(([g, ms]) => ({
    g,
    ms,
    cat: ms[0]! % NC,
    tpd: Math.max(...ms.map(tpdOf)),
    nodes: [...new Set(ms.flatMap((ck) => [inp.corridors[Math.floor(ck / NC)]!.a, inp.corridors[Math.floor(ck / NC)]!.b]))],
    segs: [...new Set(ms.flatMap((ck) => inp.corridors[Math.floor(ck / NC)]!.segs.map(sid)))],
  }));
  lines.sort((a, b) => CAT_RANK[inp.cats[a.cat]!]! - CAT_RANK[inp.cats[b.cat]!]! || b.tpd - a.tpd || a.g - b.g);
  const floor = (k: number) => levelIndex(PROMOTE_FLOOR[inp.cats[k]!] ?? 0);

  // per scenario state
  const sc = masks.map((mask) => {
    const levels = Int8Array.from(inp.levels);
    for (let ck = 0; ck < levels.length; ck++) if (!((mask >> ck % NC) & 1)) levels[ck] = 127;
    // segment × cat level = min over its corridors
    const segLevel = new Int8Array(nS * NC).fill(127);
    for (let c = 0; c < nC; c++) {
      const cr = inp.corridors[c];
      if (!cr) continue;
      for (let k = 0; k < NC; k++) {
        const l = levels[c * NC + k]!;
        if (l === 127) continue;
        for (const code of cr.segs) {
          const s = sid(code);
          if (l < segLevel[s * NC + k]!) segLevel[s * NC + k] = l;
        }
      }
    }
    return { mask, levels, segLevel, promoted: new Array(NC).fill(0) as number[], lines: lines.filter((ln) => (mask >> ln.cat) & 1) };
  });

  // segment → cell → px at the current level (shared by the scenarios)
  const cellsCache = new Map<number, Map<number, number>>();
  let scale = 0;
  const cellsOf = (s: number): Map<number, number> => {
    let m = cellsCache.get(s);
    if (m) return m;
    m = new Map();
    const xs = mx[s], ys = my[s];
    if (xs && ys) {
      for (let i = 1; i < xs.length; i++) {
        const x0 = xs[i - 1]! * scale, y0 = ys[i - 1]! * scale, x1 = xs[i]! * scale, y1 = ys[i]! * scale;
        const len = Math.hypot(x1 - x0, y1 - y0);
        // split long pieces so each part is charged to the cell it lies in
        const n = Math.max(1, Math.ceil(len * 2));
        for (let j = 0; j < n; j++) {
          const t = (j + 0.5) / n;
          const cell = Math.floor(x0 + (x1 - x0) * t) * CELL_ROW + Math.floor(y0 + (y1 - y0) * t);
          m.set(cell, (m.get(cell) ?? 0) + (len / n) * cellPx);
        }
      }
    }
    cellsCache.set(s, m);
    return m;
  };

  for (let L = 1; L < LEVELS.length; L++) {
    scale = (512 * 2 ** LEVELS[L]!) / cellPx; // mercator unit → cells
    cellsCache.clear();
    let refVis: Set<number> | undefined;
    for (const s of sc) {
      const { levels, segLevel } = s;
      // ink of everything visible at this level
      const ink = new Map<number, number>();
      for (let g = 0; g < nS; g++) {
        let n = 0;
        for (let k = 0; k < NC; k++) if (segLevel[g * NC + k]! <= L) n++;
        if (!n) continue;
        for (const [cell, px] of cellsOf(g)) ink.set(cell, (ink.get(cell) ?? 0) + n * px);
      }
      // nodes touched by a line visible at this level
      const vis = new Set<number>(refVis);
      for (let c = 0; c < nC; c++) {
        const cr = inp.corridors[c];
        if (!cr) continue;
        for (let k = 0; k < NC; k++)
          if (levels[c * NC + k]! <= L) {
            vis.add(cr.a);
            vis.add(cr.b);
            break;
          }
      }
      const around = (cell: number, extra: Map<number, number>) => {
        let sum = 0;
        for (let dx = -R; dx <= R; dx++)
          for (let dy = -R; dy <= R; dy++) {
            const n = cell + dx * CELL_ROW + dy;
            sum += (ink.get(n) ?? 0) + (extra.get(n) ?? 0);
          }
        return sum;
      };
      let pending = s.lines.filter((ln) => {
        const lv = levels[ln.ms[0]!]!; // equal for all members once smoothed
        return lv > L && lv - L <= maxPromote && L >= floor(ln.cat);
      });
      // passes: a line rejected only for lack of a connection may connect once its neighbour is in
      for (let pass = 0; pass < 8 && pending.length; pass++) {
        const next: typeof pending = [];
        let changed = false;
        for (const ln of pending) {
          const k = ln.cat;
          if (!ln.nodes.some((c) => vis.has(c))) {
            next.push(ln);
            continue;
          }
          // ink this line would add: its segments not yet drawn for this category at L
          const add = new Map<number, number>();
          const seen: number[] = [];
          for (const g of ln.segs) {
            if (segLevel[g * NC + k]! <= L) continue;
            seen.push(g);
            for (const [cell, px] of cellsOf(g)) add.set(cell, (add.get(cell) ?? 0) + px);
          }
          let total = 0, roomy = 0;
          for (const [cell, px] of add) {
            total += px;
            if (around(cell, add) <= budget) roomy += px;
          }
          if (roomy < ROOM_SHARE * total) continue; // over budget: stays at its base level
          for (const [cell, px] of add) ink.set(cell, (ink.get(cell) ?? 0) + px);
          for (const ck of ln.ms) levels[ck] = L;
          for (const g of seen) if (L < segLevel[g * NC + k]!) segLevel[g * NC + k] = L;
          for (const c of ln.nodes) vis.add(c);
          s.promoted[k]! += ln.ms.length;
          changed = true;
        }
        if (!changed) break;
        pending = next;
      }
      refVis ??= vis;
    }
  }
  return sc.map((s) => ({ mask: s.mask, levels: s.levels, promoted: s.promoted }));
}

/**
 * Hiding a category must never hide lines of the others: a subset's level of a line is at most its
 * level in every superset. `results` are modified in place (masks missing from the list are skipped).
 */
export function monotoneLevels(results: ScenarioResult[], nCats: number): void {
  const byPop = [...results].sort((a, b) => popcount(b.mask) - popcount(a.mask));
  for (const s of byPop) {
    for (const t of byPop) {
      if (t.mask === s.mask || (t.mask & s.mask) !== s.mask) continue;
      const a = s.levels, b = t.levels;
      for (let i = 0; i < a.length; i++) if ((s.mask >> i % nCats) & 1 && b[i]! < a[i]!) a[i] = b[i]!;
    }
  }
}

function popcount(m: number): number {
  let n = 0;
  for (; m; m &= m - 1) n++;
  return n;
}
