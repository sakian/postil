import type { AnchoredSectionMark, Hunk, Side } from '../../../src/core/api-types.ts';
import { partition } from './ranges.ts';

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

/**
 * A section is one run of changed lines in a hunk, with no unchanged line between them. A hunk
 * holds one or more. Sections are numbered across the file in order.
 */
export interface Section {
  index: number;
  hunk: number;
  /** Indices of its first and last line in the hunk's lines. */
  first: number;
  last: number;
  /** Removed lines, if any, as old-file lines. */
  old: { start: number; end: number } | null;
  /** Added lines, if any, as new-file lines. */
  new: { start: number; end: number } | null;
  changed: number;
}

export function fileSections(hunks: readonly Hunk[]): Section[] {
  const out: Section[] = [];
  hunks.forEach((hunk, h) => {
    let cur: Section | null = null;
    hunk.lines.forEach((l, j) => {
      if (l.kind === 'context') {
        cur = null;
        return;
      }
      if (!cur) {
        cur = { index: out.length, hunk: h, first: j, last: j, old: null, new: null, changed: 0 };
        out.push(cur);
      }
      cur.last = j;
      cur.changed++;
      const no = l.kind === 'add' ? l.new_no! : l.old_no!;
      const side = l.kind === 'add' ? 'new' : 'old';
      cur[side] = { start: cur[side]?.start ?? no, end: no };
    });
  });
  return out;
}

/** The ranges to mark when marking a section done: its removed lines and its added lines. */
export function sectionRanges(section: Section): Array<{ side: Side; start: number; end: number }> {
  const out: Array<{ side: Side; start: number; end: number }> = [];
  if (section.new) out.push({ side: 'new', ...section.new });
  if (section.old) out.push({ side: 'old', ...section.old });
  return out;
}

/** A section is done when every line in it is covered by a valid mark. */
export function sectionDone(section: Section, marks: readonly AnchoredSectionMark[]): boolean {
  return sectionRanges(section).every((r) => {
    for (let n = r.start; n <= r.end; n++) if (!covered(marks, r.side, n)) return false;
    return true;
  });
}

/** A hunk is done when every added line and every removed line in it is covered by a valid mark. */
export function hunkDone(hunk: Hunk, marks: readonly AnchoredSectionMark[]): boolean {
  const changed = hunk.lines.filter((l) => l.kind !== 'context');
  if (changed.length === 0) return false;
  return changed.every((l) => (l.kind === 'add' ? covered(marks, 'new', l.new_no!) : covered(marks, 'old', l.old_no!)));
}

/**
 * What un-marking these ranges takes: the marks overlapping them, to remove, and the parts of
 * those marks outside the ranges, to mark again. A mark can span more than one section, as
 * marks made a whole hunk at a time do, and the other sections stay done.
 */
export function unmarkPlan(
  ranges: ReadonlyArray<{ side: Side; start: number; end: number }>,
  marks: readonly AnchoredSectionMark[],
): { remove: AnchoredSectionMark[]; keep: Array<{ side: Side; start: number; end: number }> } {
  const remove = marks.filter((m) =>
    ranges.some((r) => r.side === m.side && m.anchor.start_line! <= r.end && m.anchor.end_line! >= r.start),
  );
  const keep = remove.flatMap((m) =>
    partition([m.anchor.start_line!, m.anchor.end_line!], ranges.filter((r) => r.side === m.side).map((r) => [r.start, r.end] as const))
      .filter((p) => !p.covered)
      .map((p) => ({ side: m.side, start: p.range[0], end: p.range[1] })),
  );
  return { remove, keep };
}
