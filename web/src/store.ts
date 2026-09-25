import { create } from 'zustand';
import type {
  AnchoredSectionMark, BaseInfo, CommitsInfo, FileChange, FinishOptions, Preferences, Hunk, FileDiff, Health, ResolvedDiff, ReviewView, Scope, Side, ThreadView,
} from '../../src/core/api-types.ts';
import { api, ApiError } from './api.ts';
import { diffKey, markKey, sidePath, viewedBlob } from './format.ts';
import { highlight, MAX_HIGHLIGHT_LINES, type Token } from './highlight/index.tsx';
import { withExpanded } from './lib/expanded.ts';
import { add, removeOverlapping, type Range } from './lib/ranges.ts';
import { notePin } from './lib/pin.ts';
import { hunkDone, hunkRanges, marksOverlapping, validMarks } from './lib/sections.ts';

export type ViewMode = 'unified' | 'split';
export type Panel = 'threads' | 'review' | null;

export interface Target {
  /** The file as the page shows it (its current path); used to match UI state to a file. */
  path: string;
  /** The file's path on `side`, which is what the server needs; differs for a renamed file. */
  sidePath?: string;
  side: Side;
  start: number;
  end: number;
}

/** A comment's target: some lines of a file, or the whole file (no lines). */
export type ThreadTarget = Target | (Omit<Target, 'start' | 'end'> & { start: null; end: null });

/** Where a new comment's unsent text lives in `composerText`. */
export function newThreadKey(t: ThreadTarget): string {
  return t.start === null ? `new:${t.path}:file` : `new:${t.path}:${t.side}:${t.start}-${t.end}`;
}

export function rangeLabel(t: Pick<Target, 'start' | 'end'>): string {
  return t.start === t.end ? `L${t.start}` : `L${t.start}–${t.end}`;
}

function sameTarget(a: Target, b: Target): boolean {
  return a.path === b.path && a.side === b.side && a.start === b.start && a.end === b.end;
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
  /** The file (by path) whose whole-file comment composer is open. */
  fileComposer: string | null;
  /** Unsent comment text by composer, kept here so it survives its file scrolling out of the DOM. */
  composerText: Record<string, string>;
  panel: Panel;
  focusThread: number | null;
  /**
   * A request to scroll a file into view, or an element in it (`anchor`, an element id) such as
   * a conversation; `n` makes repeated requests distinct.
   */
  revealPath: { path: string; n: number; anchor?: string } | null;
  toasts: Toast[];
  /** A review Claude just finished, offered as "show what changed" until dismissed. */
  completedReview: number | null;
  /** The user ended the review session: everything resolved and archived. */
  sessionFinished: boolean;
  /** What the user has chosen for Claude to do as the session ends, kept while they review. */
  finishChoices: Required<FinishOptions>;
  preferences: Preferences;
}

interface Actions {
  boot(): Promise<void>;
  setScope(scope: Scope): Promise<void>;
  /** Measure "all changes" from a branch, or null for the default base. */
  setBaseBranch(branch: string | null): Promise<void>;
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
  /** Viewed means every section done: viewing marks them all, unviewing clears them unless `keepSections`. */
  setViewed(file: FileChange, viewed: boolean, opts?: { keepSections?: boolean }): Promise<void>;
  /** Mark many files viewed or not in one request, such as every file in a folder. */
  setViewedMany(files: FileChange[], viewed: boolean): Promise<void>;

  select(target: Target | null): void;
  setComposerText(key: string, text: string | null): void;
  openComposer(target: Target | null): void;
  openFileComposer(path: string | null): void;
  createThread(target: ThreadTarget, body: string): Promise<void>;
  reply(threadId: number, body: string): Promise<void>;
  editComment(commentId: number, body: string): Promise<void>;
  deleteComment(commentId: number): Promise<void>;
  setResolved(threadId: number, resolved: boolean): Promise<void>;
  setDraftBody(body: string): Promise<void>;
  submit(body: string): Promise<void>;
  finishSession(opts: FinishOptions): Promise<void>;
  /** Discard the review in progress, whatever state it is in, to start a new one. */
  resetReviews(): Promise<void>;
  setFinishChoices(change: Partial<FinishOptions>): void;
  setPreferences(change: Partial<Preferences>): Promise<void>;
  dismissCompleted(): void;

