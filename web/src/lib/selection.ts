import type { Side } from '../../../src/core/api-types.ts';
import type { Row, SplitRow } from './rows.ts';

/** A comment target: an inclusive line range on one side of the diff. */
export interface Selection {
  side: Side;
  start: number;
  end: number;
}

function span(side: Side, nos: number[]): Selection | null {
  return nos.length ? { side, start: Math.min(...nos), end: Math.max(...nos) } : null;
}

/**
 * In the unified view a drag can cross deleted and added lines. Comments almost always
 * target the new code, so the new side wins whenever the range touches it; the old side
 * is used only when every selected line is a deletion.
 */
export function unifiedSelection(rows: readonly Row[], from: number, to: number): Selection | null {
  const [a, b] = from <= to ? [from, to] : [to, from];
  const lines = rows.slice(a, b + 1).filter((r): r is Extract<Row, { type: 'line' }> => r.type === 'line');
  return (
    span('new', lines.flatMap((l) => (l.newNo === null ? [] : [l.newNo]))) ??
    span('old', lines.flatMap((l) => (l.oldNo === null ? [] : [l.oldNo])))
  );
}

/** In the split view the column decides the side. */
export function splitSelection(rows: readonly SplitRow[], from: number, to: number, side: Side): Selection | null {
  const [a, b] = from <= to ? [from, to] : [to, from];
  const nos = rows.slice(a, b + 1).flatMap((r) => {
    if (r.type !== 'pair') return [];
    const c = side === 'old' ? r.left : r.right;
    return c ? [c.no] : [];
  });
  return span(side, nos);
}

export function isSelected(sel: Selection | null, side: Side, no: number | null): boolean {
  return sel !== null && no !== null && sel.side === side && no >= sel.start && no <= sel.end;
}

/** Which side a unified line belongs to when it is clicked on its own. */
export function unifiedSide(kind: 'context' | 'add' | 'del'): Side {
  return kind === 'del' ? 'old' : 'new';
}
