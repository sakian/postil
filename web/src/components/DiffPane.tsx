import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FileChange, ThreadView } from '../../../src/core/api-types.ts';
import { diffKey, markKey, placement, shortSha, threadFile, viewedBlob } from '../format.ts';
import { hunkDone, validMarks } from '../lib/sections.ts';
import { buildTree, fileOrder } from '../lib/tree.ts';
import { useStore } from '../store.ts';
import { DiffTable } from './DiffTable.tsx';
import { Icon } from './icons.tsx';
import { ThreadWidget } from './Thread.tsx';

/** Files with more changed lines than this start collapsed behind a "Load diff" button. */
export const LARGE_DIFF_LINES = 1500;

export function fileAnchor(path: string): string {
  return `file-${encodeURIComponent(path).replace(/%/g, '_')}`;
}

const STATUS_LETTER: Record<FileChange['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', type_changed: 'T' };

export function StatusBadge({ file }: { file: FileChange }) {
  return <span className={`status-badge status-${file.status}`} title={file.status.replace('_', ' ')}>{STATUS_LETTER[file.status]}</span>;
}

function FileView({ file, threads }: { file: FileChange; threads: ThreadView[] }) {
  const key = diffKey(file);
  const diff = useStore((s) => s.diffs[key]);
  const blob = viewedBlob(file);
  const viewed = useStore((s) => (blob ? s.viewed.has(markKey(file.path, blob)) : false));
  const fold = useStore((s) => s.fileFold[file.path]);
  const focusThread = useStore((s) => s.focusThread);
  const hasRevealed = useStore((s) => (file.new_blob ? (s.expanded[file.new_blob]?.length ?? 0) > 0 : false));
  const { loadDiff, setViewed, setFold, expandFile, collapseFile } = useStore.getState();
  const folded = fold ?? viewed;
  const ref = useRef<HTMLElement>(null);
  const [nearViewport, setNear] = useState(false);

  // Load each file's diff only as it approaches the viewport, so large reviews open instantly.
  // The observer's root is the scrolling pane, so the look-ahead margin applies to it. A file that
  // mounts already in view (a changed file after a refresh) is checked directly, since waiting on
  // the observer's first report left such files stuck on "Loading diff".
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = el.closest('main');
    const MARGIN = 1200;
    const r = el.getBoundingClientRect();
    const box = root?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    if (r.bottom > box.top - MARGIN && r.top < box.bottom + MARGIN) {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), {
      root, rootMargin: `${MARGIN}px 0px`,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Huge diffs wait for an explicit request, as on GitHub: rendering thousands of rows unasked
  // would stall the page for a file the user may not need to read line by line.
  const changedLines = (file.additions ?? 0) + (file.deletions ?? 0);
  const [largeRequested, setLargeRequested] = useState(false);
  const deferred = changedLines > LARGE_DIFF_LINES && !largeRequested;
  const loadable = file.kind !== 'submodule' && !deferred;
  useEffect(() => {
    if (nearViewport && !folded && loadable) void loadDiff(file);
  }, [nearViewport, folded, loadable, file, loadDiff]);

  const groups = useMemo(() => {
    const inline: ThreadView[] = [];
    const fileLevel: ThreadView[] = [];
    const gone: ThreadView[] = [];
    for (const t of threads) {
      const p = placement(t, file);
      if (p === 'inline') inline.push(t);
      else if (p === 'file') fileLevel.push(t);
      else if (p === 'gone') gone.push(t);
    }
    return { inline, fileLevel, gone };
  }, [threads, file]);
  const updated = useStore((s) => s.scope.kind !== 'since_review' && (s.resolved?.since_review?.changed.includes(file.path) ?? false));
  const sinceReviewId = useStore((s) => s.resolved?.since_review?.review_id);

  // Bring this file into view when a thread in it is focused from the threads list.
  useEffect(() => {
    if (focusThread === null || !threads.some((t) => t.id === focusThread)) return;
    setFold(file.path, false);
    ref.current?.scrollIntoView({ block: 'start' });
    void loadDiff(file);
  }, [focusThread, threads, file, setFold, loadDiff]);

  const ready = diff?.state === 'ready' ? diff.value : null;
  const openCount = threads.filter((t) => t.status === 'open').length;
  const sections = useStore((s) => s.sections);
  const progress = useMemo(() => {
    if (!ready || ready.hunks.length < 2) return null;
    const marks = validMarks(sections, file.path);
    return { done: ready.hunks.filter((h) => hunkDone(h, marks)).length, total: ready.hunks.length };
  }, [ready, sections, file.path]);

  let body: ReactNode = null;
  if (deferred) {
    body = (
      <div className="file-note muted">
        Large diff: {changedLines.toLocaleString()} changed lines.{' '}
        <button className="link-btn" onClick={() => setLargeRequested(true)}>Load diff</button>
      </div>
    );
  } else if (file.kind === 'submodule') {
    body = <div className="file-note">Submodule changed: {shortSha(file.old_blob) || 'none'} → {shortSha(file.new_blob) || 'removed'}</div>;
  } else if (!diff || diff.state === 'loading') {
    body = <div className="file-note muted">Loading diff…</div>;
  } else if (diff.state === 'error') {
    body = <div className="file-note error">Could not load this diff: {diff.message} <button className="link-btn" onClick={() => void loadDiff(file, false)}>Retry</button></div>;
  } else if (ready?.binary || file.kind === 'binary') {
    body = <div className="file-note muted">Binary file not shown.</div>;
  } else if (ready?.too_large) {
    body = <div className="file-note muted">Large diff not shown. <button className="link-btn" onClick={() => void loadDiff(file, true)}>Load it anyway</button></div>;
  } else if (ready && ready.hunks.length === 0) {
    body = <div className="file-note muted">{file.status === 'renamed' ? 'File renamed without changes.' : file.old_mode !== file.new_mode ? `File mode changed from ${file.old_mode} to ${file.new_mode}.` : 'No content changes.'}</div>;
  } else if (ready) {
    body = <DiffTable file={file} diff={ready} threads={groups.inline} />;
  }

  return (
    <section ref={ref} id={fileAnchor(file.path)} className={`file${viewed ? ' is-viewed' : ''}`}>
      <header className="file-header">
        <button className="icon-btn" data-action="fold" onClick={() => setFold(file.path, !folded)} title={folded ? 'Show file (f)' : 'Hide file (f)'} aria-expanded={!folded}>
          <Icon name={folded ? 'chevronRight' : 'chevronDown'} />
        </button>
        <StatusBadge file={file} />
        <span className="file-path" title={file.path}>
          {file.status === 'renamed' && <><span className="muted">{file.old_path}</span> → </>}
          {file.path}
        </span>
        {file.additions !== null && (
          <span className="file-stats"><span className="adds">+{file.additions}</span> <span className="dels">−{file.deletions}</span></span>
        )}
        {openCount > 0 && <span className="chip chip-comments" title={`${openCount} open conversation(s)`}><Icon name="comment" size={12} /> {openCount}</span>}
        {progress && progress.done > 0 && (
          <span className={`chip chip-sections${progress.done === progress.total ? ' all' : ''}`} title="Sections marked done">
            {progress.done}/{progress.total} sections done
          </span>
        )}
        {updated && <span className="chip chip-updated" title={`Changed since you submitted review #${sinceReviewId}`}>Updated</span>}
        <span className="spacer" />
        {ready && ready.new_lines !== null && ready.hunks.length > 0 && !folded && (
          <>
            <button className="btn btn-small" data-action="expand-all" onClick={() => void expandFile(file, ready.new_lines!)} title="Show the whole file (e)">
              <Icon name="unfold" size={14} /> Expand all
            </button>
            {hasRevealed && (
              <button className="btn btn-small" data-action="collapse-all" onClick={() => file.new_blob && collapseFile(file.new_blob)} title="Hide every revealed line again (E)">
                <Icon name="fold" size={14} /> Collapse all
              </button>
            )}
          </>
        )}
        <label className={`viewed-toggle${viewed ? ' on' : ''}`} title="Mark as viewed. Cleared automatically when the file changes.">
          <input type="checkbox" data-action="viewed" checked={viewed} onChange={(e) => void setViewed(file, e.target.checked)} /> Viewed
        </label>
      </header>
      {!folded && (
        <div className="file-body">
          {groups.gone.length > 0 && (
            <div className="file-threads outdated">
              <div className="file-threads-title">Comments on code that no longer exists</div>
              {groups.gone.map((t) => <ThreadWidget key={t.id} thread={t} />)}
            </div>
          )}
          {groups.fileLevel.length > 0 && (
            <div className="file-threads">{groups.fileLevel.map((t) => <ThreadWidget key={t.id} thread={t} />)}</div>
          )}
          {body}
        </div>
      )}
    </section>
  );
}

export function DiffPane() {
  const resolved = useStore((s) => s.resolved);
  const resolving = useStore((s) => s.resolving);
  const resolveError = useStore((s) => s.resolveError);
  const threads = useStore((s) => s.threads);

  const files = useMemo(() => (resolved ? fileOrder(buildTree(resolved.files)) : []), [resolved]);
  const byFile = useMemo(() => {
    const m = new Map<string, ThreadView[]>();
    if (!resolved) return m;
    for (const t of threads) {
      const f = threadFile(t, resolved.files);
      if (f) m.set(f.path, [...(m.get(f.path) ?? []), t]);
    }
    return m;
  }, [threads, resolved]);

  if (resolveError) return <div className="empty error">Could not load the diff: {resolveError}</div>;
  if (!resolved) return <div className="empty muted">{resolving ? 'Loading changes…' : ''}</div>;

  const adds = resolved.files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const dels = resolved.files.reduce((n, f) => n + (f.deletions ?? 0), 0);

  return (
    <div className="diff-pane">
      <div className="diff-summary">
        <span><strong>{resolved.files.length}</strong> file{resolved.files.length === 1 ? '' : 's'} changed</span>
        <span className="adds">+{adds}</span>
        <span className="dels">−{dels}</span>
        <span className="muted range-label">{resolved.from.label} → {resolved.to.label}</span>
      </div>
      {files.length === 0 && <div className="empty muted">No changes in this view.</div>}
      {files.map((f) => <FileView key={`${f.path}:${diffKey(f)}`} file={f} threads={byFile.get(f.path) ?? []} />)}
    </div>
  );
}