  setPanel(panel: Panel): void;
  focus(threadId: number | null): void;
  revealFile(path: string, anchor?: string): void;
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
let refreshTicket = 0;



const inflight = new Map<string, Promise<unknown>>();
/**
 * Diff requests still in flight. The browser runs only a few requests per server at once, so after
 * a fast scroll, requests for files already gone would otherwise delay the files on screen.
 */
const diffRequests = new Map<string, AbortController>();

const queues = new Map<string, Promise<unknown>>();
/** Run `fn` after everything queued before it under the same key. */
function queued<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => undefined);
  return next;
}

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

  /** Mark every section of a file done, or clear them all, so "viewed" and its sections agree. */
  const syncSections = async (file: FileChange, done: boolean) => {
    const diff = get().diffs[diffKey(file)];
    const marks = validMarks(get().sections, file);
    if (done) {
      if (diff?.state !== 'ready') return;
      for (const hunk of diff.value.hunks) {
        if (hunkDone(hunk, marks)) continue;
        for (const r of hunkRanges(hunk)) {
          await api.addSectionMark({
            path: sidePath(file, r.side), from_blob: file.old_blob, to_blob: file.new_blob, side: r.side, start_line: r.start, end_line: r.end,
          });
        }
      }
    } else {
      for (const m of marks) await api.removeSectionMark(m.id);
    }
    await get().refreshSections();
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
    fileComposer: null,
    composerText: {},
    panel: null,
    focusThread: null,
    revealPath: null,
    toasts: [],
    completedReview: null,
    sessionFinished: false,
    finishChoices: { commit: true, push: false, message: '' },
    preferences: { commit_each_review: false },

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
        set({ preferences: await api.preferences() });
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

    async setBaseBranch(branch) {
      try {
        set({ base: await api.setBaseBranch(branch) });
      } catch (e) {
        return fail(e);
      }
      await get().refresh();
    },

    async refresh() {
      // Only the newest refresh may land: a slow answer for a scope the user has since left must
      // not overwrite the diff they switched to.
      const ticket = ++refreshTicket;
      set({ resolving: true, resolveError: null });
      try {
        const [resolved, base] = await Promise.all([api.resolve(get().scope), api.base()]);
        if (ticket !== refreshTicket) return;
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
        if (ticket !== refreshTicket) return;
        if (e instanceof ApiError && e.status === 401) set({ authFailed: true });
        set({ resolveError: errorText(e) });
      } finally {
        if (ticket === refreshTicket) set({ resolving: false });
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
            await api.addSectionMark({
              path: sidePath(file, r.side), from_blob: file.old_blob, to_blob: file.new_blob, side: r.side, start_line: r.start, end_line: r.end,
            });
          }
        } else {
          for (const m of marksOverlapping(hunk, validMarks(get().sections, file))) await api.removeSectionMark(m.id);
          const blob = viewedBlob(file);
          if (blob && get().viewed.has(markKey(file.path, blob))) await get().setViewed(file, false, { keepSections: true });
        }
        await get().refreshSections();
        // Finishing the last section finishes the file.
        const diff = get().diffs[diffKey(file)];
        if (done && diff?.state === 'ready') {
          const marks = validMarks(get().sections, file);
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
        const expanded = withExpanded(s.expanded, blob, add(s.expanded[blob] ?? [], range));
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
      notePin(path);
      set((s) => ({ fileFold: { ...s.fileFold, [path]: folded } }));
    },

    async setViewed(file, viewed, opts = {}) {
      const blob = viewedBlob(file);
      if (!blob) return;
      notePin(file.path);
      const was = get().viewed.has(markKey(file.path, blob));
      const key = markKey(file.path, blob);
      set((s) => {
        const next = new Set(s.viewed);
        if (viewed) next.add(key);
        else next.delete(key);
        const { [file.path]: _drop, ...fileFold } = s.fileFold; // viewing a file folds it
        return { viewed: next, fileFold };
      });
      try {
        // One file's marks change in order: unviewing right after viewing must not race it.
        await queued(file.path, async () => {
          await api.setFileMark(file.path, blob, viewed);
          if (viewed !== was && !opts.keepSections) await syncSections(file, viewed);
        });
      } catch (e) {
        fail(e);
        await get().refreshMarks();
      }
    },

    async setViewedMany(files, viewed) {
      const changing = files.flatMap((file) => {
        const blob = viewedBlob(file);
        return blob && get().viewed.has(markKey(file.path, blob)) !== viewed ? [{ file, blob }] : [];
      });
      if (changing.length === 0) return;
      set((s) => {
        const next = new Set(s.viewed);
        const fileFold = { ...s.fileFold };
        for (const { file, blob } of changing) {
          if (viewed) next.add(markKey(file.path, blob));
          else next.delete(markKey(file.path, blob));
          delete fileFold[file.path]; // viewing a file folds it
        }
        return { viewed: next, fileFold };
      });
      try {
        await api.setFileMarks(changing.map(({ file, blob }) => ({ path: file.path, blob })), viewed);
        // Keep sections in step only where there are any to touch: a loaded diff to mark done, or marks to clear.
        for (const { file } of changing) {
          const loaded = get().diffs[diffKey(file)]?.state === 'ready';
          if (viewed ? loaded : validMarks(get().sections, file).length > 0) {
            await queued(file.path, () => syncSections(file, viewed));
          }
        }
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
      const current = get().composer;
      if (current && !(target && sameTarget(current, target))) {
        const text = get().composerText[newThreadKey(current)];
        if (text?.trim()) {
          get().toast(`Kept your unsent comment on ${current.path}:${rangeLabel(current)}.`, {
            label: 'Reopen', run: () => get().openComposer(current),
          });
        }
      }
      set({ composer: target, selection: target, ...(target && { fileComposer: null }) });
    },

    openFileComposer(path) {
      set({ fileComposer: path, ...(path && { composer: null, selection: null }) });
      if (path) get().setFold(path, false);
    },

    async createThread(target, body) {
      const resolved = get().resolved;
      if (!resolved) return;
      try {
        await api.createThread({
          from_tree: resolved.from.tree, to_tree: resolved.to.tree,
          path: target.sidePath ?? target.path, side: target.side, start_line: target.start, end_line: target.end, body,
        });
        set(target.start === null ? { fileComposer: null } : { composer: null, selection: null });
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
        set({ panel: null, completedReview: null });
        get().toast(`Review #${review.id} submitted. Claude will pick it up.`);
        await Promise.all([get().refreshThreads(), get().refreshReviews()]);
      } catch (e) {
        fail(e);
        throw e;
      }
    },

    async setPreferences(change) {
      try {
        set({ preferences: await api.setPreferences(change) });
      } catch (e) {
        fail(e);
      }
    },

    async finishSession(opts) {
      try {
        await api.finishSession(opts);
        set({ sessionFinished: true, panel: null, completedReview: null });
        await Promise.all([get().refreshThreads(), get().refreshReviews()]);
      } catch (e) {
        fail(e);
      }
    },

    async resetReviews() {
      try {
        const r = await api.reset();
        set({ sessionFinished: false, completedReview: null });
        get().toast(`Started over: archived ${r.threads} conversation${r.threads === 1 ? '' : 's'} and ${r.reviews} review${r.reviews === 1 ? '' : 's'}.`);
        await Promise.all([get().refreshThreads(), get().refreshReviews(), get().refreshMarks(), get().refreshSections()]);
      } catch (e) {
        fail(e);
      }
    },

    setFinishChoices(change) {
      set({ finishChoices: { ...get().finishChoices, ...change } });
    },

    dismissCompleted() {
      set({ completedReview: null });
    },

    setPanel(panel) {
      set({ panel });
    },

    focus(threadId) {
      set({ focusThread: threadId });
    },

    revealFile(path, anchor) {
      set((s) => ({ revealPath: { path, n: (s.revealPath?.n ?? 0) + 1, ...(anchor && { anchor }) } }));
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
          set({ completedReview: Number(e.review_id) });
          notifyYourTurn(Number(e.review_id));
          break;
        }
        case 'preferences.changed':
          void api.preferences().then((preferences) => set({ preferences }), () => undefined);
          break;
        case 'session.finished':
          set({ sessionFinished: true });
          void s.refreshThreads();
          void s.refreshReviews();
          break;
        case 'session.reset':
          set({ sessionFinished: false, completedReview: null });
          void s.refreshThreads();
          void s.refreshReviews();
          break;
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
          if (s.resolved?.to.live) set({ stale: true });
          break;
        case 'base.changed':
          // Changed here, the diff is already being refreshed; changed elsewhere (the CLI), offer to.
          void api.base().then((base) => {
            if (JSON.stringify(base.config) !== JSON.stringify(get().base?.config)) set({ stale: true });
          }, () => set({ stale: true }));
          break;
      }
    },
  };
});

/** Ask to send desktop notifications. Called on submitting, the moment the user starts waiting on Claude. */
export function askToNotify(): void {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission();
}

/** Tell a user who is looking at another window that Claude is done and it is their turn. */
function notifyYourTurn(id: number): void {
  if (!document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const n = new Notification('postil: your turn', { body: `Claude finished review #${id}.`, tag: 'postil-your-turn' });
  n.onclick = () => {
    window.focus();
    n.close();
  };
}

// Exposed for debugging and browser tests. Everything in it is also available through the API.
(globalThis as { __postil?: typeof useStore }).__postil = useStore;
