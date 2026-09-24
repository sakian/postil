import { create } from 'zustand';
import type {
  AnchoredSectionMark, BaseInfo, CommitsInfo, FileChange, Hunk, FileDiff, Health, ResolvedDiff, ReviewView, Scope, Side, ThreadView,
} from '../../src/core/api-types.ts';
import { api, ApiError } from './api.ts';
import { diffKey, markKey, viewedBlob } from './format.ts';
import { highlight, MAX_HIGHLIGHT_LINES, type Token } from './highlight/index.tsx';
import { add, removeOverlapping, type Range } from './lib/ranges.ts';
import { hunkDone, hunkRanges, marksOverlapping, validMarks } from './lib/sections.ts';

export type ViewMode = 'unified' | 'split';
export type Panel = 'threads' | 'review' | null;

export interface Target {
  path: string;
  side: Side;
  start: number;
  end: number;
}

export type Loadable<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

interface State {
  booted: boolean;
  authFailed: boolean;
  connected: boolean;
  health: Health | null;
  /** Claude sessions listening for reviews right now. */
  listening: number;
  base: BaseInfo | null;

  scope: Scope;
  resolved: ResolvedDiff | null;
  /** Paths changed since the last review, as a set: every file view looks itself up in it. */
  updatedPaths: ReadonlySet<string>;
  resolving: boolean;
  resolveError: string | null;
  /** The working tree moved since the diff was resolved. */
  stale: boolean;

  diffs: Record<string, Loadable<FileDiff>>;
  lines: Record<string, Loadable<string[]>>;
  /** Syntax tokens per blob; null when the file is not highlighted (unknown language, too long). */
  tokens: Record<string, Loadable<Token[][] | null>>;
  threads: ThreadView[];
  /** "Done" marks, anchored to the diff being viewed. */
  sections: AnchoredSectionMark[];
  /** Done hunks the user unfolded this session, by `diffKey#hunk`. */
  unfoldedDone: Record<string, true>;
  commits: Loadable<CommitsInfo> | null;
  reviews: ReviewView[];
  draft: ReviewView | null;
  viewed: Set<string>;

  view: ViewMode;
  /** Revealed gap lines per new-blob id, so expansion survives reloads and resets when content changes. */
  expanded: Record<string, Range[]>;
  collapsedDirs: string[];
  /** Files whose body the user folded (or unfolded, for viewed files) this session. */
  fileFold: Record<string, boolean>;
  selection: Target | null;
  composer: Target | null;
  /** Unsent comment text by composer, kept here so it survives its file scrolling out of the DOM. */
  composerText: Record<string, string>;
  panel: Panel;
  focusThread: number | null;
  /** A request to scroll a file into view; `n` makes repeated requests for one file distinct. */
  revealPath: { path: string; n: number } | null;
  toasts: Toast[];
}

interface Actions {
  boot(): Promise<void>;
  setScope(scope: Scope): Promise<void>;
  refresh(): Promise<void>;
  refreshThreads(): Promise<void>;
  refreshReviews(): Promise<void>;
  refreshMarks(): Promise<void>;
  loadCommits(): Promise<void>;
  refreshSections(): Promise<void>;
  setHunkDone(file: FileChange, hunk: Hunk, done: boolean): Promise<void>;
  archiveResolved(): Promise<void>;
  setDoneUnfolded(key: string, unfolded: boolean): void;
  applySuggestion(commentId: number): Promise<void>;
  loadDiff(file: FileChange, force?: boolean): Promise<void>;
  /** Drop a pending diff request for a file that left the page, so it stops holding a connection. */
  cancelDiff(file: FileChange): void;
  loadLines(oid: string, total: number): Promise<string[] | null>;
  loadTokens(oid: string, path: string, total: number): Promise<void>;

  setView(view: ViewMode): void;
  expand(file: FileChange, range: Range): Promise<void>;
  collapse(blob: string, range: Range): void;
  expandFile(file: FileChange, total: number): Promise<void>;
  collapseFile(blob: string): void;
  toggleDir(path: string): void;
  setCollapsedDirs(paths: string[]): void;
  setFold(path: string, folded: boolean): void;
  setViewed(file: FileChange, viewed: boolean): Promise<void>;

