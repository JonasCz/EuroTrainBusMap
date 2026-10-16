/**
 * "Lines" for the level of detail: a corridor is one hop between two consecutive stations, and
 * different patterns of one route (all stops / skipping stops) give its hops different traffic,
 * hence different LOD levels - a route would be revealed piece by piece. Per category, hops are
 * therefore grouped into chains: corridors meeting in a station where exactly two corridors of that
 * category meet belong to the same chain; chains end at junctions (3+ corridors) and at dead
 * ends. A chain gets the earliest level of its members, so it appears as a whole.
 * (`a` / `b` are plain node ids: stations.)
 */

/**
 * Group id per corridor × category (`c * nCats + k`), −1 where the corridor has no line of that
 * category (or is skipped). `corridors[c].cats` is the Cat bitmask, `cats[k]` the bit of index k.
 * Ids are dense, ordered by first member, so the result is deterministic.
 */
export function lineGroups(
  corridors: ({ a: number; b: number; cats: number } | undefined)[],
  cats: readonly number[],
  skip?: Uint8Array,
): Int32Array {
  const NC = cats.length;
  const parent = new Int32Array(corridors.length * NC).fill(-1);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (let k = 0; k < NC; k++) {
    // corridors of this category per node (station)
    const at = new Map<number, number[]>();
    for (let c = 0; c < corridors.length; c++) {
      const cr = corridors[c];
      if (!cr || !(cr.cats & cats[k]!) || skip?.[c * NC + k]) continue;
      parent[c * NC + k] = c * NC + k;
      for (const city of cr.a === cr.b ? [cr.a] : [cr.a, cr.b]) (at.get(city) ?? at.set(city, []).get(city)!).push(c);
    }
    for (const list of at.values()) {
      if (list.length !== 2) continue;
      const x = find(list[0]! * NC + k), y = find(list[1]! * NC + k);
      if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
    }
  }
  const out = new Int32Array(parent.length).fill(-1);
  const ids = new Map<number, number>();
  for (let i = 0; i < parent.length; i++) {
    if (parent[i] === -1) continue;
    const r = find(i);
    let g = ids.get(r);
    if (g === undefined) ids.set(r, (g = ids.size));
    out[i] = g;
  }
  return out;
}

/** Set every member of a group to the group's smallest level (127 = not drawn is never lowered to). */
export function smoothLevels(levels: Int8Array, group: Int32Array): void {
  const min = new Map<number, number>();
  for (let i = 0; i < group.length; i++) {
    const g = group[i]!;
    if (g < 0 || levels[i] === 127) continue;
    if (levels[i]! < (min.get(g) ?? 127)) min.set(g, levels[i]!);
  }
  for (let i = 0; i < group.length; i++) {
    const g = group[i]!;
    if (g >= 0 && levels[i] !== 127) levels[i] = min.get(g)!;
  }
}
