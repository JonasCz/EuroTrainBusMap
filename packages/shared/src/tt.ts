/**
 * Transfer timetable ("tt"): a compact, deduplicated copy of every pattern and trip of the network,
 * used by the web app to search connections with changes (reach with 1, 2 … transfers) without
 * loading hundreds of timetable shards. Written by the ETL's map-data stage:
 *
 *   <build>/tt/index.json     TtIndex – chunk list and the chunk of every city
 *   <build>/tt/<n>.bin.gz     gzipped TtChunk (varint stream, see encodeTtChunk)
 *   <build>/tt/<n>.lines.gz   gzipped TtLines: geometry of the chunk's corridors (drawn after the search)
 *
 * Chunk 0 ("trunk") holds every long-distance train and coach of Europe; the other chunks are regions
 * (k-d split of the cities by regional rail / bus traffic) holding every regional train and bus that
 * can be boarded in one of their cities. A search from a city needs the trunk plus the chunks of the
 * cities where it changes. Patterns carry a global id so a pattern found in two chunks is kept once.
 *
 * Every chunk also carries the walking transfer minutes between the stations of its cities (every pair
 * within walking range, see walk.ts; pairs missing there have no transfer) and a
 * simplified geometry (≈ 100 m) of the corridors its patterns run on, to draw the lines reached with
 * changes on the map.
 */

/** 2: a brand per pattern (TtChunk.pBrand, TtIndex.brands); version 1 chunks still decode (no brands). */
export const TT_VERSION = 2;
/** Version of the line files (unchanged by the brands). */
export const TT_LINES_VERSION = 1;

export interface TtIndex {
  version: number;
  /** chunk files relative to the build directory; chunk 0 is the trunk (long-distance rail + coach) */
  chunks: { file: string; lines: string; bytes: number; lineBytes: number; patterns: number; trips: number }[];
  /** chunk of every city (city id → index into `chunks`), one character each: TT_ALPHABET[chunk] */
  cityChunk: string;
  /** brand names (TtChunk.pBrand indexes them; see routeBrand); missing before version 2 */
  brands?: string[];
}

/**
 * The brand of a route, telling services of one mode apart in connections with changes ("TGV INOUI" vs
 * "Intercités", "TER", "FlixBus"): the words of its name before the first one with a digit ("FlixBus N1138" →
 * "FlixBus", "IC 850 TÓPART" → "IC", "RE 7" → "RE") and before a route description ("ALSA - Irun-Tuy" → "ALSA");
 * a name that is only a line code ("S1", "C2", "7"), or regional rail named by a mission code ("QIWI"), gives the agency.
 */
export function routeBrand(name: string, agency = "", cat = 0): string {
  // regional rail named by its mission code (RER / Transilien "QIWI", "KALI"): the agency
  if (cat === 2 && /^[A-Z]{4}$/.test(name.trim())) return agency.trim() || name.trim();
  const words = name.trim().split(/\s+/);
  const i = words.findIndex((w) => /\d/.test(w));
  let b = (i >= 0 ? words.slice(0, i) : words).join(" ");
  const dash = b.indexOf(" - ");
  if (dash >= 2) b = b.slice(0, dash);
  b = b.replace(/[\s:,/–-]+$/, "");
  return b.length >= 2 ? b : agency.trim() || name.trim();
}

export const TT_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-";

/** Decoded chunk: flat typed arrays (station ids, minutes, 1e-5 degrees). */
export interface TtChunk {
  /** global pattern id per pattern */
  pId: Int32Array;
  /** Cat bit per pattern */
  pCat: Uint8Array;
  /** brand per pattern (TtIndex.brands; 0 in version 1 chunks) */
  pBrand: Int32Array;
  /** timezone index per pattern (NetworkFile.timezones) */
  pTz: Uint16Array;
  /** stop offsets: stops of pattern p are pStop[p] … pStop[p+1]-1 */
  pStop: Int32Array;
  stStation: Int32Array;
  /** arrival / departure offsets (minutes from trip start) */
  stArr: Int32Array;
  stDep: Int32Array;
  /** trip offsets: trips of pattern p are pTrip[p] … pTrip[p+1]-1, sorted by start */
  pTrip: Int32Array;
  /** start minutes (service day, pattern tz) and calendar index per trip */
  trStart: Int32Array;
  trCal: Int32Array;
  /** walking transfers: [stationA, stationB, minutes] triples (symmetric, a < b) */
  walk: Int32Array;
}

