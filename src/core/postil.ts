import { createHash } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Store } from '../db/store.ts';
import type { CommentRow, ReviewRow, SectionMarkRow, Side, ThreadRow } from '../db/types.ts';
import { GitError } from '../git/exec.ts';
import { splitLines } from '../git/parse.ts';
import { assertOid, Repo } from '../git/repo.ts';
import type { FileChange, Hunk } from '../git/types.ts';
import { reanchor, type Anchor } from './anchors.ts';
import { extractSuggestion, hasSuggestion, replaceLines } from './suggestion.ts';
import { EventBus } from './events.ts';
import { agentHint } from './hints.ts';

export { agentHint } from './hints.ts';
import { HttpError } from './util.ts';

import type {
  AgentReview, AgentThread, AppliedSuggestion, BaseConfig, BaseInfo, BranchesInfo, CommentView, FinishOptions, Preferences, CommitsInfo, Endpoint, FileDiff, HookStatus, ListenResult,
  NewThreadInput, ResolvedScope, ReviewView, Scope, ThreadView,
} from './api-types.ts';

export type * from './api-types.ts';

// ---------------------------------------------------------------------------- limits

const MAX_BODY = 64 * 1024;
const MAX_DIFF_BLOB = 4 * 1024 * 1024;
/** A diff line longer than this suggests minified or generated code, which is not worth rendering unasked. */
const MAX_DIFF_LINE = 20_000;
const SNAPSHOT_SETTLE_MS = 120;
const SNAPSHOT_SETTLE_TRIES = 5;
const MAX_LINES_PER_REQUEST = 10_000;
const MAX_UI_STATE = 256 * 1024;
const UI_KEY = /^[\w.:-]{1,128}$/;

function requireBody(body: string, what = 'body'): string {
  if (body.trim() === '') throw new HttpError(400, `${what} must not be empty`, 'empty_body');
  if (body.length > MAX_BODY) throw new HttpError(413, `${what} exceeds ${MAX_BODY} characters`, 'body_too_large');
  return body;
}

const SESSION_ID = /^[\w-]{1,128}$/;

/** Claude Code session ids arrive from hooks and tool calls; accept only the plain id shape. */
export function assertSession(value: string): string {
  if (!SESSION_ID.test(value)) throw new HttpError(400, 'invalid session id', 'invalid_session');
  return value;
}

function short(oid: string | null): string {
  return oid ? oid.slice(0, 7) : 'empty';
}

// ---------------------------------------------------------------------------- service

/**
 * The review workflow over one repository. HTTP routes and the MCP proxy are thin
 * adapters over this class; every rule about reviews, threads and snapshots lives here.
 */
export class Postil {
  readonly repo: Repo;
  readonly store: Store;
  readonly bus: EventBus;
  private lastLiveTree: string | null = null;
  /** Zero-context hunks between two blobs, and renames between two trees. Both are immutable, so cached. */
  private readonly lineMaps = new Map<string, Hunk[]>();
  private readonly renames = new Map<string, Map<string, string>>();
  /** Open agent event sockets per Claude session: a session is "live" while its monitor is armed. */
  private readonly liveAgents = new Map<string, number>();

  constructor(repo: Repo, store: Store, bus: EventBus = new EventBus()) {
    this.repo = repo;
    this.store = store;
    this.bus = bus;
  }

  static async open(cwd: string, bus?: EventBus): Promise<Postil> {
    const repo = await Repo.open(cwd);
    const store = new Store(join(repo.stateDir, 'postil.db'));
    const postil = new Postil(repo, store, bus);
    await postil.ensureBase();
    return postil;
  }

  close(): void {
    this.store.close();
  }

  // ------------------------------------------------------------------ base

  /**
   * On a feature branch, the base follows the merge base with the branch its pull request
   * targets (per the GitHub CLI), or else the default branch, as a pull request would.
   * Anywhere else, it is HEAD when postil first ran here, so "all changes" means everything
   * since review began.
   */
  private async defaultBase(): Promise<BaseConfig> {
    const [branch, fallback, head] = await Promise.all([
      this.repo.currentBranch(), this.repo.defaultBranch(), this.repo.head(),
    ]);
    if (!branch || !head || branch === fallback) return { mode: 'commit', commit: head };
    // GitHub diffs a pull request against the remote branch, and a local copy can be stale or
    // diverged (after a force push), so prefer origin's.
    const prBase = await this.repo.pullRequestBase();
    const target = (prBase && ((await this.repo.findBranch(`origin/${prBase}`)) ?? (await this.repo.findBranch(prBase)))) ?? fallback;
    return target && target !== branch ? { mode: 'merge-base', target } : { mode: 'commit', commit: head };
  }

  private async ensureBase(): Promise<void> {
    if (this.store.getSetting('base') === null) await this.saveBase(await this.defaultBase());
  }

  /** Store the base, pinning a fixed commit so a rebase or gc cannot take it away. */
  private async saveBase(config: BaseConfig): Promise<void> {
    await this.repo.pinBase(config.mode === 'commit' ? config.commit : null);
    this.store.setSetting('base', JSON.stringify(config));
  }

  private baseConfig(): BaseConfig {
    return JSON.parse(this.store.getSetting('base') ?? '{"mode":"commit","commit":null}') as BaseConfig;
  }

  async base(): Promise<BaseInfo> {
    const config = this.baseConfig();
    const emptyTree = await this.repo.emptyTree();
    if (config.mode === 'commit') {
      if (config.commit === null) return { config, commit: null, tree: emptyTree, label: 'empty tree' };
      try {
        return { config, commit: config.commit, tree: await this.repo.resolveTree(config.commit), label: short(config.commit) };
      } catch (e) {
        // Chosen before postil pinned bases, and since lost to gc. Degrade rather than break every view.
        if (!(e instanceof HttpError && e.status === 404)) throw e;
        return {
          config, commit: null, tree: emptyTree, label: 'empty tree',
          warning: `base commit ${short(config.commit)} no longer exists; choose another with \`postil base\``,
        };
      }
    }
    const head = await this.repo.head();
    const mergeBase = head ? await this.repo.mergeBase('HEAD', config.target).catch(() => null) : null;
    if (!mergeBase) {
      return {
        config, commit: null, tree: emptyTree, label: 'empty tree',
        warning: `no merge base between HEAD and ${config.target}`,
      };
    }
    return {
      config, commit: mergeBase, tree: await this.repo.resolveTree(mergeBase),
      label: `merge base with ${config.target} (${short(mergeBase)})`,
    };
  }

