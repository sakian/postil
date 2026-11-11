import type { DiffLine, Hunk } from '../../../src/core/api-types.ts';

/**
 * When a block of code is rewritten, git still matches the few lines the old and new code
 * happen to share (blank lines, `}`, `return;`). The diff then alternates between short runs of
 * removed and added lines, so unrelated old and new code end up interleaved and the new code
 * can't be read top to bottom.
 *
 * This merges those runs back together. A short unchanged run between two changed runs is
 * shown as removed and added again when the changes on both sides of it are much bigger than
 * it is, so the rewrite reads as one block of removed lines followed by one block of added
 * lines. Small edits separated by real code are left alone. The idea is the same as the
 * semantic cleanup in diff-match-patch, applied to lines.
 */

/** An unchanged run costing more than this is real shared code, however big the changes around it. */
const MAX_COST = 3;
/** The changes on each side of an unchanged run must be this many times its cost to absorb it. */
const RATIO = 3;
/** Cost of a line with no real content, which matches across unrelated code by chance. */
const TRIVIAL_COST = 0.5;

type Run =
  | { kind: 'change'; dels: DiffLine[]; adds: DiffLine[] }
  | { kind: 'same'; lines: DiffLine[] };

/** Blank lines and lines holding at most one short word, like `}`, `});`, `return;` or `} else {`. */
export function trivial(text: string): boolean {
  const words = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.length === 0 || (words.length === 1 && words[0]!.length <= 8);
}

function cost(lines: readonly DiffLine[]): number {
  return lines.reduce((n, l) => n + (trivial(l.text) ? TRIVIAL_COST : 1), 0);
}

/**
 * How much a changed run replaces, or zero when it only adds or only removes lines. Pure
 * insertions and deletions read fine around unchanged lines, since nothing old and new is mixed.
 */
function size(run: Extract<Run, { kind: 'change' }>): number {
  return run.dels.length > 0 && run.adds.length > 0 ? Math.max(run.dels.length, run.adds.length) : 0;
}

function runs(lines: readonly DiffLine[]): Run[] {
  const out: Run[] = [];
  for (const l of lines) {
    const last = out.at(-1);
    if (l.kind === 'context') {
      if (last?.kind === 'same') last.lines.push(l);
      else out.push({ kind: 'same', lines: [l] });
    } else if (last?.kind === 'change') {
      (l.kind === 'del' ? last.dels : last.adds).push(l);
    } else {
      out.push(l.kind === 'del' ? { kind: 'change', dels: [l], adds: [] } : { kind: 'change', dels: [], adds: [l] });
    }
  }
  return out;
}

function regroupLines(lines: readonly DiffLine[]): DiffLine[] | null {
  const list = runs(lines);
  let merged = false;
  // Merging grows the changed runs, which can then absorb the next unchanged run, so repeat
  // until nothing changes.
  for (let again = true; again; ) {
    again = false;
    for (let i = 1; i + 1 < list.length; i++) {
      const [before, same, after] = [list[i - 1]!, list[i]!, list[i + 1]!];
      if (before.kind !== 'change' || same.kind !== 'same' || after.kind !== 'change') continue;
      const c = cost(same.lines);
      if (c > MAX_COST || c * RATIO > Math.min(size(before), size(after))) continue;
      const dels = same.lines.map((l): DiffLine => ({ ...l, kind: 'del', new_no: null }));
      const adds = same.lines.map((l): DiffLine => ({ ...l, kind: 'add', old_no: null }));
      list.splice(i - 1, 3, { kind: 'change', dels: [...before.dels, ...dels, ...after.dels], adds: [...before.adds, ...adds, ...after.adds] });
      merged = again = true;
      i--;
    }
  }
  if (!merged) return null;
  return list.flatMap((r) => (r.kind === 'same' ? r.lines : [...r.dels, ...r.adds]));
}

/** The hunks with rewritten blocks regrouped. Hunks that need nothing are returned as they are. */
export function regroup(hunks: readonly Hunk[]): Hunk[] {
  return hunks.map((h) => {
    const lines = regroupLines(h.lines);
    return lines ? { ...h, lines } : h;
  });
}
