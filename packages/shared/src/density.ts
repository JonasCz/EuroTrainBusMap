/**
 * Density-aware level of detail. The base LOD rules (lod.ts) give every corridor line a
 * minimum zoom from its own traffic; in sparse regions (inland Spain, Scandinavia, Ireland)
 * that leaves the map empty at zooms where a dense region (Ruhr, London, Paris) is already
 * full. Here lines may appear earlier where there is room:
 *
 *  - the map is cut into cells of CELL_PX × CELL_PX screen pixels at each LOD level's zoom,
 *  - a cell's "ink" is the drawn line length (px, one line per category) visible at that level,
 *  - level by level (ascending), lines not yet visible are promoted in importance order
 *    (category, then trips/day) while the mean ink of the 3 × 3 cells around the cells they
 *    cross stays within the budget (regional density: a hub in an empty region has room),
 *  - the unit of promotion is a whole line (a chain of corridors, see lines.ts), never a single
 *    hop: a route is revealed at once, not piece by piece,
 *  - a promoted line must touch the visible network at one of its cities, so lines grow
 *    out of the network instead of appearing as floating pieces.
 *
 * Promotion never goes earlier than a per-category floor (long-distance rail first, then regional
 * rail, coaches, buses), but otherwise as far as the budget allows: the target is a roughly even
 * amount of ink everywhere. All categories count towards the ink regardless of UI filters, so the
 * result is filter-independent and can be baked into the tiles.
 */
import { Cat } from "./schema.ts";
import { LEVELS, levelIndex } from "./lod.ts";

export const CELL_PX = 256;
/** Max mean drawn line length per cell around a line (px); a line straight across a cell is 256 px. */
export const INK_BUDGET = 1200;
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
  /** Corridors: segment codes (signed), Cat bits, trips/day per Cat bit. */
  corridors: ({ a: number; b: number; segs: number[]; cats: number; tpd: Partial<Record<number, number>> } | undefined)[];
  /** Category bits, in the order of the level arrays. */
  cats: readonly number[];
  /** Corridor × cat base level index (127 = not drawn); modified in place. */
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

const sid = (code: number) => (code >= 0 ? code : -code - 1);
const CAT_RANK: Record<number, number> = { [Cat.LongDistance]: 0, [Cat.Regional]: 1, [Cat.Coach]: 2, [Cat.Bus]: 3 };

export function promoteSparse(inp: DensityInput, opts: { budget?: number; maxPromote?: number } = {}): DensityResult {
  const budget = opts.budget ?? INK_BUDGET;
  const maxPromote = opts.maxPromote ?? MAX_PROMOTE;
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
  // segment × cat level = min over its corridors
  const segLevel = new Int8Array(nS * NC).fill(127);
  const refresh = (c: number) => {
    const cr = inp.corridors[c]!;
    for (let k = 0; k < NC; k++) {
      const l = inp.levels[c * NC + k]!;
      if (l === 127) continue;
      for (const code of cr.segs) {
        const s = sid(code);
        if (l < segLevel[s * NC + k]!) segLevel[s * NC + k] = l;
      }
    }
  };
  for (let c = 0; c < nC; c++) if (inp.corridors[c]) refresh(c);

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
  const lines = [...members.entries()].map(([g, ms]) => ({ g, ms, cat: ms[0]! % NC, tpd: Math.max(...ms.map(tpdOf)), cities: [...new Set(ms.flatMap((ck) => [inp.corridors[Math.floor(ck / NC)]!.a, inp.corridors[Math.floor(ck / NC)]!.b]))] }));
  lines.sort((a, b) => CAT_RANK[inp.cats[a.cat]!]! - CAT_RANK[inp.cats[b.cat]!]! || b.tpd - a.tpd || a.g - b.g);
  const lineLevel = (ln: { ms: number[] }) => Math.min(...ln.ms.map((ck) => inp.levels[ck]!)); // equal for all members once smoothed

  const promoted = new Array(NC).fill(0) as number[];
  const cellsCache = new Map<number, Map<number, number>>(); // segment → cell → px (current level)
  for (let L = 1; L < LEVELS.length; L++) {
    const scale = (512 * 2 ** LEVELS[L]!) / CELL_PX; // mercator unit → cells
    const pxPerCell = CELL_PX;
    cellsCache.clear();
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
            const cell = Math.floor(x0 + (x1 - x0) * t) * 1_048_576 + Math.floor(y0 + (y1 - y0) * t);
            m.set(cell, (m.get(cell) ?? 0) + (len / n) * pxPerCell);
          }
        }
      }
      cellsCache.set(s, m);
      return m;
    };
    // ink of everything visible at this level
    const ink = new Map<number, number>();
    for (let s = 0; s < nS; s++) {
      let n = 0;
      for (let k = 0; k < NC; k++) if (segLevel[s * NC + k]! <= L) n++;
      if (!n) continue;
      for (const [cell, px] of cellsOf(s)) ink.set(cell, (ink.get(cell) ?? 0) + n * px);
    }
    // cities touched by a line visible at this level
    const cityVis = new Set<number>();
    for (let c = 0; c < nC; c++) {
      const cr = inp.corridors[c];
      if (!cr) continue;
      for (let k = 0; k < NC; k++)
        if (inp.levels[c * NC + k]! <= L) {
          cityVis.add(cr.a);
          cityVis.add(cr.b);
          break;
        }
    }
    const around = (cell: number, extra: Map<number, number>) => {
      let sum = 0;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          const n = cell + dx * 1_048_576 + dy;
          sum += (ink.get(n) ?? 0) + (extra.get(n) ?? 0);
        }
      return sum / 9;
    };
    const floor = (k: number) => levelIndex(PROMOTE_FLOOR[inp.cats[k]!] ?? 0);
    let pending = lines.filter((ln) => {
      const lv = lineLevel(ln);
      return lv > L && lv - L <= maxPromote && L >= floor(ln.cat);
    });
    // passes: a line rejected only for lack of a connection may connect once its neighbour is in
    for (let pass = 0; pass < 8 && pending.length; pass++) {
      const next: typeof pending = [];
      let changed = false;
      for (const ln of pending) {
        const k = ln.cat;
        if (!ln.cities.some((c) => cityVis.has(c))) {
          next.push(ln);
          continue;
        }
        // ink this line would add: its segments not yet drawn for this category at L
        const add = new Map<number, number>();
        const seen = new Set<number>();
        for (const ck of ln.ms) {
          for (const code of inp.corridors[Math.floor(ck / NC)]!.segs) {
            const s = sid(code);
            if (segLevel[s * NC + k]! <= L || seen.has(s)) continue;
            seen.add(s);
            for (const [cell, px] of cellsOf(s)) add.set(cell, (add.get(cell) ?? 0) + px);
          }
        }
        let total = 0, roomy = 0;
        for (const [cell, px] of add) {
          total += px;
          if (around(cell, add) <= budget) roomy += px;
        }
        if (roomy < ROOM_SHARE * total) continue; // over budget: stays at its base level
        for (const [cell, px] of add) ink.set(cell, (ink.get(cell) ?? 0) + px);
        for (const ck of ln.ms) inp.levels[ck] = L;
        for (const s of seen) if (L < segLevel[s * NC + k]!) segLevel[s * NC + k] = L;
        for (const c of ln.cities) cityVis.add(c);
        promoted[k]! += ln.ms.length;
        changed = true;
      }
      if (!changed) break;
      pending = next;
    }
  }
  return { promoted };
}
