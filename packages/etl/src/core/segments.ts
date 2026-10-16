/**
 * Line-graph decomposition of corridor geometries ("Transit-style" drawing):
 * corridors that share track or road (an express A–C next to a local A–B–C,
 * coaches on the same motorway, both tracks of a double-track line) are cut
 * into shared segments, so every piece of geometry is stored and drawn once,
 * carrying the traffic of all corridors on it.
 *
 * Method (conflation onto reference lines):
 *  1. corridors are processed busiest first; each is resampled every `stepM`,
 *  2. every sample is matched to the nearest vertex of an existing reference
 *     line of the same mode (rail / road) within `radiusM` and with a similar
 *     direction (staying on the previously matched line when possible),
 *  3. matched stretches become runs (ref, from, to) on that reference line;
 *     unmatched stretches become new reference lines (joined to the matched
 *     neighbours, so the drawing stays continuous),
 *  4. each reference line is cut wherever the set of corridors using it
 *     changes; equal neighbours are merged → segments,
 *  5. each corridor gets its ordered list of (signed) segment ids.
 */
import { fastDist, simplifyLine, type LonLat } from "../util/geo.ts";

export interface SegInput {
  /** Polyline from city a to city b (full resolution). */
  coords: LonLat[];
  cats: number;
  /** Trips/day per Cat bit. */
  tpd: Record<number, number>;
  snapped: boolean;
  /** Douglas–Peucker tolerance (m) wanted for this corridor's geometry. */
  tol: number;
  /** Rail corridors only conflate with rail, road corridors with road. */
  rail?: boolean;
}

export interface SegOut {
  coords: LonLat[];
  cats: number;
  tpd: Record<number, number>;
  snapped: boolean;
  /** Corridor indices using the segment. */
  users: number[];
}

export interface SegResult {
  segments: SegOut[];
  /** Per corridor: segment ids in travel order a→b; reversed traversal is encoded as −(id+1). */
  corrSegs: number[][];
}

export interface SegOptions {
  /** Resampling step (m). */
  stepM?: number;
  /** Max distance (m) between a sample and a reference vertex to share geometry. */
  radiusM?: number;
  /** Matched stretches shorter than this many samples (inside a corridor) are treated as unmatched. */
  minRun?: number;
  /** Min |cos| between directions to match. */
  minCos?: number;
  /** Run ends closer than this many vertices to an existing cut snap onto it. */
  snapVertices?: number;
}

interface Ref {
  rail: boolean;
  xs: number[];
  ys: number[];
}

interface Run {
  r: number;
  j0: number;
  j1: number;
}

const RAD = Math.PI / 180;
const PACK = 65536; // vertex index packing (refs are split below this length)