  select(target: Target | null): void;
  setComposerText(key: string, text: string | null): void;
  openComposer(target: Target | null): void;
  createThread(target: Target, body: string): Promise<void>;
  reply(threadId: number, body: string): Promise<void>;
  editComment(commentId: number, body: string): Promise<void>;
  deleteComment(commentId: number): Promise<void>;
  setResolved(threadId: number, resolved: boolean): Promise<void>;
  setDraftBody(body: string): Promise<void>;
  submit(body: string): Promise<void>;

  setPanel(panel: Panel): void;
  focus(threadId: number | null): void;
  revealFile(path: string): void;
  toast(text: string, action?: Toast['action']): void;
  dismiss(id: number): void;
  handleEvent(e: { type: string; [k: string]: unknown }): void;
  setConnected(connected: boolean): void;
}

export type Store = State & Actions;

// ---------------------------------------------------------------------------- persistence

const PERSISTED = { view: 'view', scope: 'scope', expanded: 'expanded', tree: 'tree.collapsed' } as const;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Save UI state server-side, debounced, so a review can be resumed from any tab later. */
function persist(key: string, value: unknown): void {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => void api.setUiState(key, value).catch(() => undefined), 400));
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let toastId = 0;

const inflight = new Map<string, Promise<unknown>>();
/**
 * Diff requests still in flight. The browser runs only a few requests per server at once, so after
 * a fast scroll, requests for files already gone would otherwise delay the files on screen.
 */
const diffRequests = new Map<string, AbortController>();

/** Run `fn` once per key at a time; concurrent callers share its promise. */
function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function fetchLines(oid: string, total: number): Promise<string[]> {
  const all: string[] = [];
  for (let start = 1; start <= total; start += 10_000) {
    const chunk = await api.lines(oid, start, Math.min(total, start + 9_999));
    all.push(...chunk.lines);
  }
  return all;
}

