import type { AnchoredSectionMark, Hunk, Side } from '../../../src/core/api-types.ts';

/**
 * Marks that still hold for a file in the diff being viewed: their lines are unchanged, perhaps
 * moved. Each side is matched by that side's path, which differs for a renamed file.
 */
export function validMarks(
  marks: readonly AnchoredSectionMark[],
  file: { path: string; old_path: string | null; new_path: string | null },
): AnchoredSectionMark[] {
  return marks.filter((m) => {
    const path = (m.side === 'old' ? file.old_path : file.new_path) ?? file.path;
    return (m.anchor.state === 'current' || m.anchor.state === 'moved') && m.anchor.path === path && m.anchor.start_line !== null;
  });
}

function covered(marks: readonly AnchoredSectionMark[], side: Side, n: number): boolean {
  return marks.some((m) => m.side === side && n >= m.anchor.start_line! && n <= m.anchor.end_line!);
}

/** A hunk is done when every added line and every removed line in it is covered by a valid mark. */
export function hunkDone(hunk: Hunk, marks: readonly AnchoredSectionMark[]): boolean {
  const changed = hunk.lines.filter((l) => l.kind !== 'context');
  if (changed.length === 0) return false;
  return changed.every((l) => (l.kind === 'add' ? covered(marks, 'new', l.new_no!) : covered(marks, 'old', l.old_no!)));
}

/** The ranges to mark when marking a hunk done: its full span on each side that has lines. */
export function hunkRanges(hunk: Hunk): Array<{ side: Side; start: number; end: number }> {
  const out: Array<{ side: Side; start: number; end: number }> = [];
  if (hunk.new_lines > 0) out.push({ side: 'new', start: hunk.new_start, end: hunk.new_start + hunk.new_lines - 1 });
  if (hunk.old_lines > 0) out.push({ side: 'old', start: hunk.old_start, end: hunk.old_start + hunk.old_lines - 1 });
  return out;
}

/** Marks overlapping a hunk, to remove when the user un-marks it. */
export function marksOverlapping(hunk: Hunk, marks: readonly AnchoredSectionMark[]): AnchoredSectionMark[] {
  const ranges = hunkRanges(hunk);
  return marks.filter((m) =>
    ranges.some((r) => r.side === m.side && m.anchor.start_line! <= r.end && m.anchor.end_line! >= r.start),
  );
}