  /** Measure "all changes" from a commit, or from nothing (null), which reviews every file in the tree. */
  async setBase(rev: string | null): Promise<BaseInfo> {
    const commit = rev === null ? null : await this.repo.resolveCommit(rev);
    await this.saveBase({ mode: 'commit', commit });
    this.bus.emit({ type: 'base.changed' });
    return this.base();
  }

  async branches(): Promise<BranchesInfo> {
    const [branches, current] = await Promise.all([this.repo.branches(), this.repo.currentBranch()]);
    return { branches: branches.filter((b) => b !== current), current };
  }

  /** Measure "all changes" from the merge base with a branch, following it as it moves, as a pull request does. */
  async setBaseBranch(name: string): Promise<BaseInfo> {
    const target = await this.repo.findBranch(name);
    if (!target) throw new HttpError(404, `no branch named ${JSON.stringify(name)}`, 'unknown_branch');
    await this.saveBase({ mode: 'merge-base', target });
    this.bus.emit({ type: 'base.changed' });
    return this.base();
  }

  async resetBase(): Promise<BaseInfo> {
    await this.saveBase(await this.defaultBase());
    this.bus.emit({ type: 'base.changed' });
    return this.base();
  }

  // ------------------------------------------------------------------ working tree & snapshots

  /** The working tree's tree id. Announces a change to the UI whenever it moves. */
  async liveTree(): Promise<string> {
    const tree = await this.repo.worktreeTree();
    if (this.lastLiveTree !== null && tree !== this.lastLiveTree) {
      this.bus.emit({ type: 'worktree.changed', tree });
    }
    this.lastLiveTree = tree;
    return tree;
  }

  /** Pin a tree so gc cannot remove it, and record why. */
  async pinTree(tree: string, reason: string): Promise<void> {
    await this.repo.pin(tree);
    this.store.upsertSnapshot(tree, await this.repo.head(), reason);
  }

  /**
   * Pin the current working tree and return its id. Claude may be halfway through writing a file
   * at this moment, so wait until two reads a moment apart agree before trusting the tree.
   */
  async snapshot(reason: string): Promise<string> {
    let tree = await this.liveTree();
    for (let i = 0; i < SNAPSHOT_SETTLE_TRIES; i++) {
      await new Promise((r) => setTimeout(r, SNAPSHOT_SETTLE_MS));
      const again = await this.liveTree();
      if (again === tree) break;
      tree = again;
    }
    await this.pinTree(tree, reason);
    return tree;
  }

  // ------------------------------------------------------------------ scopes

  private async endpointForCommit(rev: string): Promise<Endpoint> {
    const commit = await this.repo.resolveCommit(rev);
    return { tree: await this.repo.resolveTree(commit), commit, label: short(commit), live: false };
  }

  private async liveEndpoint(): Promise<Endpoint> {
    return { tree: await this.liveTree(), commit: null, label: 'working tree', live: true };
  }

  async resolveScope(scope: Scope): Promise<ResolvedScope> {
    switch (scope.kind) {
      case 'all': {
        const base = await this.base();
        return {
          scope,
          from: { tree: base.tree, commit: base.commit, label: `base: ${base.label}`, live: false },
          to: await this.liveEndpoint(),
        };
      }
      case 'uncommitted': {
        const head = await this.repo.head();
        const from = head
          ? { ...(await this.endpointForCommit(head)), label: `HEAD (${short(head)})` }
          : { tree: await this.repo.emptyTree(), commit: null, label: 'empty tree', live: false };
        return { scope, from, to: await this.liveEndpoint() };
      }
      case 'since_review': {
        const review = scope.review_id === undefined ? this.store.latestSubmittedReview() : this.store.getReview(scope.review_id);
        if (!review?.submit_tree) {
          throw new HttpError(404, scope.review_id === undefined ? 'no review has been submitted yet' : `review ${scope.review_id} was never submitted`, 'no_review');
        }
        return {
          scope,
          from: { tree: review.submit_tree, commit: null, label: `review #${review.id} submitted`, live: false },
          to: await this.liveEndpoint(),
        };
      }
      case 'commits': {
        // An inclusive range of commits, oldest first: the diff runs from the parent of `from`.
        const first = await this.repo.resolveCommit(scope.from);
        const parentTree = await this.repo.resolveTree(`${first}^1`).catch(async (e: unknown) => {
          if (e instanceof HttpError && e.status === 404) return this.repo.emptyTree();
          throw e;
        });
        const to = scope.to === 'worktree' ? await this.liveEndpoint() : await this.endpointForCommit(scope.to);
        return { scope, from: { tree: parentTree, commit: null, label: `before ${short(first)}`, live: false }, to };
      }
      case 'trees': {
        const from = await this.repo.resolveTree(assertOid(scope.from, 'tree id'));
        const to = await this.repo.resolveTree(assertOid(scope.to, 'tree id'));
        return {
          scope,
          from: { tree: from, commit: null, label: short(from), live: false },
          to: { tree: to, commit: null, label: short(to), live: false },
        };
      }
    }
  }

  async commits(): Promise<CommitsInfo> {
    const [base, head, branch] = await Promise.all([this.base(), this.repo.head(), this.repo.currentBranch()]);
    const commits = head ? await this.repo.log(base.commit, head) : [];
    const headTree = head ? await this.repo.resolveTree(head) : await this.repo.emptyTree();
    return { base, head, branch, commits, uncommitted: (await this.liveTree()) !== headTree };
  }

