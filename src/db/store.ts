import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { nowIso } from '../core/util.ts';
import { MIGRATIONS } from './schema.ts';
import type {
  Author, CommentRow, FileMarkRow, ReviewRow, ReviewStatus, SectionMarkRow, Side, SnapshotRow, ThreadRow, ThreadStatus,
} from './types.ts';

type Params = Record<string, SQLInputValue>;
type Row = Record<string, unknown>;

function toThread(r: Row): ThreadRow {
  return { ...(r as unknown as ThreadRow), needs_decision: r.needs_decision === 1 };
}

function toComment(r: Row): CommentRow {
  return { ...(r as unknown as CommentRow), draft: r.draft === 1 };
}

export interface NewThread {
  path: string;
  side: Side;
  start_line: number | null;
  end_line: number | null;
  blob: string;
  from_tree: string;
  to_tree: string;
  anchor_text: string;
}

export interface NewSectionMark {
  path: string;
  from_blob: string | null;
  to_blob: string | null;
  side: Side;
  start_line: number;
  end_line: number;
  content_hash: string;
}

/**
 * Synchronous SQLite access. Every method is a single statement or runs inside `tx`,
 * so callers compose them into atomic operations without worrying about interleaving:
 * nothing can run between the statements of a synchronous transaction in one process.
 */
