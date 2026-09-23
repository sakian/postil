import type { DiffLine, FileDiff, Hunk } from '../../../src/core/api-types.ts';
import { intersect, normalize, partition, type Range } from './ranges.ts';

/**
 * Turns a file diff into display rows. Unified rows are the single source of truth; the
 * split view is derived from them, so both views always agree on what is shown.
 *
 * Context between hunks ("gaps") is addressed in new-file line numbers. Inside a gap the
 * old and new files are identical, offset by a constant, so one coordinate is enough.
 */

export interface Gap {
  /** First and last new-file line of the gap. */
  start: number;
  end: number;
  /** old line = new line + offset, anywhere in this gap. */
  offset: number;
  position: 'top' | 'middle' | 'bottom';
  /** The hunk right after this gap, if any. */
  next: Hunk | null;
}

/** Lines a hunk covers on one side. A side with zero lines sits just after its start line. */
function span(start: number, count: number): { begin: number; end: number } {
  return count === 0 ? { begin: start + 1, end: start + 1 } : { begin: start, end: start + count };
}

export function hunkHeader(h: Hunk): string {
  return `@@ -${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@${h.header ? ` ${h.header}` : ''}`;
}

export function gaps(diff: Pick<FileDiff, 'hunks' | 'new_lines'>): Gap[] {
  const { hunks } = diff;
  if (hunks.length === 0 || diff.new_lines === null) return [];
  const out: Gap[] = [];
  const first = hunks[0]!;
  const f = { n: span(first.new_start, first.new_lines), o: span(first.old_start, first.old_lines) };
  out.push({ start: 1, end: f.n.begin - 1, offset: f.o.begin - f.n.begin, position: 'top', next: first });
  for (let i = 1; i < hunks.length; i++) {
    const prev = hunks[i - 1]!;
    const cur = hunks[i]!;
    const p = span(prev.new_start, prev.new_lines);
    const c = { n: span(cur.new_start, cur.new_lines), o: span(cur.old_start, cur.old_lines) };
    out.push({ start: p.end, end: c.n.begin - 1, offset: c.o.begin - c.n.begin, position: 'middle', next: cur });
  }
  const last = hunks.at(-1)!;
  const l = { n: span(last.new_start, last.new_lines), o: span(last.old_start, last.old_lines) };
  out.push({ start: l.n.end, end: diff.new_lines, offset: l.o.end - l.n.end, position: 'bottom', next: null });
  return out.filter((g) => g.start <= g.end);
}

export const EXPAND_STEP = 20;

export type Row =
  | {
      type: 'expander';
      key: string;
      /** Hidden new-file lines. */
      start: number;
      end: number;
      /** Reveal lines just below whatever sits above this block. */
      canDown: boolean;
      /** Reveal lines just above whatever sits below this block. */
      canUp: boolean;
      /** Header of the hunk directly below, shown GitHub-style in the expander. */
      header: string | null;
    }
  | { type: 'collapse'; key: string; start: number; end: number; count: number }
  | { type: 'hunk'; key: string; header: string }
  | {
      type: 'line';
      key: string;
      kind: DiffLine['kind'];
      oldNo: number | null;
      newNo: number | null;
      text: string;
      noEol: boolean;
      /** True for context revealed from a gap rather than part of a hunk. */
      expanded: boolean;
    };

export interface RowOptions {
  /** Revealed gap lines the user asked for (persisted). */
  revealed: readonly Range[];
  /** Revealed lines required for other reasons, such as comments on context lines. */
  forced?: readonly Range[];
  /** New-file content, needed to show revealed lines. Until it loads, gaps stay collapsed. */
  newLines: readonly string[] | null;
}

