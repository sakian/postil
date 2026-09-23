import { create } from 'zustand';
import type {
  BaseInfo, FileChange, FileDiff, Health, ResolvedDiff, ReviewView, Scope, Side, ThreadView,
} from '../../src/core/api-types.ts';
import { api, ApiError } from './api.ts';
import { diffKey, markKey, viewedBlob } from './format.ts';
import { add, removeOverlapping, type Range } from './lib/ranges.ts';

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
  resolving: boolean;
  resolveError: string | null;
  /** The working tree moved since the diff was resolved. */
  stale: boolean;

  diffs: Record<string, Loadable<FileDiff>>;
  lines: Record<string, Loadable<string[]>>;
  threads: ThreadView[];
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
  panel: Panel;
  focusThread: number | null;
  toasts: Toast[];
}

interface Actions {
  boot(): Promise<void>;
  setScope(scope: Scope): Promise<void>;
  refresh(): Promise<void>;
  refreshThreads(): Promise<void>;
  refreshReviews(): Promise<void>;
  refreshMarks(): Promise<void>;
  loadDiff(file: FileChange, force?: boolean): Promise<void>;
  loadLines(oid: string, total: number): Promise<string[] | null>;

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
    resolving: false,
    resolveError: null,
    stale: false,
    diffs: {},
    lines: {},
    threads: [],
    reviews: [],
    draft: null,
    viewed: new Set(),
    view: 'unified',
    expanded: {},
    collapsedDirs: [],
    fileFold: {},
    selection: null,
    composer: null,
    panel: null,
    focusThread: null,
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
        await Promise.all([get().refresh(), get().refreshThreads(), get().refreshReviews(), get().refreshMarks()]);
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
        set({ resolved, base, stale: false });
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
      try {
        set({ threads: (await api.threads()).threads });
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

    async loadDiff(file, force = false) {
      const key = diffKey(file);
      const current = get().diffs[key];
      if (!force && current && current.state !== 'error') return;
      set((s) => ({ diffs: { ...s.diffs, [key]: { state: 'loading' } } }));
      try {
        const value = await api.fileDiff(file.old_blob, file.new_blob, { force });
        set((s) => ({ diffs: { ...s.diffs, [key]: { state: 'ready', value } } }));
      } catch (e) {
        set((s) => ({ diffs: { ...s.diffs, [key]: { state: 'error', message: errorText(e) } } }));
      }
    },

    async loadLines(oid, total) {
      const current = get().lines[oid];
      if (current?.state === 'ready') return current.value;
      if (current?.state === 'loading') return null;
      set((s) => ({ lines: { ...s.lines, [oid]: { state: 'loading' } } }));
      try {
        const all: string[] = [];
        for (let start = 1; start <= total; start += 10_000) {
          const chunk = await api.lines(oid, start, Math.min(total, start + 9_999));
          all.push(...chunk.lines);
        }
        set((s) => ({ lines: { ...s.lines, [oid]: { state: 'ready', value: all } } }));
        return all;
      } catch (e) {
        set((s) => ({ lines: { ...s.lines, [oid]: { state: 'error', message: errorText(e) } } }));
        return null;
      }
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
        case 'marks.changed':
          void s.refreshMarks();
          break;
        case 'worktree.changed':
        case 'base.changed':
          if (s.resolved?.to.live || e.type === 'base.changed') set({ stale: true });
          break;
      }
    },
  };
});
