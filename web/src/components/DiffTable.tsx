import { Fragment, useCallback, useEffect, useMemo, useRef, type MouseEvent, type ReactNode } from 'react';
import type { FileChange, FileDiff, Side, ThreadView } from '../../../src/core/api-types.ts';
import { normalize, type Range } from '../lib/ranges.ts';
import { buildRows, EXPAND_STEP, foldDone, gaps, oldToNewInGaps, toSplit, type Row, type SplitRow } from '../lib/rows.ts';
import { fileSections, sectionDone, validMarks, type Section } from '../lib/sections.ts';
import { isSelected, splitSelection, unifiedSelection, type Selection } from '../lib/selection.ts';
import { currentLines, diffKey, markKey, sidePath, viewedBlob } from '../format.ts';
import { renderEmphasis, renderTokens, type Token } from '../highlight/index.tsx';
import { wordHighlights, type Span } from '../lib/worddiff.ts';
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
  const viewedBlobId = viewedBlob(file);
  const viewed = useStore((s) => (viewedBlobId ? s.viewed.has(markKey(file.path, viewedBlobId)) : false));
  const { expand, collapse, select, openComposer, loadLines, setSectionsDone, setDoneUnfolded } = useStore.getState();
  const key = diffKey(file);

  // Each run of changed lines is a section the user can mark done. Sections marked done fold to
  // one line unless the user unfolded them this session, and a hunk whose sections all fold folds
  // whole. A viewed file the user opens again is being looked at again, so its sections start unfolded.
  const marks = useMemo(() => validMarks(sections, file), [sections, file]);
  const parts = useMemo(() => fileSections(diff.hunks), [diff]);
  const byHunk = useMemo(() => diff.hunks.map((_, h) => parts.filter((p) => p.hunk === h)), [diff, parts]);
  const done = useMemo(() => parts.map((p) => sectionDone(p, marks)), [parts, marks]);
  const unfoldKey = (p: Section) => `${key}#s${p.index}`;
  const folded = useMemo(() => {
    const secs = new Set(parts.flatMap((p) => (done[p.index] && !(unfoldedDone[`${key}#s${p.index}`] ?? viewed) ? [p.index] : [])));
    const hunks = new Set(byHunk.flatMap((ps, h) => (ps.length > 0 && ps.every((p) => secs.has(p.index)) ? [h] : [])));
    return { sections: secs, hunks };
  }, [parts, byHunk, done, unfoldedDone, key, viewed]);

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
      foldDone(buildRows(diff, { revealed, forced, newLines }), folded, {
        hunk: (h) => diff.hunks[h]!.lines.filter((l) => l.kind !== 'context').length,
        section: (i) => parts[i]!.changed,
      }),
    [diff, parts, revealed, forced, newLines, folded],
  );
  const split = useMemo(() => (view === 'split' ? toSplit(rows) : null), [rows, view]);
  // The words that changed within each removed line and the added line it pairs with.
  const words = useMemo(() => wordHighlights(rows), [rows]);
  const wordsFor = (side: Side, no: number | null): Span[] | undefined => (no === null ? undefined : words.get(`${side}:${no}`));

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
  const toTarget = (sel: Selection | null): Target | null => (sel ? { path: file.path, sidePath: sidePath(file, sel.side), ...sel } : null);

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

  /**
   * The checkbox for some sections: one section, at the right of its first line or its folded
   * row, or every section of a hunk folded whole, on that row.
   */
  const sectionCheck = (ps: readonly Section[], isDone: boolean) => (
    <input type="checkbox" className="section-check" checked={isDone} onChange={() => void setSectionsDone(file, ps, !isDone)}
      title={isDone ? 'Reviewed. Uncheck to mark it as not reviewed' : 'Mark this section reviewed. It stays done until its lines change.'}
      aria-label="Section done" />
  );

  /** A section's own controls, on its first line. */
  const sectionControls = (i: number | null, first: boolean): ReactNode => {
    if (i === null || !first) return null;
    const p = parts[i]!;
    return (
      <span className="done-controls section-controls">
        {done[i] && <button className="link-btn" onClick={() => setDoneUnfolded([unfoldKey(p)], false)}>Fold</button>}
        {sectionCheck([p], done[i]!)}
      </span>
    );
  };

  /** Threads ending inside a folded hunk or section, shown under its summary so no conversation is hidden. */
  const threadsIn = (r: Extract<Row, { type: 'done' }>): ThreadView[] => {
    const hunk = diff.hunks[r.hunk]!;
    const p = r.section === null ? null : parts[r.section]!;
    const within = (side: Side, end: number) => {
      if (p) {
        const range = p[side];
        return range !== null && end >= range.start && end <= range.end;
      }
      return side === 'new'
        ? end >= hunk.new_start && end < hunk.new_start + Math.max(hunk.new_lines, 1)
        : end >= hunk.old_start && end < hunk.old_start + Math.max(hunk.old_lines, 1);
    };
    return threads.filter((t) => {
      const end = currentLines(t).end;
      return end !== null && within(t.side, end);
    });
  };

  const doneRow = (r: Extract<Row, { type: 'done' }>) => {
    const inside = threadsIn(r);
    const p = r.section === null ? null : parts[r.section]!;
    return (
      <Fragment key={r.key}>
        <tr className="done-row">
          <td colSpan={width}>
            <span className="done-controls">{sectionCheck(p ? [p] : byHunk[r.hunk]!, true)}</span>
            <Icon name="check" size={14} /> Reviewed · {r.changed} changed line{r.changed === 1 ? '' : 's'}
            <button className="link-btn" onClick={() => setDoneUnfolded((p ? [p] : byHunk[r.hunk]!).map(unfoldKey), true)}>Show</button>
          </td>
        </tr>
        {inside.length > 0 && (
          <tr className="attach-row"><td colSpan={width}>{inside.map((t) => <ThreadWidget key={t.id} thread={t} defaultOpen={false} />)}</td></tr>
        )}
      </Fragment>
    );
  };

  const expanderRow = (r: Extract<Row, { type: 'expander' }>) => {
    const count = r.end - r.start + 1;
    const doExpand = (range: Range) => void expand(file, range);
    return (
      <tr key={r.key} className={`expander-row${r.hunk !== null ? ' sticky-hunk' : ''}`}>
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
    <tr key={r.key} className="hunk-row sticky-hunk">
      <td colSpan={view === 'split' ? 1 : 2} />
      <td colSpan={view === 'split' ? 3 : 2}>{r.header}</td>
    </tr>
  );

  const code = (text: string, noEol: boolean, tokens?: Token[], spans?: Span[]) => (
    <>
      <span className="code-text">{spans ? renderEmphasis(text, tokens, spans) : renderTokens(text, tokens)}</span>
      {noEol && <span className="no-eol" title="No newline at end of file">⊘</span>}
    </>
  );

  const addButton = (index: number, side: Side | null) => (
    <button className="add-comment" title="Comment on this line (drag the line numbers to select a range)"
      onMouseDown={(e) => onGutterDown(e, index, side)}>
      <Icon name="plus" size={12} />
    </button>
  );

  /** Whether each row starts a section, so its controls go there. */
  const starts = (list: ReadonlyArray<{ type: string; section?: number | null }>) =>
    list.map((r, i) => (r.type === 'line' || r.type === 'pair') && r.section != null && list[i - 1]?.section !== r.section);

  // -------------------------------------------------------------- unified
  if (!split) {
    const first = starts(rows);
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
                  <td className="code">{sectionControls(r.section, first[i]!)}{r.kind === 'del'
                    ? code(r.text, r.noEol, tokensFor('old', r.oldNo), wordsFor('old', r.oldNo))
                    : code(r.text, r.noEol, tokensFor('new', r.newNo), r.kind === 'add' ? wordsFor('new', r.newNo) : undefined)}</td>
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

  const firstPair = starts(split);
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
                  {!right && sectionControls(r.section, firstPair[i]!)}
                  {left && code(left.text, left.noEol, tokensFor('old', left.no), left.kind === 'del' ? wordsFor('old', left.no) : undefined)}
                </td>
                <td className={`num ${cellClass(right?.kind, right?.expanded)}${selR ? ' selected' : ''}`} data-no={right?.no ?? ''}
                  onMouseDown={right ? (e) => onGutterDown(e, i, 'new') : undefined} />
                <td className={`code ${cellClass(right?.kind, right?.expanded)}${selR ? ' selected' : ''}`}>
                  {right && addButton(i, 'new')}
                  {right && sectionControls(r.section, firstPair[i]!)}
                  {right && code(right.text, right.noEol, tokensFor('new', right.no), right.kind === 'add' ? wordsFor('new', right.no) : undefined)}
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