export function buildRows(diff: Pick<FileDiff, 'hunks' | 'new_lines'>, opts: RowOptions): Row[] {
  const rows: Row[] = [];
  const allGaps = gaps(diff);
  const shown = opts.newLines ? normalize([...opts.revealed, ...(opts.forced ?? [])]) : [];
  const userShown = normalize(opts.revealed);

  const emitGap = (gap: Gap) => {
    const parts = partition([gap.start, gap.end], shown);
    for (const part of parts) {
      const [a, b] = part.range;
      if (part.covered) {
        if (userShown.some((r) => intersect(r, part.range))) {
          rows.push({ type: 'collapse', key: `c${a}`, start: a, end: b, count: b - a + 1 });
        }
        for (let n = a; n <= b; n++) {
          rows.push({
            type: 'line', key: `x${n}`, kind: 'context', oldNo: n + gap.offset, newNo: n,
            text: opts.newLines?.[n - 1] ?? '', noEol: false, expanded: true,
          });
        }
      } else {
        const atFileTop = gap.position === 'top' && a === gap.start;
        const atFileBottom = gap.position === 'bottom' && b === gap.end;
        const touchesNext = b === gap.end && gap.next !== null;
        rows.push({
          type: 'expander', key: `e${a}`, start: a, end: b,
          canDown: !atFileTop, canUp: !atFileBottom,
          header: touchesNext ? hunkHeader(gap.next!) : null,
        });
      }
    }
  };

  const gapBefore = new Map<Hunk, Gap>();
  let bottom: Gap | undefined;
  for (const g of allGaps) {
    if (g.next) gapBefore.set(g.next, g);
    else bottom = g;
  }

  diff.hunks.forEach((hunk, i) => {
    const gap = gapBefore.get(hunk);
    // With a gap, its expander carries the header (and it disappears once fully revealed).
    // Without one, the hunk starts the file or directly abuts the previous hunk: show it plainly.
    if (gap) emitGap(gap);
    else rows.push({ type: 'hunk', key: `h${i}`, header: hunkHeader(hunk) });
    hunk.lines.forEach((l, j) => {
      rows.push({
        type: 'line', key: `l${i}.${j}`, kind: l.kind, oldNo: l.old_no, newNo: l.new_no,
        text: l.text, noEol: l.no_eol === true, expanded: false,
      });
    });
  });
  if (bottom) emitGap(bottom);
  return rows;
}

// ---------------------------------------------------------------------------- split view

export interface Cell {
  kind: DiffLine['kind'];
  no: number;
  text: string;
  noEol: boolean;
  expanded: boolean;
}

export type SplitRow =
  | Exclude<Row, { type: 'line' }>
  | { type: 'pair'; key: string; left: Cell | null; right: Cell | null };

/** Pair deletions with the additions that follow them, side by side. */
export function toSplit(rows: readonly Row[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: Extract<Row, { type: 'line' }>[] = [];
  let adds: Extract<Row, { type: 'line' }>[] = [];

  const cell = (r: Extract<Row, { type: 'line' }>, side: 'old' | 'new'): Cell => ({
    kind: r.kind, no: (side === 'old' ? r.oldNo : r.newNo)!, text: r.text, noEol: r.noEol, expanded: r.expanded,
  });
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const d = dels[i];
      const a = adds[i];
      out.push({ type: 'pair', key: `p${d?.key ?? ''}|${a?.key ?? ''}`, left: d ? cell(d, 'old') : null, right: a ? cell(a, 'new') : null });
    }
    dels = [];
    adds = [];
  };

  for (const r of rows) {
    if (r.type === 'line' && r.kind === 'del') {
      if (adds.length) flush();
      dels.push(r);
    } else if (r.type === 'line' && r.kind === 'add') {
      adds.push(r);
    } else {
      flush();
      if (r.type === 'line') out.push({ type: 'pair', key: `p${r.key}`, left: cell(r, 'old'), right: cell(r, 'new') });
      else out.push(r);
    }
  }
  flush();
  return out;
}

/** Convert an old-file line inside a gap to new-file coordinates, or null if it is not in a gap. */
export function oldToNewInGaps(allGaps: readonly Gap[], oldNo: number): number | null {
  for (const g of allGaps) {
    const n = oldNo - g.offset;
    if (n >= g.start && n <= g.end) return n;
  }
  return null;
}
