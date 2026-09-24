/** An inclusive range of line numbers. */
export type Range = readonly [number, number];

/** Sorted, with overlapping and adjacent ranges merged. */
export function normalize(ranges: readonly Range[]): Range[] {
  const sorted = ranges.filter(([a, b]) => b >= a).map(([a, b]) => [a, b] as [number, number]).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

export function add(ranges: readonly Range[], r: Range): Range[] {
  return normalize([...ranges, r]);
}

/** Drop every range that overlaps `r`. Used to recollapse a revealed block as one unit. */
export function removeOverlapping(ranges: readonly Range[], r: Range): Range[] {
  return ranges.filter(([a, b]) => b < r[0] || a > r[1]).map(([a, b]) => [a, b] as Range);
}

export function intersect(a: Range, b: Range): Range | null {
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  return lo <= hi ? [lo, hi] : null;
}

/** Parts of `outer` covered by `ranges`, and the parts that are not, in order. */
export function partition(outer: Range, ranges: readonly Range[]): Array<{ covered: boolean; range: Range }> {
  const parts: Array<{ covered: boolean; range: Range }> = [];
  let cursor = outer[0];
  for (const r of normalize(ranges)) {
    const hit = intersect(outer, r);
    if (!hit) continue;
    if (hit[0] > cursor) parts.push({ covered: false, range: [cursor, hit[0] - 1] });
    parts.push({ covered: true, range: hit });
    cursor = hit[1] + 1;
  }
  if (cursor <= outer[1]) parts.push({ covered: false, range: [cursor, outer[1]] });
  return parts;
}

export function contains(ranges: readonly Range[], n: number): boolean {
  return ranges.some(([a, b]) => n >= a && n <= b);
}