/** Decoded line file of a chunk: the corridors its patterns run on, with simplified geometry. */
export interface TtLines {
  /** corridors used by the patterns: id, station a < b, segment codes (Corridor.segs) */
  cId: Int32Array;
  cA: Int32Array;
  cB: Int32Array;
  cSeg: Int32Array;
  cSegCodes: Int32Array;
  /** segments: id and simplified coordinates (lon, lat pairs in units of TT_COORD degrees) */
  sId: Int32Array;
  sPt: Int32Array;
  sCoords: Int32Array;
}

/** Input pattern for the encoder. */
export interface TtPatternIn {
  id: number;
  cat: number;
  tz: number;
  /** index into TtIndex.brands */
  brand?: number;
  stations: number[];
  arr: number[];
  dep: number[];
  /** [start, calendar] pairs */
  trips: [number, number][];
}

export interface TtChunkIn {
  patterns: TtPatternIn[];
  walk: [number, number, number][];
}

export interface TtLinesIn {
  corridors: { id: number; a: number; b: number; segs: number[] }[];
  /** segment id → coordinates [lon, lat] */
  segments: { id: number; coords: [number, number][] }[];
}

const MAGIC = 0x54_54_31; // "TT1"
const MAGIC_LINES = 0x54_54_4c; // "TTL"
/** Coordinate unit of the line files (≈ 11 m; the lines are simplified to ≈ 100 m anyway). */
export const TT_COORD = 1e-4;

class Writer {
  buf = new Uint8Array(1 << 16);
  n = 0;
  private grow(k: number): void {
    if (this.n + k <= this.buf.length) return;
    let len = this.buf.length * 2;
    while (len < this.n + k) len *= 2;
    const b = new Uint8Array(len);
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
  }
  u(x: number): void {
    this.grow(10);
    // unsigned varint (x < 2^53)
    while (x >= 128) {
      this.buf[this.n++] = (x % 128) | 128;
      x = Math.floor(x / 128);
    }
    this.buf[this.n++] = x;
  }
  z(x: number): void {
    this.u(x >= 0 ? 2 * x : -2 * x - 1);
  }
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.n);
  }
}

class Reader {
  i = 0;
  constructor(private b: Uint8Array) {}
  u(): number {
    let x = 0, mul = 1, c: number;
    do {
      c = this.b[this.i++]!;
      x += (c & 127) * mul;
      mul *= 128;
    } while (c >= 128);
    return x;
  }
  z(): number {
    const v = this.u();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  }
}

/** Binary encoding of one chunk (to be gzipped). Patterns are sorted by id; trips by start. */
export function encodeTtChunk(c: TtChunkIn): Uint8Array {
  const w = new Writer();
  w.u(MAGIC);
  w.u(TT_VERSION);
  const pats = [...c.patterns].sort((a, b) => a.id - b.id);
  w.u(pats.length);
  let pid = 0;
  for (const p of pats) {
    w.u(p.id - pid);
    pid = p.id;
    w.u(p.cat);
    w.u(p.tz);
    w.u(p.brand ?? 0);
    const n = p.stations.length;
    w.u(n);
    let prev = 0;
    for (let i = 0; i < n; i++) {
      w.z(p.stations[i]! - prev);
      prev = p.stations[i]!;
    }
    // offsets: arrival at the first stop, then per stop the run time and the dwell
    w.z(p.arr[0]!);
    w.z(p.dep[0]! - p.arr[0]!);
    for (let i = 1; i < n; i++) {
      w.z(p.arr[i]! - p.dep[i - 1]!);
      w.z(p.dep[i]! - p.arr[i]!);
    }
    const trips = [...p.trips].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    w.u(trips.length);
    let ps = 0;
    for (const [s, cal] of trips) {
      w.z(s - ps);
      ps = s;
      w.u(cal);
    }
  }
  const walk = [...c.walk].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  w.u(walk.length);
  let pa = 0;
  for (const [a, b, m] of walk) {
    w.z(a - pa);
    pa = a;
    w.z(b - a);
    w.u(m);
  }
  return w.bytes();
}

/** Binary encoding of the lines of one chunk (to be gzipped). */
export function encodeTtLines(c: TtLinesIn): Uint8Array {
  const w = new Writer();
  w.u(MAGIC_LINES);
  w.u(TT_LINES_VERSION);
  const cors = [...c.corridors].sort((a, b) => a.id - b.id);
  w.u(cors.length);
  let cid = 0, pc = 0;
  for (const k of cors) {
    w.u(k.id - cid);
    cid = k.id;
    w.u(k.a);
    w.z(k.b - k.a);
    w.u(k.segs.length);
    for (const code of k.segs) {
      w.z(code - pc);
      pc = code;
    }
  }
  const segs = [...c.segments].sort((a, b) => a.id - b.id);
  w.u(segs.length);
  let sid = 0, lon = 0, lat = 0;
  for (const s of segs) {
    w.u(s.id - sid);
    sid = s.id;
    w.u(s.coords.length);
    for (const [x, y] of s.coords) {
      const qx = Math.round(x / TT_COORD), qy = Math.round(y / TT_COORD);
      w.z(qx - lon);
      w.z(qy - lat);
      lon = qx;
      lat = qy;
    }
  }
  return w.bytes();
}

