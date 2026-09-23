import type { Hunk } from '../git/types.ts';

/**
 * Where a comment's lines are in a newer version of its file.
 * - current:  same content as when commented
 * - moved:    the anchored lines are unchanged, only shifted by edits elsewhere
 * - outdated: the anchored lines themselves changed; the range covers what replaced them
 * - gone:     the file no longer exists, or is now empty
 */
export type AnchorState = 'current' | 'moved' | 'outdated' | 'gone';

export interface Anchor {
  state: AnchorState;
  /** Path in the target version (differs from the thread's path after a rename). */
  path: string;
  start_line: number | null;
  end_line: number | null;
  /** The target version's lines at the anchor, when the comment is outdated. */
  current_text?: string;
}

/**
 * Map old line numbers to new ones through zero-context hunks, as `git diff -U0` produces
 * them. Returns null for a line that was changed or deleted.
 */
export function lineMapper(hunks: readonly Hunk[]): (oldNo: number) => number | null {
  return (n) => {
    let delta = 0;
    for (const h of hunks) {
      if (h.old_lines === 0) {
        // A pure insertion after old line `old_start` shifts everything below it.
        if (n > h.old_start) delta += h.new_lines;
        else break;
        continue;
      }
      if (n < h.old_start) break;
      if (n < h.old_start + h.old_lines) return null;
      delta += h.new_lines - h.old_lines;
    }
    return n + delta;
  };
}

/** New-side lines a hunk covers (empty for a pure deletion). */
function newSpan(h: Hunk): [number, number] | null {
  return h.new_lines > 0 ? [h.new_start, h.new_start + h.new_lines - 1] : null;
}

/**
 * Re-anchor the inclusive old range [start, end] through `hunks`. `newLineCount` is the number
 * of lines in the new file.
 */
export function reanchor(
  hunks: readonly Hunk[],
  start: number,
  end: number,
  newLineCount: number,
): { state: Exclude<AnchorState, 'current'>; start: number; end: number } | { state: 'gone' } {
  if (newLineCount === 0) return { state: 'gone' };
  const map = lineMapper(hunks);
  const mapped = Array.from({ length: end - start + 1 }, (_, i) => map(start + i));
  const first = mapped[0];
  const last = mapped.at(-1);

  // Unchanged and still contiguous: nothing was inserted inside the range either.
  if (mapped.every((m) => m !== null) && first != null && last != null && last - first === end - start) {
    return { state: 'moved', start: first, end: last };
  }

  // Outdated: cover whatever now stands where the range was.
  const lines: number[] = mapped.filter((m): m is number => m !== null);
  for (const h of hunks) {
    const touches =
      h.old_lines === 0 ? h.old_start >= start && h.old_start < end : h.old_start <= end && h.old_start + h.old_lines - 1 >= start;
    if (!touches) continue;
    const span = newSpan(h);
    if (span) lines.push(span[0], span[1]);
    else lines.push(Math.max(1, h.new_start)); // deleted: point at the line just before the gap
  }
  const lo = Math.max(1, Math.min(...lines));
  const hi = Math.min(newLineCount, Math.max(...lines));
  return { state: 'outdated', start: Math.min(lo, hi), end: Math.max(lo, hi) };
}
