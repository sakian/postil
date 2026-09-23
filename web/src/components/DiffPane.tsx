import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FileChange, ThreadView } from '../../../src/core/api-types.ts';
import { diffKey, markKey, placement, shortSha, threadFile, viewedBlob } from '../format.ts';
import { buildTree, fileOrder } from '../lib/tree.ts';
import { useStore } from '../store.ts';
import { DiffTable } from './DiffTable.tsx';
import { Icon } from './icons.tsx';
import { ThreadWidget } from './Thread.tsx';

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
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '1200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const loadable = file.kind !== 'submodule';
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

  let body: ReactNode = null;
  if (file.kind === 'submodule') {
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
        <button className="icon-btn" onClick={() => setFold(file.path, !folded)} title={folded ? 'Show file' : 'Hide file'} aria-expanded={!folded}>
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
        {updated && <span className="chip chip-updated" title={`Changed since you submitted review #${sinceReviewId}`}>Updated</span>}
        <span className="spacer" />
        {ready && ready.new_lines !== null && ready.hunks.length > 0 && !folded && (
          <>
            <button className="btn btn-small" onClick={() => void expandFile(file, ready.new_lines!)} title="Show the whole file">
              <Icon name="unfold" size={14} /> Expand all
            </button>
            {hasRevealed && (
              <button className="btn btn-small" onClick={() => file.new_blob && collapseFile(file.new_blob)} title="Hide every revealed line again">
                <Icon name="fold" size={14} /> Collapse all
              </button>
            )}
          </>
        )}
        <label className={`viewed-toggle${viewed ? ' on' : ''}`} title="Mark as viewed. Cleared automatically when the file changes.">
          <input type="checkbox" checked={viewed} onChange={(e) => void setViewed(file, e.target.checked)} /> Viewed
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
