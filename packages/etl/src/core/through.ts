/**
 * Through runs split into several trips ("stay seated"): some feeds publish one train as consecutive trips
 * with the same train number, the next one starting where the previous one ends a few minutes later
 * (ÖBB / ČD at borders or where a portion is added, Rejseplanen at line changes, the Glacier Express at
 * Disentis, Renfe at León). Each piece alone forces a change in the journey search and splits the
 * schedule, so the pieces are joined into one run on the days they all operate.
 */

export interface RunPiece {
  key: number;
  /** feed index: pieces of one run come from one feed */
  feed: number;
  /** train number (trip_short_name); pieces without one are never joined */
  number: string;
  /** time zone of the times (a run never changes it) */
  tz: string;
  /** stations of the stops in order */
  stations: number[];
  /** departure at the first stop, arrival at the last (minutes after midnight of the service day) */
  dep: number;
  arr: number;
  /** service days */
  mask: Uint8Array;
}

export interface ThroughRun {
  /** trip keys in running order */
  keys: number[];
  /** days on which the joined run operates (all pieces run) */
  mask: Uint8Array;
}

export interface ThroughResult {
  runs: ThroughRun[];
  /** days left to a piece outside its joined run (only pieces that also run on other days) */
  rest: Map<number, Uint8Array>;
}

/** Longest stop (minutes) at the station where one piece ends and the next begins. */
export const MAX_THROUGH_DWELL = 20;

function and(a: Uint8Array, b: Uint8Array): Uint8Array {
  const m = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) m[i] = a[i]! & b[i]!;
  return m;
}

function any(m: Uint8Array): boolean {
  for (let i = 0; i < m.length; i++) if (m[i]) return true;
  return false;
}

/**
 * Piece b continues piece a: same feed, number and time zone, b starts at a's last station 0 – maxDwell min
 * after a arrives, both run on a common day, and b does not come back over a's stations (a turnback or a loop
 * under the same number is a new journey, not a through run).
 */
export function continues(a: RunPiece, b: RunPiece, maxDwell = MAX_THROUGH_DWELL): boolean {
  if (a.key === b.key || a.feed !== b.feed || a.tz !== b.tz) return false;
  const na = a.number.trim(), nb = b.number.trim();
  if (!na || na !== nb) return false;
  if (a.stations.length < 2 || b.stations.length < 2) return false;
  const junction = a.stations[a.stations.length - 1]!;
  if (b.stations[0] !== junction) return false;
  const dwell = b.dep - a.arr;
  if (dwell < 0 || dwell > maxDwell) return false;
  const seen = new Set(a.stations);
  for (let i = 1; i < b.stations.length; i++) if (b.stations[i] !== junction && seen.has(b.stations[i]!)) return false;
  return any(and(a.mask, b.mask));
}

/**
 * Finds the through runs among the pieces. A piece is linked to its successor only when the choice is unique
 * (one candidate after it, and it is the only candidate before that one); chains are followed as long as the
 * pieces share a day. The joined run takes the days common to all its pieces; a piece that also runs on other
 * days keeps those as its own run (`rest`).
 */
export function findThroughRuns(pieces: RunPiece[], maxDwell = MAX_THROUGH_DWELL): ThroughResult {
  const byStart = new Map<string, RunPiece[]>();
  const sk = (feed: number, number: string, station: number) => `${feed}\u0001${number.trim()}\u0001${station}`;
  for (const p of pieces) {
    if (p.stations.length < 2 || !p.number.trim()) continue;
    const k = sk(p.feed, p.number, p.stations[0]!);
    let l = byStart.get(k);
    if (!l) byStart.set(k, (l = []));
    l.push(p);
  }
  const next = new Map<number, RunPiece[]>();
  const prevCount = new Map<number, number>();
  for (const a of pieces) {
    if (a.stations.length < 2 || !a.number.trim()) continue;
    const cands = (byStart.get(sk(a.feed, a.number, a.stations[a.stations.length - 1]!)) ?? []).filter((b) => continues(a, b, maxDwell));
    if (!cands.length) continue;
    next.set(a.key, cands);
    for (const b of cands) prevCount.set(b.key, (prevCount.get(b.key) ?? 0) + 1);
  }
  const succ = new Map<number, RunPiece>();
  const hasPred = new Set<number>();
  for (const [a, cands] of next) {
    if (cands.length !== 1) continue;
    const b = cands[0]!;
    if (prevCount.get(b.key) !== 1) continue;
    succ.set(a, b);
    hasPred.add(b.key);
  }
  const byKey = new Map(pieces.map((p) => [p.key, p]));
  const runs: ThroughRun[] = [];
  const rest = new Map<number, Uint8Array>();
  const used = new Set<number>();
  const heads = pieces.filter((p) => succ.has(p.key) && !hasPred.has(p.key)).sort((x, y) => x.key - y.key);
  const close = (keys: number[], mask: Uint8Array) => {
    if (keys.length < 2) return;
    runs.push({ keys, mask });
    for (const k of keys) {
      used.add(k);
      const own = byKey.get(k)!.mask;
      const left = new Uint8Array(own.length);
      let n = 0;
      for (let i = 0; i < own.length; i++) n |= left[i] = own[i]! & ~mask[i]!;
      if (n) rest.set(k, left);
    }
  };
  for (const h of heads) {
    let keys = [h.key];
    let mask = h.mask;
    let cur = h;
    for (let b = succ.get(cur.key); b && !used.has(b.key) && !keys.includes(b.key); b = succ.get(cur.key)) {
      const m = and(mask, b.mask);
      if (!any(m)) {
        // no common day with the rest of the chain: the chain so far is one run, b starts the next
        close(keys, mask);
        keys = [b.key];
        mask = b.mask;
      } else {
        keys.push(b.key);
        mask = m;
      }
      cur = b;
    }
    close(keys, mask);
  }
  return { runs, rest };
}
