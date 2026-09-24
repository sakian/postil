import type { Range } from './ranges.ts';

/** File versions whose expanded context is remembered; the oldest are forgotten first. */
export const MAX_EXPANDED_BLOBS = 400;

/**
 * Add a file version's revealed ranges, keeping only the most recent versions. The saved state has
 * a size limit, and a long review would otherwise grow it past that and stop saving at all.
 */
export function withExpanded(expanded: Record<string, Range[]>, blob: string, ranges: Range[]): Record<string, Range[]> {
  const { [blob]: _old, ...rest } = expanded;
  const keys = Object.keys(rest);
  const keep = keys.slice(Math.max(0, keys.length - (MAX_EXPANDED_BLOBS - 1)));
  const next: Record<string, Range[]> = {};
  for (const k of keep) next[k] = rest[k]!;
  next[blob] = ranges; // insertion order doubles as recency
  return next;
}
