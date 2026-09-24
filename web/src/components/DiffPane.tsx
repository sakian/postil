import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FileChange, ThreadView } from '../../../src/core/api-types.ts';
import { api } from '../api.ts';
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

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

function ImageSide({ label, oid, path }: { label: string; oid: string | null; path: string | null }) {
  const [size, setSize] = useState<string | null>(null);
  return (
    <figure className="image-side">
      <figcaption>{label}{size && <span className="muted"> · {size}</span>}</figcaption>
      {oid && path ? (
        <img src={api.rawUrl(oid, path)} alt={`${label}: ${path}`} onLoad={(e) => setSize(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} />
      ) : (
        <div className="image-none muted">{label === 'Before' ? 'Added' : 'Deleted'}</div>
      )}
    </figure>
  );
}

/** Before and after images for a changed binary image file. */
function ImageDiff({ file }: { file: FileChange }) {
  return (
    <div className="image-diff">
      <ImageSide label="Before" oid={file.old_blob} path={file.old_path} />
      <ImageSide label="After" oid={file.new_blob} path={file.new_path} />
    </div>
  );
}

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
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Within about two screens of the viewport. Bodies outside that are swapped for a placeholder. */
  const [near, setNear] = useState(false);
  const [placeholder, setPlaceholder] = useState<number | null>(null);
  const holdsWork = useStore(
    (s) => s.composer?.path === file.path || s.selection?.path === file.path || (s.focusThread !== null && threads.some((t) => t.id === s.focusThread)),
  );

  // The observer's root is the scrolling pane, so its margin applies there. A file that mounts
  // already in range (a changed file after a refresh) is checked directly rather than waiting on
  // the observer's first report. Leaving range records the body's height for its placeholder, so
  // the page keeps its length and the scroll position does not jump.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = el.closest('main');
    const MARGIN = 2000;
    const r = el.getBoundingClientRect();
    const box = root?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    if (r.bottom > box.top - MARGIN && r.top < box.bottom + MARGIN) setNear(true);
    const io = new IntersectionObserver(
      (entries) => {
        const inRange = entries.some((e) => e.isIntersecting);
        if (!inRange && bodyRef.current) setPlaceholder(bodyRef.current.offsetHeight);
        setNear(inRange);
      },
      { root, rootMargin: `${MARGIN}px 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const nearViewport = near || holdsWork;

  // Huge diffs wait for an explicit request, as on GitHub: rendering thousands of rows unasked
  // would stall the page for a file the user may not need to read line by line.
  const changedLines = (file.additions ?? 0) + (file.deletions ?? 0);
  const [largeRequested, setLargeRequested] = useState(false);
  const deferred = changedLines > LARGE_DIFF_LINES && !largeRequested;
  // Same content both sides (a pure rename or mode change): nothing to fetch.
  const sameContent = file.old_blob !== null && file.old_blob === file.new_blob;
  const loadable = file.kind !== 'submodule' && !deferred && !sameContent && !(file.kind === 'binary' && IMAGE.test(file.path));
  useEffect(() => {
    if (!(nearViewport && !folded && loadable)) return;
    void loadDiff(file);
    return () => useStore.getState().cancelDiff(file);
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
  const updated = useStore((s) => s.scope.kind !== 'since_review' && s.updatedPaths.has(file.path));
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
  if (file.kind === 'binary' && IMAGE.test(file.path)) {
    body = <ImageDiff file={file} />;
  } else if (deferred) {
    body = (
      <div className="file-note muted">
        Large diff: {changedLines.toLocaleString()} changed lines.{' '}
        <button className="link-btn" onClick={() => setLargeRequested(true)}>Load diff</button>
      </div>
    );
  } else if (sameContent) {
    body = (
      <div className="file-note muted">
        {file.status === 'renamed' ? 'File renamed without changes.' : `File mode changed from ${file.old_mode} to ${file.new_mode}.`}
      </div>
    );
  } else if (file.kind === 'submodule') {
    body = <div className="file-note">Submodule changed: {shortSha(file.old_blob) || 'none'} → {shortSha(file.new_blob) || 'removed'}</div>;
  } else if (!diff || diff.state === 'loading') {
    body = <div className="file-note muted">Loading diff…</div>;
  } else if (diff.state === 'error') {
    body = <div className="file-note error">Could not load this diff: {diff.message} <button className="link-btn" onClick={() => void loadDiff(file, false)}>Retry</button></div>;
  } else if ((ready?.binary || file.kind === 'binary') && IMAGE.test(file.path)) {
    body = <ImageDiff file={file} />;
  } else if (ready?.binary || file.kind === 'binary') {
    body = <div className="file-note muted">Binary file not shown.</div>;
  } else if (ready?.too_large) {
    body = (
      <div className="file-note muted">
        {ready.too_large_reason === 'long_lines' ? 'Diff not shown: it has extremely long lines, as minified or generated code does.' : 'Large diff not shown.'}{' '}
        <button className="link-btn" onClick={() => void loadDiff(file, true)}>Load it anyway</button>
      </div>
    );
  } else if (ready && ready.hunks.length === 0) {
    body = <div className="file-note muted">{file.status === 'renamed' ? 'File renamed without changes.' : file.old_mode !== file.new_mode ? `File mode changed from ${file.old_mode} to ${file.new_mode}.` : 'No content changes.'}</div>;
  } else if (ready) {
    body = <DiffTable file={file} diff={ready} threads={groups.inline} />;
  }

  return (
    <section ref={ref} id={fileAnchor(file.path)} data-path={file.path} className={`file${viewed ? ' is-viewed' : ''}`}>
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
      {!folded && !nearViewport && placeholder !== null && <div className="file-placeholder" style={{ height: placeholder }} />}
      {!folded && (nearViewport || placeholder === null) && (
        <div className="file-body" ref={bodyRef}>
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

/** Reviews longer than this render only the files near the viewport. */
const VIRTUAL_THRESHOLD = 150;
/** How far beyond the visible area files stay mounted. */
const OVERSCAN = 2500;
/** Space below each file section (its CSS margin), counted in the list's layout. */
const FILE_GAP = 16;

/** A file's height before it has been measured: header, plus roughly its changed lines. */
function estimateHeight(f: FileChange, folded: boolean): number {
  if (folded) return 40 + FILE_GAP;
  const lines = (f.additions ?? 0) + (f.deletions ?? 0);
  // Changed lines plus the context and headers around them, which usually outnumber them.
  return 40 + FILE_GAP + (lines > LARGE_DIFF_LINES ? 50 : Math.min(4000, 150 + lines * 24));
}

/**
 * The list of file sections. Small reviews render every file. Large ones render only the files
 * near the viewport between two spacers, so the page costs the same with 2,000 files as with 50;
 * unsent comments survive this because their text and targets live in the store.
 */
function FileList({ files, byFile }: { files: FileChange[]; byFile: Map<string, ThreadView[]> }) {
  const virtual = files.length > VIRTUAL_THRESHOLD;
  const listRef = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const viewed = useStore((s) => s.viewed);
  const [range, setRange] = useState<[number, number]>(() => [0, Math.min(files.length, 30)]);
  const reveal = useStore((s) => s.revealPath);
  /** A file being brought into view, held at the top while the heights around it settle. */
  const holding = useRef<{ path: string; until: number } | null>(null);
  const hold = useCallback(() => {
    const h = holding.current;
    if (!h) return;
    if (Date.now() > h.until) {
      holding.current = null;
      return;
    }
    document.getElementById(fileAnchor(h.path))?.scrollIntoView({ block: 'start' });
  }, []);

  // Any scrolling of the user's own ends the hold at once.
  useEffect(() => {
    const release = () => { holding.current = null; };
    const main = listRef.current?.closest('main');
    main?.addEventListener('wheel', release, { passive: true });
    main?.addEventListener('touchstart', release, { passive: true });
    window.addEventListener('keydown', release);
    main?.addEventListener('mousedown', release);
    return () => {
      main?.removeEventListener('wheel', release);
      main?.removeEventListener('touchstart', release);
      window.removeEventListener('keydown', release);
      main?.removeEventListener('mousedown', release);
    };
  }, []);

  const offsets = useCallback((): number[] => {
    const out = [0];
    for (const f of files) {
      const b = viewedBlob(f);
      out.push(out.at(-1)! + (heights.current.get(f.path) ?? estimateHeight(f, b !== null && viewed.has(markKey(f.path, b)))));
    }
    return out;
  }, [files, viewed]);

  const geometry = useCallback(() => {
    const list = listRef.current;
    const main = list?.closest('main');
    if (!list || !main) return null;
    const listTop = list.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
    return { main, listTop };
  }, []);

  const compute = useCallback(() => {
    const g = geometry();
    if (!g) return;
    const top = g.main.scrollTop - g.listTop - OVERSCAN;
    const bottom = g.main.scrollTop - g.listTop + g.main.clientHeight + OVERSCAN;
    const o = offsets();
    let a = 0;
    while (a < files.length && o[a + 1]! < top) a++;
    let b = a;
    while (b < files.length && o[b]! < bottom) b++;
    setRange((prev) => (prev[0] === a && prev[1] === b ? prev : [a, b]));
  }, [files, offsets, geometry]);

  useEffect(() => {
    if (!virtual) return;
    const main = listRef.current?.closest('main');
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; compute(); }); };
    main?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    compute();
    return () => {
      cancelAnimationFrame(frame);
      main?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [virtual, compute]);

  // Measure mounted files, so spacers converge on real heights as the user scrolls.
  useLayoutEffect(() => {
    if (!virtual) return;
    let frame = 0;
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const el = e.target as HTMLElement;
        const h = el.offsetHeight + FILE_GAP;
        if (el.dataset.path && heights.current.get(el.dataset.path) !== h) {
          heights.current.set(el.dataset.path, h);
          changed = true;
        }
      }
      if (changed && !frame) frame = requestAnimationFrame(() => { frame = 0; compute(); hold(); });
    });
    listRef.current?.querySelectorAll('section.file').forEach((el) => ro.observe(el));
    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  }, [virtual, range, files, compute, hold]);

  // Scroll a file into view on request, jumping to its computed offset if it is not mounted.
  useEffect(() => {
    if (!reveal) return;
    const el = document.getElementById(fileAnchor(reveal.path));
    if (el) {
      el.scrollIntoView({ block: 'start' });
      if (!virtual) return;
    } else {
      const i = files.findIndex((f) => f.path === reveal.path);
      const g = geometry();
      if (i < 0 || !g) return;
      g.main.scrollTop = g.listTop + offsets()[i]!;
      compute();
    }
    // Files around it are measured as they mount and load, which moves it; keep it in place meanwhile.
    holding.current = { path: reveal.path, until: Date.now() + 2000 };
    requestAnimationFrame(() => requestAnimationFrame(hold));
  }, [reveal]); // eslint-disable-line react-hooks/exhaustive-deps

  const item = (f: FileChange) => <FileView key={`${f.path}:${diffKey(f)}`} file={f} threads={byFile.get(f.path) ?? []} />;
  if (!virtual) return <div ref={listRef}>{files.map(item)}</div>;
  const o = offsets();
  const [a, b] = range;
  return (
    <div ref={listRef}>
      <div style={{ height: o[a] }} />
      {files.slice(a, b).map(item)}
      <div style={{ height: o[files.length]! - o[b]! }} />
    </div>
  );
}

export function DiffPane() {
  const resolved = useStore((s) => s.resolved);
  const resolving = useStore((s) => s.resolving);
  const resolveError = useStore((s) => s.resolveError);
  const threads = useStore((s) => s.threads);
  const focusThread = useStore((s) => s.focusThread);
  const { revealFile } = useStore.getState();

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

  // "Show in diff" and n/p may point at a file that is not mounted; bring it in first.
  useEffect(() => {
    if (focusThread === null || !resolved) return;
    const t = threads.find((x) => x.id === focusThread);
    const f = t && threadFile(t, resolved.files);
    if (f) revealFile(f.path);
  }, [focusThread]); // eslint-disable-line react-hooks/exhaustive-deps

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
      <FileList key={`${resolved.from.tree}..${resolved.to.tree}`} files={files} byFile={byFile} />
    </div>
  );
}