export function decodeTtChunk(bytes: Uint8Array): TtChunk {
  const r = new Reader(bytes);
  if (r.u() !== MAGIC) throw new Error("not a transfer timetable chunk");
  const v = r.u();
  if (v !== TT_VERSION && v !== 1) throw new Error(`transfer timetable version ${v}, expected ${TT_VERSION}`);
  const nP = r.u();
  const pId = new Int32Array(nP), pCat = new Uint8Array(nP), pTz = new Uint16Array(nP), pBrand = new Int32Array(nP);
  const pStop = new Int32Array(nP + 1), pTrip = new Int32Array(nP + 1);
  const st = new Grow(), arr = new Grow(), dep = new Grow(), ts = new Grow(), tc = new Grow();
  let pid = 0;
  for (let p = 0; p < nP; p++) {
    pid += r.u();
    pId[p] = pid;
    pCat[p] = r.u();
    pTz[p] = r.u();
    if (v >= 2) pBrand[p] = r.u();
    const n = r.u();
    let prev = 0;
    for (let i = 0; i < n; i++) {
      prev += r.z();
      st.push(prev);
    }
    let a = r.z();
    let d = a + r.z();
    arr.push(a);
    dep.push(d);
    for (let i = 1; i < n; i++) {
      a = d + r.z();
      d = a + r.z();
      arr.push(a);
      dep.push(d);
    }
    pStop[p + 1] = st.n;
    const nt = r.u();
    let s = 0;
    for (let i = 0; i < nt; i++) {
      s += r.z();
      ts.push(s);
      tc.push(r.u());
    }
    pTrip[p + 1] = ts.n;
  }
  const nW = r.u();
  const walk = new Int32Array(nW * 3);
  let pa = 0;
  for (let i = 0; i < nW; i++) {
    pa += r.z();
    walk[3 * i] = pa;
    walk[3 * i + 1] = pa + r.z();
    walk[3 * i + 2] = r.u();
  }
  return {
    pId, pCat, pTz, pBrand, pStop,
    stStation: st.done(), stArr: arr.done(), stDep: dep.done(),
    pTrip, trStart: ts.done(), trCal: tc.done(),
    walk,
  };
}

export function decodeTtLines(bytes: Uint8Array): TtLines {
  const r = new Reader(bytes);
  if (r.u() !== MAGIC_LINES) throw new Error("not a transfer line file");
  const v = r.u();
  if (v !== TT_LINES_VERSION) throw new Error(`transfer line file version ${v}, expected ${TT_LINES_VERSION}`);
  const nC = r.u();
  const cId = new Int32Array(nC), cA = new Int32Array(nC), cB = new Int32Array(nC), cSeg = new Int32Array(nC + 1);
  const codes = new Grow();
  let cid = 0, pc = 0;
  for (let i = 0; i < nC; i++) {
    cid += r.u();
    cId[i] = cid;
    cA[i] = r.u();
    cB[i] = cA[i]! + r.z();
    const n = r.u();
    for (let k = 0; k < n; k++) {
      pc += r.z();
      codes.push(pc);
    }
    cSeg[i + 1] = codes.n;
  }
  const nS = r.u();
  const sId = new Int32Array(nS), sPt = new Int32Array(nS + 1);
  const coords = new Grow();
  let sid = 0, lon = 0, lat = 0;
  for (let i = 0; i < nS; i++) {
    sid += r.u();
    sId[i] = sid;
    const n = r.u();
    for (let k = 0; k < n; k++) {
      lon += r.z();
      lat += r.z();
      coords.push(lon);
      coords.push(lat);
    }
    sPt[i + 1] = coords.n / 2;
  }
  return { cId, cA, cB, cSeg, cSegCodes: codes.done(), sId, sPt, sCoords: coords.done() };
}

/** Growable Int32 buffer. */
export class Grow {
  a = new Int32Array(1024);
  n = 0;
  push(x: number): void {
    if (this.n === this.a.length) {
      const b = new Int32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = x;
  }
  done(): Int32Array {
    return this.a.slice(0, this.n);
  }
}

/** City → chunk, from TtIndex.cityChunk. */
export function cityChunks(index: TtIndex): Uint8Array {
  const out = new Uint8Array(index.cityChunk.length);
  for (let i = 0; i < out.length; i++) out[i] = TT_ALPHABET.indexOf(index.cityChunk[i]!);
  return out;
}
