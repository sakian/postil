import { Fragment, useCallback, useEffect, useMemo, useRef, type MouseEvent, type ReactNode } from 'react';
import type { FileChange, FileDiff, Hunk, Side, ThreadView } from '../../../src/core/api-types.ts';
import { normalize, type Range } from '../lib/ranges.ts';
import { buildRows, EXPAND_STEP, foldDone, gaps, oldToNewInGaps, toSplit, type Row, type SplitRow } from '../lib/rows.ts';
import { hunkDone, validMarks } from '../lib/sections.ts';
import { isSelected, splitSelection, unifiedSelection, type Selection } from '../lib/selection.ts';
import { currentLines, diffKey } from '../format.ts';
import { renderTokens, type Token } from '../highlight/index.tsx';
import { useStore, type Target } from '../store.ts';
import { Icon } from './icons.tsx';
import { NewThreadComposer, ThreadWidget } from './Thread.tsx';

const NO_RANGES: Range[] = [];

interface Props {
  file: FileChange;
  diff: FileDiff;
  /** Threads anchored to lines of exactly this diff. */
  threads: ThreadView[];
}

type LineRow = Extract<Row, { type: 'line' }>;

export function DiffTable({ file, diff, threads }: Props) {
  const view = useStore((s) => s.view);
  const blob = file.new_blob;
  const revealed = useStore((s) => (blob ? s.expanded[blob] : undefined)) ?? NO_RANGES;
  const linesState = useStore((s) => (blob ? s.lines[blob] : undefined));
  const selection = useStore((s) => (s.selection?.path === file.path ? s.selection : null));
  const composer = useStore((s) => (s.composer?.path === file.path ? s.composer : null));
  const sections = useStore((s) => s.sections);
  const unfoldedDone = useStore((s) => s.unfoldedDone);
  const { expand, collapse, select, openComposer, loadLines, setHunkDone, setDoneUnfolded } = useStore.getState();
  const key = diffKey(file);

  // Hunks marked done fold to one line unless the user unfolded them this session.
  const marks = useMemo(() => validMarks(sections, file.path), [sections, file.path]);
  const done = useMemo(() => diff.hunks.map((h) => hunkDone(h, marks)), [diff, marks]);
  const folded = useMemo(
    () => new Set(done.flatMap((d, i) => (d && !unfoldedDone[`${key}#${i}`] ? [i] : []))),
    [done, unfoldedDone, key],
  );

  const newLines = linesState?.state === 'ready' ? linesState.value : null;

  // Syntax colours for each side, loaded in the background; lines render plain until they arrive.
  const oldTokens = useStore((s) => (file.old_blob ? s.tokens[file.old_blob] : undefined));
  const newTokens = useStore((s) => (file.new_blob ? s.tokens[file.new_blob] : undefined));
  const { loadTokens } = useStore.getState();
  useEffect(() => {
    if (file.old_blob && diff.old_lines !== null && file.old_path) void loadTokens(file.old_blob, file.old_path, diff.old_lines);
    if (file.new_blob && diff.new_lines !== null && file.new_path) void loadTokens(file.new_blob, file.new_path, diff.new_lines);
  }, [file, diff.old_lines, diff.new_lines, loadTokens]);
  const tokensFor = (side: Side, no: number | null): Token[] | undefined => {
    const t = side === 'old' ? oldTokens : newTokens;
    return no !== null && t?.state === 'ready' && t.value ? t.value[no - 1] : undefined;
  };
  const allGaps = useMemo(() => gaps(diff), [diff]);

  // Comments on context lines must stay visible even inside a collapsed gap.
  const forced = useMemo(() => {
    const out: Range[] = [];
    for (const t of threads) {
      const { start, end } = currentLines(t);
      if (start === null || end === null) continue;
      if (t.side === 'new') out.push([start, end]);
      else {
        for (let n = start; n <= end; n++) {
          const mapped = oldToNewInGaps(allGaps, n);
          if (mapped !== null) out.push([mapped, mapped]);
        }
      }
    }
    return normalize(out);
  }, [threads, allGaps]);

  useEffect(() => {
    if (blob && diff.new_lines !== null && (revealed.length > 0 || forced.length > 0) && !linesState) {
      void loadLines(blob, diff.new_lines);
    }
  }, [blob, diff.new_lines, revealed.length, forced.length, linesState, loadLines]);

  const rows = useMemo(
    () =>
      foldDone(buildRows(diff, { revealed, forced, newLines }), folded, (h) => diff.hunks[h]!.lines.filter((l) => l.kind !== 'context').length),
    [diff, revealed, forced, newLines, folded],
  );
  const split = useMemo(() => (view === 'split' ? toSplit(rows) : null), [rows, view]);

  // Threads and the open composer attach below the last line they cover, per side.
  const threadsAt = useMemo(() => {
    const m = new Map<string, ThreadView[]>();
    for (const t of threads) {
      const key = `${t.side}:${currentLines(t).end}`;
      m.set(key, [...(m.get(key) ?? []), t]);
    }
    return m;
  }, [threads]);

  // -------------------------------------------------------------- selection by dragging the gutter
  const drag = useRef<{ anchor: number; side: Side | null } | null>(null);
  const lastAnchor = useRef<{ anchor: number; side: Side | null } | null>(null);

  const compute = useCallback(
    (a: number, b: number, side: Side | null): Selection | null =>
      split && side ? splitSelection(split, a, b, side) : unifiedSelection(rows, a, b),
    [rows, split],
  );
  const toTarget = (sel: Selection | null): Target | null => (sel ? { path: file.path, ...sel } : null);

  const onGutterDown = (e: MouseEvent, index: number, side: Side | null) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const anchor = e.shiftKey && lastAnchor.current?.side === side ? lastAnchor.current.anchor : index;
    drag.current = { anchor, side };
    lastAnchor.current = { anchor, side };
    select(toTarget(compute(anchor, index, side)));
  };
  const onRowEnter = (index: number) => {
    const d = drag.current;
    if (d) select(toTarget(compute(d.anchor, index, d.side)));
  };
  useEffect(() => {
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      const sel = useStore.getState().selection;
      if (sel?.path === file.path) openComposer(sel);
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, [file.path, openComposer]);

  /** The new-side text of the selected lines, used to seed a suggestion. */
  const suggestionSeed = (target: Target): string | null => {
    if (target.side !== 'new') return null;
    const texts = rows.filter((r): r is LineRow => r.type === 'line' && r.newNo !== null && r.newNo >= target.start && r.newNo <= target.end);
    return texts.length === target.end - target.start + 1 ? texts.map((r) => r.text).join('\n') : null;
  };

  // -------------------------------------------------------------- shared row pieces
  const width = 4;

  const attachments = (side: Side, no: number | null): ReactNode => {
    if (no === null) return null;
    const here = threadsAt.get(`${side}:${no}`) ?? [];
    const composing = composer && composer.side === side && composer.end === no;
    if (here.length === 0 && !composing) return null;
    return (
      <tr className="attach-row">
        <td colSpan={width}>
          {here.map((t) => <ThreadWidget key={t.id} thread={t} />)}
          {composing && <NewThreadComposer target={composer} seed={suggestionSeed(composer)} />}
        </td>
      </tr>
    );
  };

  const doneToggle = (h: number) => {
    const hunk: Hunk = diff.hunks[h]!;
    return (
      <span className="done-controls">
        {done[h] && !folded.has(h) && (
          <button className="link-btn" onClick={() => setDoneUnfolded(`${key}#${h}`, false)}>Fold</button>
        )}
        <button className={`done-toggle${done[h] ? ' on' : ''}`} onClick={() => void setHunkDone(file, hunk, !done[h])}
          title={done[h] ? 'Mark this section as not reviewed' : 'Mark this section reviewed. It stays done until its lines change.'}>
          {done[h] ? <><Icon name="check" size={12} /> Done</> : 'Mark done'}
        </button>
      </span>
    );
  };

  /** Threads anchored inside a hunk, shown under its folded summary so no conversation is hidden. */
  const threadsInHunk = (h: number): ThreadView[] => {
    const hunk = diff.hunks[h]!;
    return threads.filter((t) => {
      const end = currentLines(t).end;
      if (end === null) return false;
      return t.side === 'new'
        ? end >= hunk.new_start && end < hunk.new_start + Math.max(hunk.new_lines, 1)
        : end >= hunk.old_start && end < hunk.old_start + Math.max(hunk.old_lines, 1);
    });
  };

  const doneRow = (r: Extract<Row, { type: 'done' }>) => {
    const inside = threadsInHunk(r.hunk);
    return (
      <Fragment key={r.key}>
        <tr className="done-row">
          <td colSpan={width}>
            <Icon name="check" size={14} /> Reviewed · {r.changed} changed line{r.changed === 1 ? '' : 's'}
            <button className="link-btn" onClick={() => setDoneUnfolded(`${key}#${r.hunk}`, true)}>Show</button>
          </td>
        </tr>
        {inside.length > 0 && (
          <tr className="attach-row"><td colSpan={width}>{inside.map((t) => <ThreadWidget key={t.id} thread={t} />)}</td></tr>
        )}
      </Fragment>
    );
  };

  const expanderRow = (r: Extract<Row, { type: 'expander' }>) => {
    const count = r.end - r.start + 1;
    const doExpand = (range: Range) => void expand(file, range);
    return (
      <tr key={r.key} className="expander-row">
        <td colSpan={view === 'split' ? 1 : 2} className="expander-controls">
          {count <= EXPAND_STEP ? (
            <button className="expander-btn" title={`Show ${count} hidden line${count === 1 ? '' : 's'}`} onClick={() => doExpand([r.start, r.end])}>
              <Icon name="expandBoth" />
            </button>
          ) : (
            <>
              {r.canDown && (
                <button className="expander-btn" title={`Show ${EXPAND_STEP} more lines below`} onClick={() => doExpand([r.start, r.start + EXPAND_STEP - 1])}>
                  <Icon name="expandDown" />
                </button>
              )}
              {r.canUp && (
                <button className="expander-btn" title={`Show ${EXPAND_STEP} more lines above`} onClick={() => doExpand([r.end - EXPAND_STEP + 1, r.end])}>
                  <Icon name="expandUp" />
                </button>
              )}
            </>
          )}
        </td>
        <td colSpan={view === 'split' ? 3 : 2} className="expander-label">
          {r.header ?? `${count} unchanged line${count === 1 ? '' : 's'}`}
          {count > EXPAND_STEP && (
            <button className="link-btn" onClick={() => doExpand([r.start, r.end])}>
              Show all {count}
            </button>
          )}
          {r.hunk !== null && doneToggle(r.hunk)}
        </td>
      </tr>
    );
  };

  const collapseRow = (r: Extract<Row, { type: 'collapse' }>) => (
    <tr key={r.key} className="collapse-row">
      <td colSpan={width}>
        <button className="collapse-btn" onClick={() => blob && collapse(blob, [r.start, r.end])} title="Hide these lines again">
          <Icon name="collapse" size={12} /> Hide {r.count} line{r.count === 1 ? '' : 's'}
        </button>
      </td>
    </tr>
  );

  const hunkRow = (r: Extract<Row, { type: 'hunk' }>) => (
    <tr key={r.key} className="hunk-row">
      <td colSpan={view === 'split' ? 1 : 2} />
      <td colSpan={view === 'split' ? 3 : 2}>{r.header}{doneToggle(r.hunk)}</td>
    </tr>
  );

  const code = (text: string, noEol: boolean, tokens?: Token[]) => (
    <>
      <span className="code-text">{renderTokens(text, tokens)}</span>
      {noEol && <span className="no-eol" title="No newline at end of file">⊘</span>}
    </>
  );

  const addButton = (index: number, side: Side | null) => (
    <button className="add-comment" title="Comment on this line (drag the line numbers to select a range)"
      onMouseDown={(e) => onGutterDown(e, index, side)}>
      <Icon name="plus" size={12} />
    </button>
  );

  // -------------------------------------------------------------- unified
  if (!split) {
    return (
      <table className="diff diff-unified">
        <colgroup><col className="col-num" /><col className="col-num" /><col className="col-marker" /><col /></colgroup>
        <tbody>
          {rows.map((r, i) => {
            if (r.type === 'expander') return expanderRow(r);
            if (r.type === 'collapse') return collapseRow(r);
            if (r.type === 'hunk') return hunkRow(r);
            if (r.type === 'done') return doneRow(r);
            const side: Side = r.kind === 'del' ? 'old' : 'new';
            const no = side === 'old' ? r.oldNo : r.newNo;
            const selected = isSelected(selection, side, no) || (r.kind === 'context' && isSelected(selection, 'old', r.oldNo));
            return (
              <Fragment key={r.key}>
                <tr className={`line ${r.kind}${r.expanded ? ' revealed' : ''}${selected ? ' selected' : ''}`} onMouseEnter={() => onRowEnter(i)}>
                  <td className="num" data-no={r.oldNo ?? ''} onMouseDown={(e) => onGutterDown(e, i, null)} />
                  <td className="num" data-no={r.newNo ?? ''} onMouseDown={(e) => onGutterDown(e, i, null)} />
                  <td className="marker">{addButton(i, null)}{r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}</td>
                  <td className="code">{code(r.text, r.noEol, r.kind === 'del' ? tokensFor('old', r.oldNo) : tokensFor('new', r.newNo))}</td>
                </tr>
                {r.kind === 'context' && attachments('old', r.oldNo)}
                {attachments(side, no)}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    );
  }

  // -------------------------------------------------------------- split
  const cellClass = (kind: string | undefined, expanded: boolean | undefined) =>
    kind ? `${kind}${expanded ? ' revealed' : ''}` : 'empty';

  return (
    <table className="diff diff-split">
      <colgroup><col className="col-num" /><col className="col-half" /><col className="col-num" /><col className="col-half" /></colgroup>
      <tbody>
        {split.map((r: SplitRow, i) => {
          if (r.type === 'expander') return expanderRow(r);
          if (r.type === 'collapse') return collapseRow(r);
          if (r.type === 'hunk') return hunkRow(r);
          if (r.type === 'done') return doneRow(r);
          const { left, right } = r;
          const selL = left ? isSelected(selection, 'old', left.no) : false;
          const selR = right ? isSelected(selection, 'new', right.no) : false;
          return (
            <Fragment key={r.key}>
              <tr className="line" onMouseEnter={() => onRowEnter(i)}>
                <td className={`num ${cellClass(left?.kind, left?.expanded)}${selL ? ' selected' : ''}`} data-no={left?.no ?? ''}
                  onMouseDown={left ? (e) => onGutterDown(e, i, 'old') : undefined} />
                <td className={`code ${cellClass(left?.kind, left?.expanded)}${selL ? ' selected' : ''}`}>
                  {left && addButton(i, 'old')}
                  {left && code(left.text, left.noEol, tokensFor('old', left.no))}
                </td>
                <td className={`num ${cellClass(right?.kind, right?.expanded)}${selR ? ' selected' : ''}`} data-no={right?.no ?? ''}
                  onMouseDown={right ? (e) => onGutterDown(e, i, 'new') : undefined} />
                <td className={`code ${cellClass(right?.kind, right?.expanded)}${selR ? ' selected' : ''}`}>
                  {right && addButton(i, 'new')}
                  {right && code(right.text, right.noEol, tokensFor('new', right.no))}
                </td>
              </tr>
              {left && attachments('old', left.no)}
              {right && attachments('new', right.no)}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