  // ------------------------------------------------------------------ diffs

  async files(from: string, to: string): Promise<FileChange[]> {
    return this.repo.diffFiles(assertOid(from, 'tree id'), assertOid(to, 'tree id'));
  }

  async fileDiff(
    oldBlob: string | null,
    newBlob: string | null,
    opts: { context?: number; ignoreWhitespace?: boolean; force?: boolean } = {},
  ): Promise<FileDiff> {
    const nothing = { old_blob: oldBlob, new_blob: newBlob, binary: false, old_lines: null, new_lines: null, hunks: [] };
    // Same content on both sides (a pure rename or mode change): no need to read either blob.
    if (oldBlob !== null && oldBlob === newBlob) return { ...nothing, too_large: false };
    const sizes = await Promise.all([oldBlob, newBlob].map((b) => (b ? this.repo.blobSize(b) : 0)));
    if (!opts.force && sizes.some((s) => s > MAX_DIFF_BLOB)) return { ...nothing, too_large: true, too_large_reason: 'size' };
    const info = async (b: string | null) => (b ? (await this.repo.blobInfo(b)).lines : null);
    const [oldLines, newLines] = await Promise.all([info(oldBlob), info(newBlob)]);
    const parsed = await this.repo.diffBlobs(oldBlob, newBlob, opts);
    if (!opts.force && parsed.hunks.some((h) => h.lines.some((l) => l.text.length > MAX_DIFF_LINE))) {
      return { ...nothing, too_large: true, too_large_reason: 'long_lines' };
    }
    return {
      old_blob: oldBlob, new_blob: newBlob, binary: parsed.binary, too_large: false,
      old_lines: parsed.binary ? null : oldLines,
      new_lines: parsed.binary ? null : newLines,
      hunks: parsed.hunks,
    };
  }