export const useStore = create<Store>()((set, get) => {
  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) set({ authFailed: true });
    else get().toast(errorText(e));
  };

  return {
    booted: false,
    authFailed: false,
    connected: false,
    health: null,
    listening: 0,
    base: null,
    scope: { kind: 'all' },
    resolved: null,
    updatedPaths: new Set(),
    resolving: false,
    resolveError: null,
    stale: false,
    diffs: {},
    lines: {},
    tokens: {},
    threads: [],
    sections: [],
    unfoldedDone: {},
    commits: null,
    reviews: [],
    draft: null,
    viewed: new Set(),
    view: 'unified',
    expanded: {},
    collapsedDirs: [],
    fileFold: {},
    selection: null,
    composer: null,
    composerText: {},
    panel: null,
    focusThread: null,
    revealPath: null,
    toasts: [],

    async boot() {
      try {
        const [health, view, scope, expanded, tree] = await Promise.all([
          api.health(),
          api.uiState<ViewMode>(PERSISTED.view),
          api.uiState<Scope>(PERSISTED.scope),
          api.uiState<Record<string, Range[]>>(PERSISTED.expanded),
          api.uiState<string[]>(PERSISTED.tree),
        ]);
        set({
          health,
          listening: health.listening,
          view: view.value ?? 'unified',
          scope: scope.value ?? { kind: 'all' },
          expanded: expanded.value ?? {},
          collapsedDirs: tree.value ?? [],
        });
        await Promise.all([get().refresh(), get().refreshReviews(), get().refreshMarks()]);
      } catch (e) {
        fail(e);
      } finally {
        set({ booted: true });
      }
    },

    async setScope(scope) {
      set({ scope, selection: null, composer: null });
      persist(PERSISTED.scope, scope);
      await get().refresh();
    },

    async refresh() {
      set({ resolving: true, resolveError: null });
      try {
        const [resolved, base] = await Promise.all([api.resolve(get().scope), api.base()]);
        set({ resolved, base, stale: false, updatedPaths: new Set(resolved.since_review?.changed ?? []) });
        // Thread and "done" positions depend on the diff, so re-anchor them to the new one.
        await Promise.all([get().refreshThreads(), get().refreshSections()]);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'no_review' && get().scope.kind === 'since_review') {
          // The review this scope pointed at is gone or never existed; fall back rather than strand the user.
          set({ scope: { kind: 'all' } });
          persist(PERSISTED.scope, { kind: 'all' });
          return get().refresh();
        }
        if (e instanceof ApiError && e.status === 401) set({ authFailed: true });
        set({ resolveError: errorText(e) });
      } finally {
        set({ resolving: false });
      }
    },

    async refreshThreads() {
      const r = get().resolved;
      try {
        set({ threads: (await api.threads(r ? { from: r.from.tree, to: r.to.tree } : undefined)).threads });
      } catch (e) {
        fail(e);
      }
    },

    async refreshReviews() {
      try {
        const [{ reviews }, { draft }] = await Promise.all([api.reviews(), api.draft()]);
        set({ reviews, draft });
      } catch (e) {
        fail(e);
      }
    },

    async refreshMarks() {
      try {
        const { marks } = await api.fileMarks();
        set({ viewed: new Set(marks.map((m) => markKey(m.path, m.blob))) });
      } catch (e) {
        fail(e);
      }
    },

    async refreshSections() {
      const r = get().resolved;
      if (!r) return;
      try {
        set({ sections: (await api.sectionMarks({ from: r.from.tree, to: r.to.tree })).marks });
      } catch (e) {
        fail(e);
      }
    },

    async setHunkDone(file, hunk, done) {
      try {
        if (done) {
          for (const r of hunkRanges(hunk)) {
            await api.addSectionMark({ path: file.path, from_blob: file.old_blob, to_blob: file.new_blob, side: r.side, start_line: r.start, end_line: r.end });
          }
        } else {
          for (const m of marksOverlapping(hunk, validMarks(get().sections, file.path))) await api.removeSectionMark(m.id);
        }
        await get().refreshSections();
        // Finishing the last section finishes the file.
        const diff = get().diffs[diffKey(file)];
        if (done && diff?.state === 'ready') {
          const marks = validMarks(get().sections, file.path);
          if (diff.value.hunks.every((h) => hunkDone(h, marks))) await get().setViewed(file, true);
        }
      } catch (e) {
        fail(e);
      }
    },

    async archiveResolved() {
      try {
        const r = await api.archive();
        get().toast(`Archived ${r.threads} conversation${r.threads === 1 ? '' : 's'} and ${r.reviews} review${r.reviews === 1 ? '' : 's'}.`);
        await Promise.all([get().refreshThreads(), get().refreshReviews()]);
      } catch (e) {
        fail(e);
      }
    },

    setDoneUnfolded(key, unfolded) {
      set((s) => {
        const { [key]: _drop, ...rest } = s.unfoldedDone;
        return { unfoldedDone: unfolded ? { ...rest, [key]: true } : rest };
      });
    },

    async loadCommits() {
      set({ commits: { state: 'loading' } });
      try {
        set({ commits: { state: 'ready', value: await api.commits() } });
      } catch (e) {
        set({ commits: { state: 'error', message: errorText(e) } });
      }
    },

    async applySuggestion(commentId) {
      try {
        const r = await api.applySuggestion(commentId);
        const lines = r.start_line === r.end_line ? `line ${r.start_line}` : `lines ${r.start_line}–${r.end_line}`;
        get().toast(`Suggestion applied to ${r.path}, ${lines}.`, { label: 'Refresh diff', run: () => void get().refresh() });
        await get().refreshThreads();
      } catch (e) {
        fail(e);
      }
    },

    // Each loader writes the store once, when its data arrives. In-flight requests are tracked
    // outside the store: every store update runs every file view's selectors, so on a review with
    // thousands of files, "loading" updates alone would cost more than the data.
    async loadDiff(file, force = false) {
      const key = diffKey(file);
      const current = get().diffs[key];
      if (!force && current && current.state !== 'error') return;
      await once(`diff:${key}:${force}`, async () => {
        const controller = new AbortController();
        diffRequests.set(key, controller);
        try {
          const value = await api.fileDiff(file.old_blob, file.new_blob, { force, signal: controller.signal });
          set((s) => ({ diffs: { ...s.diffs, [key]: { state: 'ready', value } } }));
        } catch (e) {
          if (controller.signal.aborted) return; // the file left the page; it asks again if it returns
          set((s) => ({ diffs: { ...s.diffs, [key]: { state: 'error', message: errorText(e) } } }));
        } finally {
          diffRequests.delete(key);
        }
      });
    },

    cancelDiff(file) {
      diffRequests.get(diffKey(file))?.abort();
    },

    async loadLines(oid, total) {
      const current = get().lines[oid];
      if (current?.state === 'ready') return current.value;
      try {
        const all = await once(`lines:${oid}`, () => fetchLines(oid, total));
        if (get().lines[oid]?.state !== 'ready') set((s) => ({ lines: { ...s.lines, [oid]: { state: 'ready', value: all } } }));
        return all;
      } catch (e) {
        set((s) => ({ lines: { ...s.lines, [oid]: { state: 'error', message: errorText(e) } } }));
        return null;
      }
    },

    async loadTokens(oid, path, total) {
      if (get().tokens[oid]) return;
      await once(`tokens:${oid}`, async () => {
        if (total > MAX_HIGHLIGHT_LINES) {
          set((s) => ({ tokens: { ...s.tokens, [oid]: { state: 'ready', value: null } } }));
          return;
        }
        const cached = get().lines[oid];
        const lines = cached?.state === 'ready' ? cached.value : await once(`lines:${oid}`, () => fetchLines(oid, total)).catch(() => null);
        const value = lines ? await highlight(lines.join('\n'), path) : null;
        // Lines and tokens land together: one update instead of two.
        set((s) => ({
          tokens: { ...s.tokens, [oid]: { state: 'ready', value } },
          ...(lines && s.lines[oid]?.state !== 'ready' && { lines: { ...s.lines, [oid]: { state: 'ready' as const, value: lines } } }),
        }));
      });
    },

    setView(view) {
      set({ view, selection: null, composer: null });
      persist(PERSISTED.view, view);
    },

    async expand(file, range) {
      const blob = file.new_blob;
      const diff = get().diffs[diffKey(file)];
      if (!blob || diff?.state !== 'ready' || diff.value.new_lines === null) return;
      await get().loadLines(blob, diff.value.new_lines);
      set((s) => {
        const expanded = { ...s.expanded, [blob]: add(s.expanded[blob] ?? [], range) };
        persist(PERSISTED.expanded, expanded);
        return { expanded };
      });
    },

    collapse(blob, range) {
      set((s) => {
        const expanded = { ...s.expanded, [blob]: removeOverlapping(s.expanded[blob] ?? [], range) };
        persist(PERSISTED.expanded, expanded);
        return { expanded };
      });
    },

    async expandFile(file, total) {
      await get().expand(file, [1, total]);
    },

    collapseFile(blob) {
      set((s) => {
        const { [blob]: _gone, ...expanded } = s.expanded;
        persist(PERSISTED.expanded, expanded);
        return { expanded };
      });
    },

    toggleDir(path) {
      const dirs = get().collapsedDirs;
      get().setCollapsedDirs(dirs.includes(path) ? dirs.filter((d) => d !== path) : [...dirs, path]);
    },

    setCollapsedDirs(paths) {
      set({ collapsedDirs: paths });
      persist(PERSISTED.tree, paths);
    },

    setFold(path, folded) {
      set((s) => ({ fileFold: { ...s.fileFold, [path]: folded } }));
    },

    async setViewed(file, viewed) {
      const blob = viewedBlob(file);
      if (!blob) return;
      const key = markKey(file.path, blob);
      set((s) => {
        const next = new Set(s.viewed);
        if (viewed) next.add(key);
        else next.delete(key);
        const { [file.path]: _drop, ...fileFold } = s.fileFold; // viewing a file folds it, like GitHub
        return { viewed: next, fileFold };
      });
      try {
        await api.setFileMark(file.path, blob, viewed);
      } catch (e) {
        fail(e);
        await get().refreshMarks();
      }
    },

    select(target) {
      set({ selection: target });
    },

    setComposerText(key, text) {
      set((s) => {
        const { [key]: _drop, ...rest } = s.composerText;
        return { composerText: text === null || text === '' ? rest : { ...rest, [key]: text } };
      });
    },

    openComposer(target) {
      set({ composer: target, selection: target });
    },

    async createThread(target, body) {
      const resolved = get().resolved;
      if (!resolved) return;
      try {
        await api.createThread({
          from_tree: resolved.from.tree, to_tree: resolved.to.tree,
          path: target.path, side: target.side, start_line: target.start, end_line: target.end, body,
        });
        set({ composer: null, selection: null });
        await Promise.all([get().refreshThreads(), get().refreshReviews()]);
      } catch (e) {
        fail(e);
        throw e;
      }
    },

    async reply(threadId, body) {
      try {
        await api.reply(threadId, body);
        await Promise.all([get().refreshThreads(), get().refreshReviews()]);
      } catch (e) {
        fail(e);
        throw e;
      }
    },

    async editComment(commentId, body) {
      try {
        await api.editComment(commentId, body);
        await get().refreshThreads();
      } catch (e) {
        fail(e);
        throw e;
      }
    },

    async deleteComment(commentId) {
      try {
        await api.deleteComment(commentId);
        await Promise.all([get().refreshThreads(), get().refreshReviews()]);
      } catch (e) {
        fail(e);
      }
    },

    async setResolved(threadId, resolved) {
      try {
        await (resolved ? api.resolveThread(threadId) : api.unresolveThread(threadId));
        await get().refreshThreads();
      } catch (e) {
        fail(e);
      }
    },

    async setDraftBody(body) {
      try {
        const draft = await api.setDraftBody(body);
        set({ draft });
      } catch (e) {
        fail(e);
      }
    },

    async submit(body) {
      try {
        const review = await api.submit(body);
        set({ panel: null });
        get().toast(`Review #${review.id} submitted. Claude will pick it up.`);
        await Promise.all([get().refreshThreads(), get().refreshReviews()]);
      } catch (e) {
        fail(e);
        throw e;
      }
    },

    setPanel(panel) {
      set({ panel });
    },

    focus(threadId) {
      set({ focusThread: threadId });
    },

    revealFile(path) {
      set((s) => ({ revealPath: { path, n: (s.revealPath?.n ?? 0) + 1 } }));
    },

    toast(text, action) {
      const id = ++toastId;
      set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, ...(action && { action }) }] }));
      setTimeout(() => get().dismiss(id), action ? 12_000 : 5_000);
    },

    dismiss(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },

    setConnected(connected) {
      const was = get().connected;
      set({ connected });
      // Anything could have happened while the feed was down.
      if (connected && !was && get().booted) {
        void get().refreshThreads();
        void get().refreshReviews();
        void api.health().then((h) => set({ listening: h.listening }), () => undefined);
      }
    },

    handleEvent(e) {
      const s = get();
      switch (e.type) {
        case 'draft.changed':
          void s.refreshThreads();
          void s.refreshReviews();
          break;
        case 'thread.replied':
        case 'thread.resolved':
        case 'thread.unresolved':
          void s.refreshThreads();
          break;
        case 'review.submitted':
        case 'review.started':
          void s.refreshReviews();
          void s.refreshThreads();
          break;
        case 'review.completed': {
          void s.refreshReviews();
          void s.refreshThreads();
          const id = Number(e.review_id);
          s.toast(`Claude finished review #${id}.`, {
            label: 'Show changes since review',
            run: () => void get().setScope({ kind: 'since_review', review_id: id }),
          });
          break;
        }
        case 'agents.changed':
          set({ listening: Number(e.listening) || 0 });
          break;
        case 'archive.changed':
          void s.refreshThreads();
          void s.refreshReviews();
          break;
        case 'suggestion.applied':
          void s.refreshThreads();
          break;
        case 'marks.changed':
          void s.refreshMarks();
          void s.refreshSections();
          break;
        case 'worktree.changed':
        case 'base.changed':
          if (s.resolved?.to.live || e.type === 'base.changed') set({ stale: true });
          break;
      }
    },
  };
});

// Exposed for debugging and browser tests. Everything in it is also available through the API.
(globalThis as { __postil?: typeof useStore }).__postil = useStore;
