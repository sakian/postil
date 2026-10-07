import type { DiffLine, FileDiff, Hunk } from '../../../src/core/api-types.ts';
import { intersect, normalize, partition, type Range } from './ranges.ts';
import { fileSections } from './sections.ts';

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
      /** Header of the hunk directly below, shown in the expander. */
      header: string | null;
      /** Index of the hunk directly below, when this expander heads it. */
      hunk: number | null;
    }
  | { type: 'collapse'; key: string; start: number; end: number; count: number }
  | { type: 'hunk'; key: string; header: string; hunk: number }
  /** A section the user marked done, or a hunk whose sections all are, folded to one line. */
  | { type: 'done'; key: string; hunk: number; section: number | null; changed: number }
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
      /** The hunk this line belongs to; null for revealed context. */
      hunk: number | null;
      /** The section this changed line belongs to; null for context. */
      section: number | null;
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
            text: opts.newLines?.[n - 1] ?? '', noEol: false, expanded: true, hunk: null, section: null,
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
          hunk: touchesNext ? diff.hunks.indexOf(gap.next!) : null,
        });
      }
    }
  };

  const sectionOf = new Map<string, number>();
  for (const s of fileSections(diff.hunks)) for (let j = s.first; j <= s.last; j++) sectionOf.set(`${s.hunk}.${j}`, s.index);

  const gapBefore = new Map<Hunk, Gap>();
  let bottom: Gap | undefined;
  for (const g of allGaps) {
    if (g.next) gapBefore.set(g.next, g);
    else bottom = g;
  }

  diff.hunks.forEach((hunk, i) => {
    const gap = gapBefore.get(hunk);
    // The expander of the gap above carries the hunk's header while any of the gap is hidden.
    // Otherwise the hunk gets its own header row, which also holds its "done" control.
    if (gap) emitGap(gap);
    const last = rows.at(-1);
    if (!(last?.type === 'expander' && last.hunk === i)) rows.push({ type: 'hunk', key: `h${i}`, header: hunkHeader(hunk), hunk: i });
    hunk.lines.forEach((l, j) => {
      rows.push({
        type: 'line', key: `l${i}.${j}`, kind: l.kind, oldNo: l.old_no, newNo: l.new_no,
        text: l.text, noEol: l.no_eol === true, expanded: false, hunk: i, section: sectionOf.get(`${i}.${j}`) ?? null,
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
  | { type: 'pair'; key: string; left: Cell | null; right: Cell | null; hunk: number | null; section: number | null };

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
      out.push({
        type: 'pair', key: `p${d?.key ?? ''}|${a?.key ?? ''}`, left: d ? cell(d, 'old') : null, right: a ? cell(a, 'new') : null,
        hunk: (d ?? a)!.hunk, section: (d ?? a)!.section,
      });
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
      if (r.type === 'line') out.push({ type: 'pair', key: `p${r.key}`, left: cell(r, 'old'), right: cell(r, 'new'), hunk: r.hunk, section: r.section });
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

/**
 * Replace the lines of folded sections with one "done" row each, and a hunk whose sections are
 * all folded, its unchanged lines too, with one row. Works on unified and split rows alike,
 * since both carry the hunk and section on their line rows.
 */
export function foldDone<T extends { type: string; hunk?: number | null; section?: number | null }>(
  rows: readonly T[],
  folded: { hunks: ReadonlySet<number>; sections: ReadonlySet<number> },
  changedLines: { hunk: (hunk: number) => number; section: (section: number) => number },
): Array<T | Extract<Row, { type: 'done' }>> {
  const out: Array<T | Extract<Row, { type: 'done' }>> = [];
  const emitted = new Set<string>();
  for (const r of rows) {
    const isLine = r.type === 'line' || r.type === 'pair';
    const h = isLine ? r.hunk ?? null : null;
    const s = isLine ? r.section ?? null : null;
    if (h !== null && folded.hunks.has(h)) {
      if (!emitted.has(`h${h}`)) {
        emitted.add(`h${h}`);
        out.push({ type: 'done', key: `d${h}`, hunk: h, section: null, changed: changedLines.hunk(h) });
      }
    } else if (h !== null && s !== null && folded.sections.has(s)) {
      if (!emitted.has(`s${s}`)) {
        emitted.add(`s${s}`);
        out.push({ type: 'done', key: `ds${s}`, hunk: h, section: s, changed: changedLines.section(s) });
      }
    } else {
      out.push(r);
    }
  }
  return out;
}
