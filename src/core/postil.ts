import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Store } from '../db/store.ts';
import type { Author, CommentRow, ReviewRow, Side, ThreadRow } from '../db/types.ts';
import { splitLines } from '../git/parse.ts';
import { assertOid, Repo } from '../git/repo.ts';
import type { Commit, FileChange, Hunk } from '../git/types.ts';
import { EventBus } from './events.ts';
import { HttpError } from './util.ts';

// ---------------------------------------------------------------------------- public shapes

export type BaseConfig =
  | { mode: 'merge-base'; target: string }
  | { mode: 'commit'; commit: string | null };

export interface BaseInfo {
  config: BaseConfig;
  /** The commit the base resolves to right now; null means the empty tree. */
  commit: string | null;
  tree: string;
  label: string;
  /** Set when the configured base could not be resolved and the empty tree was used instead. */
  warning?: string;
}

export type Scope =
  | { kind: 'all' }
  | { kind: 'uncommitted' }
  | { kind: 'since_review'; review_id?: number }
  | { kind: 'commits'; from: string; to: string }
  | { kind: 'trees'; from: string; to: string };

/** One side of a resolved diff. Trees are immutable, so a view pinned to them never shifts under the user. */
export interface Endpoint {
  tree: string;
  commit: string | null;
  label: string;
  /** True when this is the working tree as of resolution time. */
  live: boolean;
}

export interface ResolvedScope {
  scope: Scope;
  from: Endpoint;
  to: Endpoint;
}

export interface FileDiff {
  old_blob: string | null;
  new_blob: string | null;
  binary: boolean;
  too_large: boolean;
  old_lines: number | null;
  new_lines: number | null;
  hunks: Hunk[];
}

export interface CommentView {
  id: number;
  review_id: number;
  author: Author;
  body: string;
  draft: boolean;
  created_at: string;
  updated_at: string;
}

export interface ThreadView {
  id: number;
  path: string;
  side: Side;
  start_line: number | null;
  end_line: number | null;
  blob: string;
  from_tree: string;
  to_tree: string;
  anchor_text: string;
  status: 'open' | 'resolved';
  needs_decision: boolean;
  /** False while every comment is still a draft. */
  published: boolean;
  /** Whose turn it is. Null when resolved or unpublished. */
  awaiting: Author | null;
  created_at: string;
  resolved_at: string | null;
  comments: CommentView[];
}

export interface ReviewView extends ReviewRow {
  thread_ids: number[];
  comment_count: number;
}

export interface NewThreadInput {
  from_tree: string;
  to_tree: string;
  path: string;
  side: Side;
  start_line?: number | null;
  end_line?: number | null;
  body: string;
}

export interface AgentThread {
  id: number;
  path: string;
  side: Side;
  start_line: number | null;
  end_line: number | null;
  anchor_text: string;
  status: 'open' | 'resolved';
  needs_decision: boolean;
  /** True when this review still needs a reply from Claude on this thread. */
  awaiting_reply: boolean;
  /** True when the file on disk differs from the version the comment was written on. */
  file_changed_since_comment: boolean;
  file_exists: boolean;
  comments: Array<{ id: number; author: Author; body: string; created_at: string; in_this_review: boolean }>;
}

export interface AgentReview {
  id: number;
  status: ReviewRow['status'];
  body: string;
  submitted_at: string | null;
  threads: AgentThread[];
}

// ---------------------------------------------------------------------------- limits

const MAX_BODY = 64 * 1024;
const MAX_DIFF_BLOB = 4 * 1024 * 1024;
const MAX_LINES_PER_REQUEST = 10_000;
const MAX_UI_STATE = 256 * 1024;
const UI_KEY = /^[\w.:-]{1,128}$/;