export class Store {
  readonly db: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` atomically. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  private all(sql: string, params: Params = {}): Row[] {
    return this.db.prepare(sql).all(params) as Row[];
  }

  private one(sql: string, params: Params = {}): Row | undefined {
    return this.db.prepare(sql).get(params) as Row | undefined;
  }

  private run(sql: string, params: Params = {}): { changes: number; id: number } {
    const r = this.db.prepare(sql).run(params);
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  }

  private migrate(): void {
    const version = Number((this.one('PRAGMA user_version') ?? {}).user_version ?? 0);
    if (version > MIGRATIONS.length) {
      throw new Error(`database schema v${version} is newer than this postil (v${MIGRATIONS.length}); upgrade postil`);
    }
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  // ------------------------------------------------------------------ settings

  getSetting(key: string): string | null {
    return (this.one('SELECT value FROM setting WHERE key = :key', { key })?.value as string | undefined) ?? null;
  }

  setSetting(key: string, value: string): void {
    this.run('INSERT INTO setting (key, value) VALUES (:key, :value) ON CONFLICT (key) DO UPDATE SET value = :value', { key, value });
  }

  // ------------------------------------------------------------------ snapshots

  /** Record a pinned tree. Returns the existing row when the tree was recorded before. */
  upsertSnapshot(tree: string, head: string | null, reason: string): SnapshotRow {
    this.run(
      'INSERT INTO snapshot (tree, head, reason, created_at) VALUES (:tree, :head, :reason, :now) ON CONFLICT (tree) DO NOTHING',
      { tree, head, reason, now: nowIso() },
    );
    return this.one('SELECT * FROM snapshot WHERE tree = :tree', { tree }) as unknown as SnapshotRow;
  }

  listSnapshots(): SnapshotRow[] {
    return this.all('SELECT * FROM snapshot ORDER BY id') as unknown as SnapshotRow[];
  }

  // ------------------------------------------------------------------ reviews

  getReview(id: number): ReviewRow | null {
    return (this.one('SELECT * FROM review WHERE id = :id', { id }) as unknown as ReviewRow | undefined) ?? null;
  }

  getDraftReview(): ReviewRow | null {
    return (this.one("SELECT * FROM review WHERE status = 'draft'") as unknown as ReviewRow | undefined) ?? null;
  }

  getOrCreateDraftReview(): ReviewRow {
    return this.tx(() => {
      const existing = this.getDraftReview();
      if (existing) return existing;
      const { id } = this.run("INSERT INTO review (status, created_at) VALUES ('draft', :now)", { now: nowIso() });
      return this.getReview(id)!;
    });
  }

  listReviews(statuses?: readonly ReviewStatus[]): ReviewRow[] {
    if (!statuses) return this.all('SELECT * FROM review ORDER BY id') as unknown as ReviewRow[];
    const params: Params = {};
    const names = statuses.map((s, i) => {
      params[`s${i}`] = s;
      return `:s${i}`;
    });
    return this.all(`SELECT * FROM review WHERE status IN (${names.join(', ')}) ORDER BY id`, params) as unknown as ReviewRow[];
  }

  /** The most recent review that has been submitted, whatever its later status. */
  latestSubmittedReview(): ReviewRow | null {
    return (
      (this.one("SELECT * FROM review WHERE status != 'draft' ORDER BY submitted_at DESC, id DESC LIMIT 1") as unknown as
        | ReviewRow
        | undefined) ?? null
    );
  }

  markSubmitted(id: number, body: string, tree: string): void {
    this.run(
      "UPDATE review SET status = 'submitted', body = :body, submitted_at = :now, submit_tree = :tree WHERE id = :id AND status = 'draft'",
      { id, body, tree, now: nowIso() },
    );
  }

  markStarted(id: number): boolean {
    return this.run(
      "UPDATE review SET status = 'in_progress', started_at = :now WHERE id = :id AND status = 'submitted'",
      { id, now: nowIso() },
    ).changes === 1;
  }

  markAddressed(id: number, summary: string, tree: string): void {
    this.run(
      `UPDATE review SET status = 'addressed', summary = :summary, completed_at = :now, complete_tree = :tree,
         started_at = IFNULL(started_at, :now)
       WHERE id = :id AND status IN ('submitted', 'in_progress')`,
      { id, summary, tree, now: nowIso() },
    );
  }

  claimReview(id: number, session: string): void {
    this.run('UPDATE review SET agent_session = :session WHERE id = :id', { id, session });
  }

  setDraftBody(id: number, body: string): void {
    this.run("UPDATE review SET body = :body WHERE id = :id AND status = 'draft'", { id, body });
  }

  // ------------------------------------------------------------------ threads

  insertThread(t: NewThread): ThreadRow {
    const { id } = this.run(
      `INSERT INTO thread (path, side, start_line, end_line, blob, from_tree, to_tree, anchor_text, created_at)
       VALUES (:path, :side, :start_line, :end_line, :blob, :from_tree, :to_tree, :anchor_text, :now)`,
      { ...t, now: nowIso() },
    );
    return this.getThread(id)!;
  }

  getThread(id: number): ThreadRow | null {
    const r = this.one('SELECT * FROM thread WHERE id = :id', { id });
    return r ? toThread(r) : null;
  }

  /** Threads visible in the UI: those with a published comment, plus threads whose only comments are drafts. */
  listThreads(filter: { status?: ThreadStatus; path?: string } = {}): ThreadRow[] {
    const where: string[] = [];
    const params: Params = {};
    if (filter.status) {
      where.push('status = :status');
      params.status = filter.status;
    }
    if (filter.path) {
      where.push('path = :path');
      params.path = filter.path;
    }
    const sql = `SELECT * FROM thread ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY path, start_line, id`;
    return this.all(sql, params).map(toThread);
  }

  /** Threads with at least one published comment in the given review. */
  threadsInReview(reviewId: number): ThreadRow[] {
    return this.all(
      `SELECT * FROM thread WHERE id IN (SELECT thread_id FROM comment WHERE review_id = :reviewId AND draft = 0)
       ORDER BY path, start_line, id`,
      { reviewId },
    ).map(toThread);
  }

  setThreadStatus(id: number, status: ThreadStatus): boolean {
    return this.run(
      'UPDATE thread SET status = :status, resolved_at = CASE WHEN :status = \'resolved\' THEN :now ELSE NULL END WHERE id = :id AND status != :status',
      { id, status, now: nowIso() },
    ).changes === 1;
  }

  setNeedsDecision(id: number, value: boolean): void {
    this.run('UPDATE thread SET needs_decision = :v WHERE id = :id', { id, v: value ? 1 : 0 });
  }

  deleteThread(id: number): void {
    this.run('DELETE FROM thread WHERE id = :id', { id });
  }

  // ------------------------------------------------------------------ comments

  insertComment(c: { thread_id: number; review_id: number; author: Author; body: string; draft: boolean }): CommentRow {
    const now = nowIso();
    const { id } = this.run(
      `INSERT INTO comment (thread_id, review_id, author, body, draft, created_at, updated_at)
       VALUES (:thread_id, :review_id, :author, :body, :draft, :now, :now)`,
      { ...c, draft: c.draft ? 1 : 0, now },
    );
    return this.getComment(id)!;
  }

  getComment(id: number): CommentRow | null {
    const r = this.one('SELECT * FROM comment WHERE id = :id', { id });
    return r ? toComment(r) : null;
  }

  commentsForThreads(threadIds: readonly number[]): CommentRow[] {
    if (threadIds.length === 0) return [];
    const params: Params = {};
    const names = threadIds.map((id, i) => {
      params[`t${i}`] = id;
      return `:t${i}`;
    });
    return this.all(`SELECT * FROM comment WHERE thread_id IN (${names.join(', ')}) ORDER BY id`, params).map(toComment);
  }

  commentsInReview(reviewId: number): CommentRow[] {
    return this.all('SELECT * FROM comment WHERE review_id = :reviewId ORDER BY id', { reviewId }).map(toComment);
  }

  updateCommentBody(id: number, body: string): void {
    this.run('UPDATE comment SET body = :body, updated_at = :now WHERE id = :id', { id, body, now: nowIso() });
  }

  deleteComment(id: number): void {
    this.run('DELETE FROM comment WHERE id = :id', { id });
  }

  countComments(threadId: number): number {
    return Number(this.one('SELECT COUNT(*) AS n FROM comment WHERE thread_id = :threadId', { threadId })?.n ?? 0);
  }

  /** Publish every draft in a review. Returns the ids of threads that received a published comment. */
  publishDrafts(reviewId: number): number[] {
    const threadIds = this.all('SELECT DISTINCT thread_id FROM comment WHERE review_id = :reviewId AND draft = 1', { reviewId }).map(
      (r) => Number(r.thread_id),
    );
    this.run('UPDATE comment SET draft = 0, updated_at = :now WHERE review_id = :reviewId AND draft = 1', {
      reviewId,
      now: nowIso(),
    });
    return threadIds;
  }

  countDrafts(reviewId: number): number {
    return Number(this.one('SELECT COUNT(*) AS n FROM comment WHERE review_id = :reviewId AND draft = 1', { reviewId })?.n ?? 0);
  }

  // ------------------------------------------------------------------ marks

  addFileMark(path: string, blob: string): void {
    this.run('INSERT INTO file_mark (path, blob, created_at) VALUES (:path, :blob, :now) ON CONFLICT DO NOTHING', {
      path,
      blob,
      now: nowIso(),
    });
  }

  removeFileMark(path: string, blob: string): boolean {
    return this.run('DELETE FROM file_mark WHERE path = :path AND blob = :blob', { path, blob }).changes === 1;
  }

  listFileMarks(): FileMarkRow[] {
    return this.all('SELECT * FROM file_mark ORDER BY path') as unknown as FileMarkRow[];
  }

  addSectionMark(m: NewSectionMark): SectionMarkRow {
    this.run(
      `INSERT INTO section_mark (path, from_blob, to_blob, side, start_line, end_line, content_hash, created_at)
       VALUES (:path, :from_blob, :to_blob, :side, :start_line, :end_line, :content_hash, :now)
       ON CONFLICT DO NOTHING`,
      { ...m, now: nowIso() },
    );
    return this.one(
      `SELECT * FROM section_mark WHERE path = :path AND IFNULL(from_blob, '') = IFNULL(:from_blob, '')
         AND IFNULL(to_blob, '') = IFNULL(:to_blob, '') AND side = :side AND start_line = :start_line AND end_line = :end_line`,
      { path: m.path, from_blob: m.from_blob, to_blob: m.to_blob, side: m.side, start_line: m.start_line, end_line: m.end_line },
    ) as unknown as SectionMarkRow;
  }

  removeSectionMark(id: number): boolean {
    return this.run('DELETE FROM section_mark WHERE id = :id', { id }).changes === 1;
  }

  listSectionMarks(path?: string): SectionMarkRow[] {
    return (
      path
        ? this.all('SELECT * FROM section_mark WHERE path = :path ORDER BY start_line', { path })
        : this.all('SELECT * FROM section_mark ORDER BY path, start_line')
    ) as unknown as SectionMarkRow[];
  }

  // ------------------------------------------------------------------ listeners

  registerListener(sessionId: string): void {
    this.run(
      `INSERT INTO listener (session_id, registered_at, last_seen) VALUES (:sessionId, :now, :now)
       ON CONFLICT (session_id) DO UPDATE SET last_seen = :now`,
      { sessionId, now: nowIso() },
    );
  }

  isListener(sessionId: string): boolean {
    return this.one('SELECT 1 AS x FROM listener WHERE session_id = :sessionId', { sessionId }) !== undefined;
  }

  // ------------------------------------------------------------------ ui state

  getUiState(key: string): unknown {
    const r = this.one('SELECT value FROM ui_state WHERE key = :key', { key });
    return r ? JSON.parse(r.value as string) : null;
  }

  setUiState(key: string, value: unknown): void {
    this.run(
      `INSERT INTO ui_state (key, value, updated_at) VALUES (:key, :value, :now)
       ON CONFLICT (key) DO UPDATE SET value = :value, updated_at = :now`,
      { key, value: JSON.stringify(value), now: nowIso() },
    );
  }

  deleteUiState(key: string): boolean {
    return this.run('DELETE FROM ui_state WHERE key = :key', { key }).changes === 1;
  }

  listUiStateKeys(): string[] {
    return this.all('SELECT key FROM ui_state ORDER BY key').map((r) => r.key as string);
  }
}