  /** Lines start..end (1-based, inclusive) of a blob, for expanding context between hunks. */
  async lines(oid: string, start: number, end: number): Promise<{ oid: string; start: number; end: number; total: number; lines: string[] }> {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      throw new HttpError(400, 'start and end must be integers with 1 <= start <= end', 'invalid_range');
    }
    if (end - start + 1 > MAX_LINES_PER_REQUEST) {
      throw new HttpError(413, `at most ${MAX_LINES_PER_REQUEST} lines per request`, 'range_too_large');
    }
    const info = await this.repo.blobInfo(oid);
    if (info.binary) throw new HttpError(422, 'blob is binary', 'binary_blob');
    const all = splitLines(await this.repo.readBlob(oid));
    const last = Math.min(end, all.length);
    return { oid, start, end: last, total: all.length, lines: start > last ? [] : all.slice(start - 1, last) };
  }

  // ------------------------------------------------------------------ anchors

  private async zeroContextHunks(a: string, b: string): Promise<Hunk[]> {
    const key = `${a}..${b}`;
    let hunks = this.lineMaps.get(key);
    if (!hunks) {
      hunks = (await this.repo.diffBlobs(a, b, { context: 0 })).hunks;
      if (this.lineMaps.size > 2000) this.lineMaps.clear();
      this.lineMaps.set(key, hunks);
    }
    return hunks;
  }

  /** The path `path` was renamed to between two trees, if it was. */
  private async renamedTo(fromTree: string, toTree: string, path: string): Promise<string | null> {
    const key = `${fromTree}..${toTree}`;
    let map = this.renames.get(key);
    if (!map) {
      map = new Map();
      for (const f of await this.repo.diffFiles(fromTree, toTree)) {
        if (f.status === 'renamed' && f.old_path && f.new_path) map.set(f.old_path, f.new_path);
      }
      if (this.renames.size > 200) this.renames.clear();
      this.renames.set(key, map);
    }
    return map.get(path) ?? null;
  }

  /** Where a thread's lines are in the given diff: on its new side for new-side threads, old side otherwise. */
  async anchorFor(thread: ThreadRow, target: { from_tree: string; to_tree: string }): Promise<Anchor> {
    return this.anchorRange(
      {
        path: thread.path, side: thread.side, blob: thread.blob, start: thread.start_line, end: thread.end_line,
        origin: thread.side === 'new' ? thread.to_tree : thread.from_tree,
      },
      target,
    );
  }

  /**
   * Where a line range of one version of a file is in a diff. `origin` is a tree containing that
   * version, used to follow renames; without it a renamed file counts as gone.
   */
  async anchorRange(
    r: { path: string; side: Side; blob: string; start: number | null; end: number | null; origin?: string },
    target: { from_tree: string; to_tree: string },
  ): Promise<Anchor> {
    const tree = r.side === 'new' ? target.to_tree : target.from_tree;
    let path = r.path;
    let entry = await this.repo.entryAt(tree, path);
    if (!entry && r.origin) {
      const renamed = await this.renamedTo(r.origin, tree, path);
      if (renamed) {
        path = renamed;
        entry = await this.repo.entryAt(tree, path);
      }
    }
    if (!entry || entry.type !== 'blob') return { state: 'gone', path, start_line: null, end_line: null };
    const { start, end } = r;
    if (start === null || end === null) return { state: 'current', path, start_line: null, end_line: null };
    if (entry.oid === r.blob) return { state: 'current', path, start_line: start, end_line: end };

    try {
      const info = await this.repo.blobInfo(entry.oid);
      if (info.binary) return { state: 'gone', path, start_line: null, end_line: null };
      const mapped = reanchor(await this.zeroContextHunks(r.blob, entry.oid), start, end, info.lines);
      if (mapped.state === 'gone') return { state: 'gone', path, start_line: null, end_line: null };
      const anchor: Anchor = { state: mapped.state, path, start_line: mapped.start, end_line: mapped.end };
      if (mapped.state === 'outdated') {
        anchor.current_text = splitLines(await this.repo.readBlob(entry.oid)).slice(mapped.start - 1, mapped.end).join('\n');
      }
      return anchor;
    } catch (e) {
      // The original blob can be missing once an archived comment's snapshot has been pruned.
      if ((e instanceof HttpError && e.status === 404) || e instanceof GitError) return { state: 'gone', path, start_line: null, end_line: null };
      throw e;
    }
  }

  /** Threads with their anchors in a diff, for placing them in the UI. */
  async threadsIn(target: { from_tree: string; to_tree: string }, filter: { status?: 'open' | 'resolved'; path?: string } = {}): Promise<ThreadView[]> {
    assertOid(target.from_tree, 'tree id');
    assertOid(target.to_tree, 'tree id');
    const rows = this.store.listThreads(filter);
    const views = this.threadViews(rows, { includeDrafts: true });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return Promise.all(views.map(async (v) => ({ ...v, anchor: await this.anchorFor(byId.get(v.id)!, target) })));
  }

  /** Paths changed on the "to" side since the latest submitted review, for "updated" badges. */
  async sinceReview(toTree: string): Promise<{ review_id: number; changed: string[] } | null> {
    const review = this.store.latestSubmittedReview();
    if (!review?.submit_tree) return null;
    const files = await this.repo.diffFiles(review.submit_tree, assertOid(toTree, 'tree id'));
    return { review_id: review.id, changed: files.map((f) => f.new_path ?? f.old_path ?? f.path) };
  }

  // ------------------------------------------------------------------ suggestions

  /**
   * Write a comment's suggestion into the working tree, replacing the lines it is attached to.
   * Refused unless those lines are still exactly as they were when the comment was written, so
   * a suggestion can never overwrite code that has since changed.
   */
  async applySuggestion(commentId: number): Promise<AppliedSuggestion> {
    const comment = this.store.getComment(commentId);
    if (!comment) throw new HttpError(404, `no comment ${commentId}`, 'unknown_comment');
    if (comment.applied_at) throw new HttpError(409, `the suggestion in comment ${commentId} was already applied`, 'already_applied');
    let suggestion: string | null;
    try {
      suggestion = extractSuggestion(comment.body);
    } catch (e) {
      throw new HttpError(422, (e as Error).message, 'ambiguous_suggestion');
    }
    if (suggestion === null) throw new HttpError(422, `comment ${commentId} has no suggestion`, 'no_suggestion');
    const thread = this.store.getThread(comment.thread_id)!;
    if (thread.side !== 'new' || thread.start_line === null || thread.end_line === null) {
      throw new HttpError(422, 'only suggestions on lines of the new code can be applied', 'not_applicable');
    }

    const live = await this.liveTree();
    const anchor = await this.anchorFor(thread, { from_tree: thread.from_tree, to_tree: live });
    if ((anchor.state !== 'current' && anchor.state !== 'moved') || anchor.start_line === null || anchor.end_line === null) {
      throw new HttpError(409, 'the lines this suggestion replaces have changed since it was written', 'suggestion_outdated');
    }

    const file = resolve(this.repo.root, anchor.path);
    if (!file.startsWith(this.repo.root + sep)) throw new HttpError(422, 'path is outside the repository', 'bad_path');
    const stat = await lstat(file).catch(() => null);
    if (!stat?.isFile()) throw new HttpError(409, `${anchor.path} is not a regular file`, 'not_a_file');

    // Re-check against the bytes on disk: the snapshot above may already be a moment old.
    // Compare without carriage returns: git may store LF while the disk has CRLF (core.autocrlf), or
    // store CRLF as-is, so either side can carry them.
    const original = await readFile(file);
    let text: string;
    try {
      // Rewriting a file that is not UTF-8 through a string would corrupt every other line in it.
      text = new TextDecoder('utf-8', { fatal: true }).decode(original);
    } catch {
      throw new HttpError(422, `${anchor.path} is not UTF-8 text, so the suggestion cannot be applied safely`, 'not_utf8');
    }
    const bare = (lines: string) => lines.split('\n').map((l) => l.replace(/\r$/, '')).join('\n');
    const current = text.split('\n').slice(anchor.start_line - 1, anchor.end_line).join('\n');
    if (bare(current) !== bare(thread.anchor_text)) {
      throw new HttpError(409, 'the lines this suggestion replaces have changed since it was written', 'suggestion_outdated');
    }
    const tmp = `${file}.postil-${process.pid}.tmp`;
    await writeFile(tmp, replaceLines(text, anchor.start_line, anchor.end_line, suggestion), { mode: stat.mode });
    // Last check before replacing the file: if anything wrote to it meanwhile, keep their version.
    if (!(await readFile(file)).equals(original)) {
      await rm(tmp, { force: true });
      throw new HttpError(409, `${anchor.path} changed while the suggestion was being applied; try again`, 'file_changed');
    }
    await rename(tmp, file);

    this.store.markApplied(commentId);
    const added = suggestion === '' ? 0 : suggestion.split('\n').length;
    const result: AppliedSuggestion = {
      comment_id: commentId, thread_id: thread.id, path: anchor.path,
      start_line: anchor.start_line, end_line: anchor.start_line + Math.max(added, 1) - 1,
    };
    this.bus.emit({ type: 'suggestion.applied', ...result });
    await this.liveTree();
    return result;
  }

  // ------------------------------------------------------------------ views

  private threadViews(threads: ThreadRow[], opts: { includeDrafts: boolean }): ThreadView[] {
    const comments = this.store.commentsForThreads(threads.map((t) => t.id));
    const byThread = new Map<number, CommentRow[]>();
    for (const c of comments) {
      if (!opts.includeDrafts && c.draft) continue;
      const list = byThread.get(c.thread_id) ?? [];
      list.push(c);
      byThread.set(c.thread_id, list);
    }
    const views: ThreadView[] = [];
    for (const t of threads) {
      const list = byThread.get(t.id) ?? [];
      const published = list.filter((c) => !c.draft);
      if (list.length === 0) continue; // a thread whose only comments are drafts, hidden from this viewer
      const last = published.at(-1);
      views.push({
        ...t,
        published: published.length > 0,
        awaiting: t.status === 'resolved' || !last ? null : last.author === 'user' ? 'claude' : 'user',
        comments: list.map(({ thread_id: _t, ...c }) => c),
      });
    }
    return views;
  }

  threads(filter: { status?: 'open' | 'resolved'; path?: string } = {}): ThreadView[] {
    return this.threadViews(this.store.listThreads(filter), { includeDrafts: true });
  }

  thread(id: number): ThreadView {
    const row = this.store.getThread(id);
    const view = row ? this.threadViews([row], { includeDrafts: true })[0] : undefined;
    if (!view) throw new HttpError(404, `no thread ${id}`, 'unknown_thread');
    return view;
  }

  private reviewView(review: ReviewRow): ReviewView {
    const comments = this.store.commentsInReview(review.id);
    return {
      ...review,
      thread_ids: [...new Set(comments.map((c) => c.thread_id))],
      comment_count: comments.length,
    };
  }

  reviews(): ReviewView[] {
    return this.store.listReviews().map((r) => this.reviewView(r));
  }

  review(id: number): ReviewView {
    const review = this.store.getReview(id);
    if (!review) throw new HttpError(404, `no review ${id}`, 'unknown_review');
    return this.reviewView(review);
  }

  /** The user's unsubmitted review, or null if they have not started one. */
  draft(): ReviewView | null {
    const review = this.store.getDraftReview();
    return review ? this.reviewView(review) : null;
  }

  // ------------------------------------------------------------------ user: threads and drafts

  async createThread(input: NewThreadInput): Promise<ThreadView> {
    requireBody(input.body);
    const fromTree = await this.repo.resolveTree(assertOid(input.from_tree, 'tree id'));
    const toTree = await this.repo.resolveTree(assertOid(input.to_tree, 'tree id'));
    const entry = await this.repo.entryAt(input.side === 'new' ? toTree : fromTree, input.path);
    if (!entry || entry.type !== 'blob') {
      throw new HttpError(422, `${input.path} is not a file on the ${input.side} side of this diff`, 'no_such_file');
    }

    const start = input.start_line ?? null;
    const end = input.end_line ?? start;
    let anchorText = '';
    if (start !== null) {
      const content = await this.repo.readBlob(entry.oid);
      const lines = splitLines(content);
      if (!Number.isInteger(start) || !Number.isInteger(end) || end === null || start < 1 || end < start || end > lines.length) {
        throw new HttpError(422, `lines ${start}-${end} are outside ${input.path} (${lines.length} lines)`, 'invalid_range');
      }
      anchorText = lines.slice(start - 1, end).join('\n');
    }

    // Pin both sides so the diff this comment was written against can always be shown again.
    await this.pinTree(fromTree, 'anchor');
    await this.pinTree(toTree, 'anchor');

    const threadId = this.store.tx(() => {
      const review = this.store.getOrCreateDraftReview();
      const thread = this.store.insertThread({
        path: input.path, side: input.side, start_line: start, end_line: end,
        blob: entry.oid, from_tree: fromTree, to_tree: toTree, anchor_text: anchorText,
      });
      this.store.insertComment({ thread_id: thread.id, review_id: review.id, author: 'user', body: input.body, draft: true });
      return thread.id;
    });
    this.bus.emit({ type: 'draft.changed' });
    return this.thread(threadId);
  }

  replyAsUser(threadId: number, body: string): ThreadView {
    requireBody(body);
    this.store.tx(() => {
      if (!this.store.getThread(threadId)) throw new HttpError(404, `no thread ${threadId}`, 'unknown_thread');
      const review = this.store.getOrCreateDraftReview();
      this.store.insertComment({ thread_id: threadId, review_id: review.id, author: 'user', body, draft: true });
    });
    this.bus.emit({ type: 'draft.changed' });
    return this.thread(threadId);
  }

  private draftComment(commentId: number): CommentRow {
    const comment = this.store.getComment(commentId);
    if (!comment) throw new HttpError(404, `no comment ${commentId}`, 'unknown_comment');
    if (!comment.draft) throw new HttpError(409, 'only draft comments can be changed', 'not_a_draft');
    return comment;
  }

  editDraft(commentId: number, body: string): ThreadView {
    requireBody(body);
    const comment = this.store.tx(() => {
      const c = this.draftComment(commentId);
      this.store.updateCommentBody(commentId, body);
      return c;
    });
    this.bus.emit({ type: 'draft.changed' });
    return this.thread(comment.thread_id);
  }

  /** Delete a draft. A thread left with no comments is deleted with it. */
  deleteDraft(commentId: number): { thread_deleted: boolean } {
    const threadDeleted = this.store.tx(() => {
      const c = this.draftComment(commentId);
      this.store.deleteComment(commentId);
      if (this.store.countComments(c.thread_id) === 0) {
        this.store.deleteThread(c.thread_id);
        return true;
      }
      return false;
    });
    this.bus.emit({ type: 'draft.changed' });
    return { thread_deleted: threadDeleted };
  }

  setDraftBody(body: string): ReviewView {
    if (body.length > MAX_BODY) throw new HttpError(413, `body exceeds ${MAX_BODY} characters`, 'body_too_large');
    const review = this.store.tx(() => {
      const r = this.store.getOrCreateDraftReview();
      this.store.setDraftBody(r.id, body);
      return r;
    });
    this.bus.emit({ type: 'draft.changed' });
    return this.review(review.id);
  }

  resolveThread(id: number): ThreadView {
    const thread = this.thread(id);
    if (!thread.published) throw new HttpError(409, 'a thread must be submitted before it can be resolved', 'unpublished_thread');
    if (this.store.setThreadStatus(id, 'resolved')) this.bus.emit({ type: 'thread.resolved', thread_id: id });
    return this.thread(id);
  }

  async unresolveThread(id: number): Promise<ThreadView> {
    this.thread(id);
    const row = this.store.getThread(id)!;
    if (this.store.setThreadStatus(id, 'open')) this.bus.emit({ type: 'thread.unresolved', thread_id: id });
    if (row.archived_at) await this.repinThread(row);
    return this.thread(id);
  }

  /**
   * Archiving released a thread's snapshots. When it becomes active again, pin them back if git
   * still has them; if gc already took them, the thread still works and is anchored as best it can.
   */
  private async repinThread(row: ThreadRow): Promise<void> {
    for (const tree of new Set([row.from_tree, row.to_tree])) {
      if ((await this.repo.objectType(tree)) === 'tree') await this.pinTree(tree, 'anchor');
    }
  }

  /**
   * Publish the draft as one review and ring Claude's doorbell. Threads the user replied
   * to are reopened if resolved, and lose any "needs decision" flag, since the reply is
   * the decision.
   */
  async submitReview(body?: string): Promise<ReviewView> {
    if (body !== undefined && body.length > MAX_BODY) {
      throw new HttpError(413, `body exceeds ${MAX_BODY} characters`, 'body_too_large');
    }
    const pending = this.store.getDraftReview();
    const finalBody = body ?? pending?.body ?? '';
    if (!pending && finalBody.trim() === '') throw new HttpError(409, 'there is nothing to submit', 'empty_review');

    const tree = await this.snapshot('review_submitted');
    // Threads this submission reopens from the archive need their snapshots pinned again.
    const unarchiving = pending
      ? [...new Set(this.store.commentsInReview(pending.id).filter((c) => c.draft).map((c) => c.thread_id))]
          .map((id) => this.store.getThread(id))
          .filter((t): t is ThreadRow => t !== null && t.archived_at !== null)
      : [];

    const { reviewId, threadIds } = this.store.tx(() => {
      const draft = this.store.getDraftReview() ?? this.store.getOrCreateDraftReview();
      if (this.store.countDrafts(draft.id) === 0 && finalBody.trim() === '') {
        throw new HttpError(409, 'there is nothing to submit', 'empty_review');
      }
      const touched = this.store.publishDrafts(draft.id);
      for (const id of touched) {
        this.store.setThreadStatus(id, 'open');
        this.store.setNeedsDecision(id, false);
      }
      this.store.markSubmitted(draft.id, finalBody, tree);
      return { reviewId: draft.id, threadIds: touched };
    });

    for (const t of unarchiving) await this.repinThread(t);
    this.bus.emit(
      {
        type: 'review.submitted',
        review_id: reviewId,
        thread_count: threadIds.length,
        hint: agentHint([reviewId]),
      },
      ['ui', 'agent'],
    );
    return this.review(reviewId);
  }

  // ------------------------------------------------------------------ agent sessions

  agentConnected(session: string): void {
    this.liveAgents.set(session, (this.liveAgents.get(session) ?? 0) + 1);
    this.store.registerListener(session);
    this.bus.emit({ type: 'agents.changed', listening: this.listeningCount() });
  }

  agentDisconnected(session: string): void {
    const n = (this.liveAgents.get(session) ?? 0) - 1;
    if (n > 0) this.liveAgents.set(session, n);
    else this.liveAgents.delete(session);
    this.bus.emit({ type: 'agents.changed', listening: this.listeningCount() });
  }

  /** Claude sessions whose monitor is connected right now, so a submitted review will wake one. */
  listeningCount(): number {
    return this.liveAgents.size;
  }

  isAgentLive(session: string): boolean {
    return this.liveAgents.has(session);
  }

  /** A session asks to be woken for reviews. */
  listen(session: string): ListenResult {
    this.store.registerListener(assertSession(session));
    return { pending: this.pendingReviews().map((r) => r.id) };
  }

  /**
   * Take a review for a session. Refused while another session that is still listening holds
   * it; a review held by a session that went away is free to take over.
   */
  private claim(review: ReviewRow, session: string | undefined): void {
    if (!session) return;
    assertSession(session);
    const holder = review.agent_session;
    if (holder && holder !== session && review.status === 'in_progress' && this.isAgentLive(holder)) {
      throw new HttpError(409, `review ${review.id} is being handled by another Claude session`, 'claimed_elsewhere');
    }
    if (holder !== session) this.store.claimReview(review.id, session);
  }

  hookStatus(session: string): HookStatus {
    assertSession(session);
    const listener = this.store.isListener(session);
    if (!listener) return { listener, in_progress: [], waiting: [] };
    const active = this.store.listReviews(['submitted', 'in_progress']);
    const mine = active.filter((r) => r.status === 'in_progress' && r.agent_session === session);
    const waiting = active.filter(
      (r) => r.status === 'submitted' || (r.agent_session !== session && (!r.agent_session || !this.isAgentLive(r.agent_session))),
    );
    return {
      listener,
      in_progress: mine.map((r) => ({
        review_id: r.id,
        unanswered: this.unansweredThreads(r.id).map((t) => ({ thread_id: t.id, path: t.path, start_line: t.start_line, end_line: t.end_line })),
      })),
      waiting: waiting.filter((r) => !mine.includes(r)).map((r) => r.id),
    };
  }

  // ------------------------------------------------------------------ agent

  /** Reviews Claude still has to address, oldest first. */
  pendingReviews(): ReviewView[] {
    return this.store.listReviews(['submitted', 'in_progress']).map((r) => this.reviewView(r));
  }

  /** Threads in a review that still lack a reply from Claude after the user's latest comment in it. */
  unansweredThreads(reviewId: number): ThreadRow[] {
    const threads = this.store.threadsInReview(reviewId).filter((t) => t.status === 'open');
    const comments = this.store.commentsForThreads(threads.map((t) => t.id)).filter((c) => !c.draft);
    return threads.filter((t) => {
      const mine = comments.filter((c) => c.thread_id === t.id);
      const lastAsk = Math.max(0, ...mine.filter((c) => c.author === 'user' && c.review_id === reviewId).map((c) => c.id));
      return !mine.some((c) => c.author === 'claude' && c.id > lastAsk);
    });
  }

  /** Everything Claude needs to address a review. Fetching it marks the review as in progress. */
  async reviewForAgent(reviewId: number, session?: string): Promise<AgentReview> {
    const review = this.store.getReview(reviewId);
    if (!review || review.status === 'draft') throw new HttpError(404, `no submitted review ${reviewId}`, 'unknown_review');
    this.claim(review, session);
    if (this.store.markStarted(reviewId)) this.bus.emit({ type: 'review.started', review_id: reviewId });

    const threads = this.store.threadsInReview(reviewId);
    const unanswered = new Set(this.unansweredThreads(reviewId).map((t) => t.id));
    const comments = this.store.commentsForThreads(threads.map((t) => t.id)).filter((c) => !c.draft);
    const live = await this.liveTree();

    const result: AgentThread[] = [];
    for (const t of threads) {
      result.push({
        id: t.id, path: t.path, side: t.side, start_line: t.start_line, end_line: t.end_line,
        anchor_text: t.anchor_text, status: t.status, needs_decision: t.needs_decision,
        awaiting_reply: unanswered.has(t.id),
        // Where the commented code is in the working tree now.
        anchor: await this.anchorFor(t, { from_tree: t.from_tree, to_tree: live }),
        comments: comments
          .filter((c) => c.thread_id === t.id)
          .map((c) => ({
            id: c.id, author: c.author, body: c.body, created_at: c.created_at, in_this_review: c.review_id === reviewId,
            suggestion: hasSuggestion(c.body), applied: c.applied_at !== null,
          })),
      });
    }
    const fresh = this.store.getReview(reviewId)!;
    return {
      id: fresh.id, status: fresh.status, body: fresh.body, submitted_at: fresh.submitted_at, threads: result,
      commit: this.preferences().commit_each_review,
    };
  }

  /** Claude's reply, published immediately so the UI shows progress while it works. */
  async agentReply(threadId: number, body: string, needsDecision = false, session?: string): Promise<ThreadView> {
    requireBody(body);
    const thread = this.store.getThread(threadId);
    if (!thread) throw new HttpError(404, `no thread ${threadId}`, 'unknown_thread');
    if (thread.status === 'resolved') throw new HttpError(409, `thread ${threadId} is resolved`, 'thread_resolved');

    const comment = this.store.tx(() => {
      // Attribute the reply to the newest submitted review that asked something on this thread.
      const asks = this.store
        .commentsForThreads([threadId])
        .filter((c) => c.author === 'user' && !c.draft)
        .map((c) => c.review_id);
      const reviewId = asks.at(-1);
      if (reviewId === undefined) throw new HttpError(409, `thread ${threadId} has no submitted comment to reply to`, 'unpublished_thread');
      this.claim(this.store.getReview(reviewId)!, session);
      this.store.setNeedsDecision(threadId, needsDecision);
      // A reply proves Claude has picked the review up, even if it never fetched it as a whole.
      const started = this.store.markStarted(reviewId);
      return { ...this.store.insertComment({ thread_id: threadId, review_id: reviewId, author: 'claude', body, draft: false }), started };
    });

    if (comment.started) this.bus.emit({ type: 'review.started', review_id: comment.review_id });
    this.bus.emit({ type: 'thread.replied', thread_id: threadId, review_id: comment.review_id, comment_id: comment.id, needs_decision: needsDecision });
    await this.liveTree(); // Claude has probably just edited files; let the UI know promptly.
    return this.thread(threadId);
  }

  /** Close out a review. Refuses while any thread in it still lacks a reply from Claude. */
  async completeReview(reviewId: number, summary: string): Promise<ReviewView> {
    requireBody(summary, 'summary');
    const review = this.store.getReview(reviewId);
    if (!review || review.status === 'draft') throw new HttpError(404, `no submitted review ${reviewId}`, 'unknown_review');
    if (review.status === 'addressed') throw new HttpError(409, `review ${reviewId} is already complete`, 'already_complete');

    const unanswered = this.unansweredThreads(reviewId);
    if (unanswered.length > 0) {
      throw new HttpError(
        409,
        `review ${reviewId} has ${unanswered.length} thread(s) without a reply: ${unanswered.map((t) => `#${t.id} ${t.path}`).join(', ')}`,
        'unanswered_threads',
        { thread_ids: unanswered.map((t) => t.id) },
      );
    }

    const tree = await this.snapshot('review_completed');
    this.store.markAddressed(reviewId, summary, tree);
    this.bus.emit({ type: 'review.completed', review_id: reviewId });
    return this.review(reviewId);
  }

  // ------------------------------------------------------------------ marks

  fileMarks() {
    return this.store.listFileMarks();
  }

  setFileMark(path: string, blob: string, viewed: boolean): void {
    assertOid(blob, 'blob id');
    if (viewed) this.store.addFileMark(path, blob);
    else this.store.removeFileMark(path, blob);
    this.bus.emit({ type: 'marks.changed' });
  }

  /** Mark many files viewed or not at once, such as a whole folder, with one event. */
  setFileMarks(files: ReadonlyArray<{ path: string; blob: string }>, viewed: boolean): void {
    for (const f of files) assertOid(f.blob, 'blob id');
    this.store.tx(() => {
      for (const f of files) {
        if (viewed) this.store.addFileMark(f.path, f.blob);
        else this.store.removeFileMark(f.path, f.blob);
      }
    });
    this.bus.emit({ type: 'marks.changed' });
  }

  sectionMarks(path?: string) {
    return this.store.listSectionMarks(path);
  }

  /** Section marks with where each one is in a diff: a mark holds only while its lines are unchanged. */
  async sectionMarksIn(target: { from_tree: string; to_tree: string }): Promise<Array<SectionMarkRow & { anchor: Anchor }>> {
    assertOid(target.from_tree, 'tree id');
    assertOid(target.to_tree, 'tree id');
    return Promise.all(
      this.store.listSectionMarks().map(async (m) => {
        const blob = m.side === 'new' ? m.to_blob : m.from_blob;
        const anchor: Anchor = blob
          ? await this.anchorRange({ path: m.path, side: m.side, blob, start: m.start_line, end: m.end_line }, target)
          : { state: 'gone', path: m.path, start_line: null, end_line: null };
        return { ...m, anchor };
      }),
    );
  }

  async addSectionMark(input: {
    path: string; from_blob: string | null; to_blob: string | null; side: Side; start_line: number; end_line: number;
  }) {
    const blob = input.side === 'new' ? input.to_blob : input.from_blob;
    if (!blob) throw new HttpError(422, `the ${input.side} side of ${input.path} does not exist`, 'no_such_side');
    if (input.from_blob) assertOid(input.from_blob, 'blob id');
    if (input.to_blob) assertOid(input.to_blob, 'blob id');
    const range = await this.lines(blob, input.start_line, input.end_line);
    if (range.end !== input.end_line) {
      throw new HttpError(422, `lines ${input.start_line}-${input.end_line} are outside the file (${range.total} lines)`, 'invalid_range');
    }
    const contentHash = createHash('sha256').update(range.lines.join('\n')).digest('hex');
    await this.repo.pinBlob(blob); // the mark must outlive gc to keep being re-anchored
    const mark = this.store.addSectionMark({ ...input, content_hash: contentHash });
    this.bus.emit({ type: 'marks.changed' });
    return mark;
  }

  removeSectionMark(id: number): void {
    if (!this.store.removeSectionMark(id)) throw new HttpError(404, `no section mark ${id}`, 'unknown_mark');
    this.bus.emit({ type: 'marks.changed' });
  }

  // ------------------------------------------------------------------ archive and prune

  /** Archive resolved conversations and finished reviews, then release what they pinned. */
  async archiveResolved(): Promise<{ threads: number; reviews: number; unpinned: number }> {
    const archived = this.store.archiveResolved();
    const { unpinned } = await this.prune();
    this.bus.emit({ type: 'archive.changed' });
    return { ...archived, unpinned };
  }

  /**
   * The user abandons the review in whatever state it is in, to start a new one. Everything is
   * archived rather than deleted, except comments Claude never saw, and listening Claude
   * sessions are told to drop any review they were working on.
   */
  async resetReviews(): Promise<{ threads: number; reviews: number; drafts: number; unpinned: number }> {
    const reset = this.store.resetReviews('Discarded: the user reset the review before Claude finished it.');
    const { unpinned } = await this.prune();
    this.bus.emit({ type: 'archive.changed' });
    this.bus.emit({ type: 'draft.changed' });
    this.bus.emit({ type: 'marks.changed' });
    this.bus.emit({ type: 'session.reset' }, ['ui', 'agent']);
    return { ...reset, unpinned };
  }

  /**
   * The user is done: every conversation resolved, nothing pending. Archive what is finished and
   * tell listening Claude sessions they can stop. Refuses while anything is still open.
   */
  preferences(): Preferences {
    const stored = JSON.parse(this.store.getSetting('preferences') ?? '{}') as Partial<Preferences>;
    return { commit_each_review: stored.commit_each_review === true };
  }

  setPreferences(change: Partial<Preferences>): Preferences {
    const next = { ...this.preferences(), ...change };
    this.store.setSetting('preferences', JSON.stringify(next));
    this.bus.emit({ type: 'preferences.changed' });
    return next;
  }

  async finishSession(opts: FinishOptions = {}): Promise<{ threads: number; reviews: number; unpinned: number }> {
    const open = this.store.listThreads({ status: 'open' }).length;
    const pending = this.draft()?.comment_count ?? 0;
    const active = this.store.listReviews(['submitted', 'in_progress']).length > 0;
    if (open || pending || active) {
      throw new HttpError(409, 'resolve every conversation and let Claude finish before ending the session', 'not_finished');
    }
    const archived = await this.archiveResolved();
    // Claude does any committing and pushing the user asked for, then stops listening.
    // The user's own instructions replace the commit and push options.
    const message = opts.message?.trim();
    this.bus.emit(message
      ? { type: 'session.finished', commit: false, push: false, message }
      : { type: 'session.finished', commit: opts.commit === true, push: opts.push === true }, ['ui', 'agent']);
    return archived;
  }

  /**
   * Unpin snapshot trees and blobs nothing live refers to, so `git gc` can reclaim them. Only
   * pins under refs/postil/ are touched.
   */
  async prune(): Promise<{ unpinned: number }> {
    const trees = this.store.treesInUse();
    const blobs = this.store.blobsInUse();
    let unpinned = 0;
    for (const tree of await this.repo.pinnedTrees()) {
      if (trees.has(tree)) continue;
      await this.repo.unpin(tree);
      this.store.deleteSnapshot(tree);
      unpinned++;
    }
    for (const blob of await this.repo.pinnedBlobs()) {
      if (blobs.has(blob)) continue;
      await this.repo.unpinBlob(blob);
      unpinned++;
    }
    return { unpinned };
  }

  archivedThreads(): ThreadView[] {
    return this.threadViews(this.store.listThreads({ archived: true }), { includeDrafts: false });
  }

  // ------------------------------------------------------------------ ui state

  private checkUiKey(key: string): void {
    if (!UI_KEY.test(key)) throw new HttpError(400, 'ui state keys are 1-128 characters of [A-Za-z0-9_.:-]', 'invalid_key');
  }

  uiState(key: string): unknown {
    this.checkUiKey(key);
    return this.store.getUiState(key);
  }

  setUiState(key: string, value: unknown): void {
    this.checkUiKey(key);
    const size = JSON.stringify(value)?.length ?? 0;
    if (size > MAX_UI_STATE) throw new HttpError(413, `ui state values are limited to ${MAX_UI_STATE} bytes`, 'state_too_large');
    this.store.setUiState(key, value);
  }

  deleteUiState(key: string): void {
    this.checkUiKey(key);
    this.store.deleteUiState(key);
  }

  uiStateKeys(): string[] {
    return this.store.listUiStateKeys();
  }
}