function requireBody(body: string, what = 'body'): string {
  if (body.trim() === '') throw new HttpError(400, `${what} must not be empty`, 'empty_body');
  if (body.length > MAX_BODY) throw new HttpError(413, `${what} exceeds ${MAX_BODY} characters`, 'body_too_large');
  return body;
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
   * On a feature branch, the base follows the merge base with the default branch, as a
   * pull request would. Anywhere else, it is HEAD when postil first ran here, so "all
   * changes" means everything since review began.
   */
  private async defaultBase(): Promise<BaseConfig> {
    const [branch, target, head] = await Promise.all([
      this.repo.currentBranch(), this.repo.defaultBranch(), this.repo.head(),
    ]);
    if (branch && target && branch !== target && head) return { mode: 'merge-base', target };
    return { mode: 'commit', commit: head };
  }

  private async ensureBase(): Promise<void> {
    if (this.store.getSetting('base') === null) {
      this.store.setSetting('base', JSON.stringify(await this.defaultBase()));
    }
  }

  private baseConfig(): BaseConfig {
    return JSON.parse(this.store.getSetting('base') ?? '{"mode":"commit","commit":null}') as BaseConfig;
  }

  async base(): Promise<BaseInfo> {
    const config = this.baseConfig();
    const emptyTree = await this.repo.emptyTree();
    if (config.mode === 'commit') {
      if (config.commit === null) return { config, commit: null, tree: emptyTree, label: 'empty tree' };
      return { config, commit: config.commit, tree: await this.repo.resolveTree(config.commit), label: short(config.commit) };
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

  async setBase(rev: string): Promise<BaseInfo> {
    const commit = await this.repo.resolveCommit(rev);
    this.store.setSetting('base', JSON.stringify({ mode: 'commit', commit } satisfies BaseConfig));
    this.bus.emit({ type: 'base.changed' });
    return this.base();
  }

  async resetBase(): Promise<BaseInfo> {
    this.store.setSetting('base', JSON.stringify(await this.defaultBase()));
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

  /** Pin the current working tree and return its id. */
  async snapshot(reason: string): Promise<string> {
    const tree = await this.liveTree();
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

  async commits(): Promise<{ base: BaseInfo; head: string | null; branch: string | null; commits: Commit[]; uncommitted: boolean }> {
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
    const sizes = await Promise.all([oldBlob, newBlob].map((b) => (b ? this.repo.blobSize(b) : 0)));
    const tooLarge = !opts.force && sizes.some((s) => s > MAX_DIFF_BLOB);
    const info = async (b: string | null) => (b && !tooLarge ? (await this.repo.blobInfo(b)).lines : null);
    const [oldLines, newLines] = await Promise.all([info(oldBlob), info(newBlob)]);
    if (tooLarge) {
      return { old_blob: oldBlob, new_blob: newBlob, binary: false, too_large: true, old_lines: null, new_lines: null, hunks: [] };
    }
    const parsed = await this.repo.diffBlobs(oldBlob, newBlob, opts);
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

  unresolveThread(id: number): ThreadView {
    this.thread(id);
    if (this.store.setThreadStatus(id, 'open')) this.bus.emit({ type: 'thread.unresolved', thread_id: id });
    return this.thread(id);
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

    this.bus.emit(
      {
        type: 'review.submitted',
        review_id: reviewId,
        thread_count: threadIds.length,
        hint: `postil review #${reviewId} is waiting with ${threadIds.length} thread(s). Fetch it with get_review.`,
      },
      ['ui', 'agent'],
    );
    return this.review(reviewId);
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
  async reviewForAgent(reviewId: number): Promise<AgentReview> {
    const review = this.store.getReview(reviewId);
    if (!review || review.status === 'draft') throw new HttpError(404, `no submitted review ${reviewId}`, 'unknown_review');
    if (this.store.markStarted(reviewId)) this.bus.emit({ type: 'review.started', review_id: reviewId });

    const threads = this.store.threadsInReview(reviewId);
    const unanswered = new Set(this.unansweredThreads(reviewId).map((t) => t.id));
    const comments = this.store.commentsForThreads(threads.map((t) => t.id)).filter((c) => !c.draft);
    const live = await this.liveTree();

    const result: AgentThread[] = [];
    for (const t of threads) {
      const reference = t.side === 'new' ? t.blob : ((await this.repo.entryAt(t.to_tree, t.path))?.oid ?? null);
      const current = (await this.repo.entryAt(live, t.path))?.oid ?? null;
      result.push({
        id: t.id, path: t.path, side: t.side, start_line: t.start_line, end_line: t.end_line,
        anchor_text: t.anchor_text, status: t.status, needs_decision: t.needs_decision,
        awaiting_reply: unanswered.has(t.id),
        file_changed_since_comment: reference !== current,
        file_exists: current !== null,
        comments: comments
          .filter((c) => c.thread_id === t.id)
          .map((c) => ({ id: c.id, author: c.author, body: c.body, created_at: c.created_at, in_this_review: c.review_id === reviewId })),
      });
    }
    const fresh = this.store.getReview(reviewId)!;
    return { id: fresh.id, status: fresh.status, body: fresh.body, submitted_at: fresh.submitted_at, threads: result };
  }

  /** Claude's reply, published immediately so the UI shows progress while it works. */
  async agentReply(threadId: number, body: string, needsDecision = false): Promise<ThreadView> {
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
      this.store.setNeedsDecision(threadId, needsDecision);
      return this.store.insertComment({ thread_id: threadId, review_id: reviewId, author: 'claude', body, draft: false });
    });

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

  sectionMarks(path?: string) {
    return this.store.listSectionMarks(path);
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
    const mark = this.store.addSectionMark({ ...input, content_hash: contentHash });
    this.bus.emit({ type: 'marks.changed' });
    return mark;
  }

  removeSectionMark(id: number): void {
    if (!this.store.removeSectionMark(id)) throw new HttpError(404, `no section mark ${id}`, 'unknown_mark');
    this.bus.emit({ type: 'marks.changed' });
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
