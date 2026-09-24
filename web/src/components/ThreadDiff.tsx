import { useEffect, useState } from 'react';
import type { DiffLine, FileChange, FileDiff, ThreadView } from '../../../src/core/api-types.ts';
import { api } from '../api.ts';
import { currentLines, threadFile } from '../format.ts';
import { useStore } from '../store.ts';

/** Lines of context kept around the commented lines. */
const AROUND = 4;

interface Excerpt {
  lines: DiffLine[];
  /** The commented lines, on the thread's side. */
  start: number;
  end: number;
}

/** The diff lines around a range on one side, from the hunks that touch it. */
function excerpt(diff: FileDiff, side: 'old' | 'new', start: number, end: number): DiffLine[] {
  const no = (l: DiffLine) => (side === 'old' ? l.old_no : l.new_no);
  const lines = diff.hunks
    .filter((h) => {
      const [s, n] = side === 'old' ? [h.old_start, h.old_lines] : [h.new_start, h.new_lines];
      return s <= end && s + Math.max(n, 1) > start;
    })
    .flatMap((h) => h.lines);
  const hit = lines.flatMap((l, i) => {
    const n = no(l);
    return n !== null && n >= start && n <= end ? [i] : [];
  });
  if (hit.length === 0) return [];
  return lines.slice(Math.max(0, hit[0]! - AROUND), hit.at(-1)! + AROUND + 1);
}

function fileOnSide(files: readonly FileChange[], thread: ThreadView): FileChange | undefined {
  return files.find((f) => (thread.side === 'new' ? f.new_path : f.old_path) === thread.path);
}

/**
 * A thread's code in context: the diff it was written on ("original"), or the diff on screen now
 * ("current"), so a conversation can be followed without leaving the list.
 */
export function ThreadDiff({ thread, which }: { thread: ThreadView; which: 'original' | 'current' }) {
  const resolved = useStore((s) => s.resolved);
  const [state, setState] = useState<{ excerpt: Excerpt } | { note: string } | null>(null);
  // Threads are refetched as objects on every change; reload only when what is shown would differ.
  const { start: nowStart, end: nowEnd } = currentLines(thread);
  const key = which === 'original'
    ? `${thread.id}:original`
    : `${thread.id}:${resolved?.from.tree}..${resolved?.to.tree}:${thread.anchor?.state}:${nowStart}-${nowEnd}`;

  useEffect(() => {
    let live = true;
    setState(null);
    const load = async (): Promise<{ excerpt: Excerpt } | { note: string }> => {
      if (which === 'original') {
        if (thread.start_line === null || thread.end_line === null) return { note: 'This comment is on the whole file.' };
        const diff = await api.resolve({ kind: 'trees', from: thread.from_tree, to: thread.to_tree });
        const file = fileOnSide(diff.files, thread);
        if (!file) return { note: 'The file was unchanged in the diff this was written on.' };
        const d = await api.fileDiff(file.old_blob, file.new_blob);
        return { excerpt: { lines: excerpt(d, thread.side, thread.start_line, thread.end_line), start: thread.start_line, end: thread.end_line } };
      }
      const file = resolved ? threadFile(thread, resolved.files) : undefined;
      const { start, end } = currentLines(thread);
      if (!file) return { note: 'This file has no changes in the current view.' };
      if (thread.anchor?.state === 'gone' || start === null || end === null) return { note: 'The commented code no longer exists.' };
      const d = await api.fileDiff(file.old_blob, file.new_blob);
      return { excerpt: { lines: excerpt(d, thread.side, start, end), start, end } };
    };
    load().then((r) => live && setState(r), (e: unknown) => live && setState({ note: `Could not load the diff: ${e instanceof Error ? e.message : e}` }));
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!state) return <div className="thread-diff muted">Loading…</div>;
  if ('note' in state) return <div className="thread-diff muted">{state.note}</div>;
  const { lines, start, end } = state.excerpt;
  if (lines.length === 0) return <div className="thread-diff muted">The commented lines are unchanged context in this diff.</div>;
  const no = (l: DiffLine) => (thread.side === 'old' ? l.old_no : l.new_no);
  return (
    <div className="thread-diff">
      <table className="diff diff-unified">
        <colgroup><col className="col-num" /><col className="col-num" /><col className="col-marker" /><col /></colgroup>
        <tbody>
          {lines.map((l, i) => {
            const n = no(l);
            const inRange = n !== null && n >= start && n <= end && (l.kind === 'context' || (thread.side === 'old') === (l.kind === 'del'));
            return (
              <tr key={i} className={`line ${l.kind}${inRange ? ' selected' : ''}`}>
                <td className="num" data-no={l.old_no ?? ''} />
                <td className="num" data-no={l.new_no ?? ''} />
                <td className="marker">{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}</td>
                <td className="code"><span className="code-text">{l.text}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