function resample(co: LonLat[], step: number): LonLat[] {
  const out: LonLat[] = [];
  if (!co.length) return out;
  out.push(co[0]!);
  for (let i = 1; i < co.length; i++) {
    const [x0, y0] = co[i - 1]!, [x1, y1] = co[i]!;
    const d = fastDist(x0, y0, x1, y1);
    if (d === 0) continue;
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  return out;
}

function dirOf(xs: ArrayLike<number>, ys: ArrayLike<number>, i: number, n: number): [number, number] {
  const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
  const dx = (xs[b]! - xs[a]!) * Math.cos(ys[i]! * RAD), dy = ys[b]! - ys[a]!;
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

export function buildSegments(inputs: SegInput[], opts: SegOptions = {}): SegResult {
  const step = opts.stepM ?? 100;
  const R = opts.radiusM ?? 80;
  const minRun = opts.minRun ?? 3;
  const minCos = opts.minCos ?? 0.8;
  const cell = R;
  const refs: Ref[] = [];
  const index = new Map<number, number[]>(); // cell → packed (ref * PACK + j)
  const key = (cx: number, cy: number) => (cx + 1_048_576) * 4_194_304 + cy + 2_097_152;
  const cellX = (x: number, y: number) => Math.floor((x * 111_320 * Math.cos(y * RAD)) / cell);
  const cellY = (y: number) => Math.floor((y * 110_540) / cell);
  const indexRef = (r: number) => {
    const ref = refs[r]!;
    for (let j = 0; j < ref.xs.length; j++) {
      const k = key(cellX(ref.xs[j]!, ref.ys[j]!), cellY(ref.ys[j]!));
      let l = index.get(k);
      if (!l) index.set(k, (l = []));
      l.push(r * PACK + j);
    }
  };

  const runs: Run[][] = new Array(inputs.length);
  const weight = (c: number) => Object.values(inputs[c]!.tpd).reduce((a, b) => a + b, 0);
  const order = [...inputs.keys()].sort((a, b) => Number(!!inputs[b]!.rail) - Number(!!inputs[a]!.rail) || weight(b) - weight(a) || a - b);

  for (const c of order) {
    const inp = inputs[c]!;
    const rail = !!inp.rail;
    const S = resample(inp.coords, step);
    const n = S.length;
    const sx = S.map((p) => p[0]), sy = S.map((p) => p[1]);
    // ---- 2. match samples
    const mr = new Int32Array(n).fill(-1), mj = new Int32Array(n).fill(-1);
    let prevR = -1;
    for (let i = 0; i < n; i++) {
      const x = sx[i]!, y = sy[i]!;
      const [dx, dy] = dirOf(sx, sy, i, n);
      const kx = 111_320 * Math.cos(y * RAD);
      let best = -1, bestD = Infinity, same = -1, sameD = Infinity;
      const cx = cellX(x, y), cy = cellY(y);
      for (let ox = -1; ox <= 1; ox++)
        for (let oy = -1; oy <= 1; oy++) {
          const l = index.get(key(cx + ox, cy + oy));
          if (!l) continue;
          for (const packed of l) {
            const r = Math.floor(packed / PACK), j = packed - r * PACK;
            const ref = refs[r]!;
            if (ref.rail !== rail) continue;
            const d = Math.hypot((ref.xs[j]! - x) * kx, (ref.ys[j]! - y) * 110_540);
            if (d > R) continue;
            if (n > 1) {
              const [rx, ry] = dirOf(ref.xs, ref.ys, j, ref.xs.length);
              if (Math.abs(rx * dx + ry * dy) < minCos) continue;
            }
            if (d < bestD) [best, bestD] = [packed, d];
            if (r === prevR && d < sameD) [same, sameD] = [packed, d];
          }
        }
      const pick = same >= 0 ? same : best;
      if (pick >= 0) {
        mr[i] = Math.floor(pick / PACK);
        mj[i] = pick - mr[i]! * PACK;
        prevR = mr[i]!;
      } else prevR = -1;
    }
    // ---- 3. stretches; short matched stretches inside the corridor are noise
    let st: { r: number; a: number; b: number }[] = [];
    for (let i = 0; i < n; ) {
      let k = i;
      while (k + 1 < n && mr[k + 1] === mr[i]) k++;
      st.push({ r: mr[i]!, a: i, b: k });
      i = k + 1;
    }
    for (const s of st) if (s.r >= 0 && s.b - s.a + 1 < minRun && s.a !== 0 && s.b !== n - 1) s.r = -1;
    const merged: { r: number; a: number; b: number }[] = [];
    for (const s of st) {
      const last = merged[merged.length - 1];
      if (last && last.r === -1 && s.r === -1) last.b = s.b;
      else merged.push({ ...s });
    }
    st = merged;
    const out: Run[] = [];
    const pending: number[] = [];
    for (let m = 0; m < st.length; m++) {
      const s = st[m]!;
      if (s.r >= 0) {
        // split where the matched index sequence turns back (U-turn on the reference)
        let a = s.a, dir = 0;
        for (let i = s.a + 1; i <= s.b; i++) {
          const d = Math.sign(mj[i]! - mj[i - 1]!);
          if (d === 0) continue;
          if (dir === 0) dir = d;
          else if (d !== dir) {
            out.push({ r: s.r, j0: mj[a]!, j1: mj[i - 1]! });
            a = i - 1;
            dir = d;
          }
        }
        out.push({ r: s.r, j0: mj[a]!, j1: mj[s.b]! });
      } else {
        // new reference line from the unmatched samples, joined to the matched neighbours
        const pts: LonLat[] = [];
        const prev = st[m - 1], next = st[m + 1];
        if (prev && prev.r >= 0) {
          const r = refs[prev.r]!, j = mj[prev.b]!;
          pts.push([r.xs[j]!, r.ys[j]!]);
        }
        for (let i = s.a; i <= s.b; i++) pts.push([sx[i]!, sy[i]!]);
        if (next && next.r >= 0) {
          const r = refs[next.r]!, j = mj[next.a]!;
          pts.push([r.xs[j]!, r.ys[j]!]);
        }
        if (pts.length < 2) continue;
        for (let start = 0; start < pts.length - 1; start += PACK - 2) {
          const piece = pts.slice(start, Math.min(pts.length, start + PACK - 1));
          const r = refs.length;
          refs.push({ rail, xs: piece.map((p) => p[0]), ys: piece.map((p) => p[1]) });
          pending.push(r);
          out.push({ r, j0: 0, j1: piece.length - 1 });
        }
      }
    }
    const kept = out.filter((u) => u.j0 !== u.j1);
    runs[c] = kept.length ? kept : out.slice(0, 1);
    for (const r of pending) indexRef(r);
  }

  // ---- 4. cut reference lines where the user set changes. Run ends within `snapV` vertices of
  // an existing cut (or of the line's ends) are moved onto it, so junctions do not leave
  // 100 m slivers behind.
  const snapV = opts.snapVertices ?? 2;
  {
    const cutsOf: number[][] = refs.map((ref) => [0, ref.xs.length - 1]);
    const snap = (r: number, j: number) => {
      const cs = cutsOf[r]!;
      let best = -1, bd = snapV + 1;
      for (const v of cs) {
        const d = Math.abs(v - j);
        if (d < bd) [best, bd] = [v, d];
      }
      if (best >= 0) return best;
      cs.push(j);
      return j;
    };
    for (const rs of runs)
      for (const u of rs) {
        u.j0 = snap(u.r, u.j0);
        u.j1 = snap(u.r, u.j1);
      }
  }
  const onRef: { c: number; lo: number; hi: number }[][] = refs.map(() => []);
  runs.forEach((rs, c) => rs.forEach((u) => u.j0 !== u.j1 && onRef[u.r]!.push({ c, lo: Math.min(u.j0, u.j1), hi: Math.max(u.j0, u.j1) })));
  const segments: SegOut[] = [];
  const refBps: number[][] = [];
  const refPieceSeg: number[][] = [];
  for (let r = 0; r < refs.length; r++) {
    const ref = refs[r]!;
    const us = onRef[r]!;
    const bpSet = new Set<number>();
    for (const u of us) {
      bpSet.add(u.lo);
      bpSet.add(u.hi);
    }
    const bps = [...bpSet].sort((a, b) => a - b);
    const nP = Math.max(0, bps.length - 1);
    const users: number[][] = Array.from({ length: nP }, () => []);
    for (const u of us) for (let k = lowerBound(bps, u.lo); k < nP && bps[k + 1]! <= u.hi; k++) users[k]!.push(u.c);
    for (const l of users) {
      l.sort((a, b) => a - b);
      for (let i = l.length - 1; i > 0; i--) if (l[i] === l[i - 1]) l.splice(i, 1);
    }
    const pieceSeg: number[] = new Array(nP).fill(-1);
    for (let k = 0; k < nP; ) {
      if (!users[k]!.length) {
        k++;
        continue;
      }
      let e = k;
      while (e + 1 < nP && sameList(users[e + 1]!, users[k]!)) e++;
      const pts: LonLat[] = [];
      for (let j = bps[k]!; j <= bps[e + 1]!; j++) pts.push([ref.xs[j]!, ref.ys[j]!]);
      const id = segments.length;
      segments.push(makeSeg(pts, users[k]!, inputs));
      for (let q = k; q <= e; q++) pieceSeg[q] = id;
      k = e + 1;
    }
    refBps.push(bps);
    refPieceSeg.push(pieceSeg);
  }

  // ---- 5. orientation per reference line (west→east, or south→north) and corridor lists
  const segRev = new Uint8Array(segments.length);
  refs.forEach((ref, r) => {
    const n = ref.xs.length;
    const dx = (ref.xs[n - 1]! - ref.xs[0]!) * Math.cos(ref.ys[0]! * RAD), dy = ref.ys[n - 1]! - ref.ys[0]!;
    if (Math.abs(dx) >= Math.abs(dy) ? dx < 0 : dy < 0) for (const s of refPieceSeg[r]!) if (s >= 0) segRev[s] = 1;
  });
  segments.forEach((s, i) => {
    if (segRev[i]) s.coords.reverse();
  });
  const corrSegs = runs.map((rs) => {
    const list: number[] = [];
    for (const u of rs) {
      const bps = refBps[u.r]!, ps = refPieceSeg[u.r]!;
      const lo = Math.min(u.j0, u.j1), hi = Math.max(u.j0, u.j1);
      const ids: number[] = [];
      for (let k = lowerBound(bps, lo); k < ps.length && bps[k + 1]! <= hi; k++) {
        const s = ps[k]!;
        if (s >= 0 && ids[ids.length - 1] !== s) ids.push(s);
      }
      const fwdOnRef = u.j1 >= u.j0;
      if (!fwdOnRef) ids.reverse();
      for (const s of ids) {
        const code = fwdOnRef !== (segRev[s] === 1) ? s : -(s + 1);
        if (list[list.length - 1] !== code) list.push(code);
      }
    }
    return list;
  });
  return renumber(segments, corrSegs);
}

function lowerBound(a: number[], x: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m]! < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function sameList(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function makeSeg(pts: LonLat[], users: number[], inputs: SegInput[]): SegOut {
  let cats = 0, snapped = false, tol = Infinity;
  const tpd: Record<number, number> = {};
  for (const c of users) {
    const inp = inputs[c]!;
    cats |= inp.cats;
    snapped ||= inp.snapped;
    tol = Math.min(tol, inp.tol);
    for (const [k, v] of Object.entries(inp.tpd)) tpd[+k] = (tpd[+k] ?? 0) + v;
  }
  return { coords: simplifyLine(pts, Number.isFinite(tol) ? tol : 100), cats, tpd, snapped, users };
}

/**
 * Renumber segments in order of first traversal (corridors in id order), so a corridor's
 * segments mostly have consecutive ids (packs well as deltas).
 */
function renumber(segments: SegOut[], lists: number[][]): SegResult {
  const nS = segments.length;
  const newId = new Int32Array(nS).fill(-1);
  let next = 0;
  for (const l of lists)
    for (const code of l) {
      const s = code >= 0 ? code : -code - 1;
      if (newId[s] === -1) newId[s] = next++;
    }
  for (let s = 0; s < nS; s++) if (newId[s] === -1) newId[s] = next++;
  const out: SegOut[] = new Array(nS);
  for (let s = 0; s < nS; s++) out[newId[s]!] = segments[s]!;
  return { segments: out, corrSegs: lists.map((l) => l.map((code) => (code >= 0 ? newId[code]! : -newId[-code - 1]! - 1))) };
}

/** Rebuild a corridor polyline from its signed segment list. */
export function corridorCoords(segs: number[], segments: { coords: LonLat[] }[]): LonLat[] {
  const out: LonLat[] = [];
  for (const code of segs) {
    const s = code >= 0 ? code : -code - 1;
    let co = segments[s]!.coords;
    if (code < 0) co = [...co].reverse();
    for (const p of co) {
      const q = out[out.length - 1];
      if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
    }
  }
  return out;
}
