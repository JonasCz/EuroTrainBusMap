/**
 * Service calendars as bitmasks over a horizon of `days` days starting at
 * epoch day `start`. Bit i set = service runs on day start+i.
 */
export interface CalendarRow {
  monday: boolean; tuesday: boolean; wednesday: boolean; thursday: boolean;
  friday: boolean; saturday: boolean; sunday: boolean;
  start: number; // epoch day
  end: number; // epoch day inclusive
}

export function newMask(days: number): Uint8Array {
  return new Uint8Array(Math.ceil(days / 8));
}

export function setBit(m: Uint8Array, i: number): void {
  m[i >> 3]! |= 1 << (i & 7);
}
export function getBit(m: Uint8Array, i: number): boolean {
  return (m[i >> 3]! & (1 << (i & 7))) !== 0;
}
export function clearBit(m: Uint8Array, i: number): void {
  m[i >> 3]! &= ~(1 << (i & 7));
}

export function popcount(m: Uint8Array): number {
  let n = 0;
  for (const b of m) {
    let x = b;
    while (x) {
      x &= x - 1;
      n++;
    }
  }
  return n;
}

export function isEmpty(m: Uint8Array): boolean {
  for (const b of m) if (b) return false;
  return true;
}

export function overlaps(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i]! & b[i]!) return true;
  return false;
}

export function orInto(dst: Uint8Array, src: Uint8Array): void {
  for (let i = 0; i < dst.length; i++) dst[i]! |= src[i]!;
}

/**
 * Shift mask by `shift` days (positive = later). Bits shifted out of the
 * horizon are dropped.
 */
export function shiftMask(m: Uint8Array, shift: number, days: number): Uint8Array {
  if (!shift) return m;
  const out = newMask(days);
  for (let i = 0; i < days; i++) {
    if (getBit(m, i)) {
      const j = i + shift;
      if (j >= 0 && j < days) setBit(out, j);
    }
  }
  return out;
}

/** Day of week of epoch day: 0 = Monday … 6 = Sunday. */
export function weekday(epochDay: number): number {
  // 1970-01-01 was a Thursday (3 in Monday-based).
  return (((epochDay + 3) % 7) + 7) % 7;
}

/**
 * Expand calendar.txt row + calendar_dates exceptions (1 = added, 2 = removed)
 * into a mask over [start, start+days).
 */
export function expandService(
  cal: CalendarRow | null,
  exceptions: { day: number; type: number }[],
  start: number,
  days: number,
): Uint8Array {
  const m = newMask(days);
  if (cal) {
    const flags = [cal.monday, cal.tuesday, cal.wednesday, cal.thursday, cal.friday, cal.saturday, cal.sunday];
    for (let i = 0; i < days; i++) {
      const d = start + i;
      if (d >= cal.start && d <= cal.end && flags[weekday(d)]) setBit(m, i);
    }
  }
  for (const e of exceptions) {
    const i = e.day - start;
    if (i < 0 || i >= days) continue;
    if (e.type === 1) setBit(m, i);
    else if (e.type === 2) clearBit(m, i);
  }
  return m;
}

export function maskToBase64(m: Uint8Array): string {
  return Buffer.from(m).toString("base64");
}

export function maskFromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

/** Global dedup store of masks → dense indices. */
export class MaskStore {
  private index = new Map<string, number>();
  readonly masks: string[] = [];
  add(m: Uint8Array): number {
    const k = maskToBase64(m);
    let i = this.index.get(k);
    if (i === undefined) {
      i = this.masks.length;
      this.masks.push(k);
      this.index.set(k, i);
    }
    return i;
  }
}
