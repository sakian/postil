/**
 * Shapes exchanged over the HTTP API. Pure types with no runtime imports, so the browser
 * UI can import them directly and stay in lockstep with the server.
 */
import type { Author, ReviewRow, Side } from '../db/types.ts';
import type { Anchor } from './anchors.ts';
import type { Commit, FileChange, Hunk } from '../git/types.ts';

export type { Author, ReviewRow, ReviewStatus, SectionMarkRow, FileMarkRow, Side, ThreadStatus } from '../db/types.ts';
export type { Commit, DiffLine, FileChange, FileKind, FileStatus, Hunk, LineKind } from '../git/types.ts';
export type { Anchor, AnchorState } from './anchors.ts';


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
  /** When this comment's suggestion was written into the working tree. */
  applied_at: string | null;
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
  /** Where the thread sits in the diff it was requested for; absent when no diff was given. */
  anchor?: Anchor;
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
  /** Where the commented lines are in the working tree now. */
  anchor: Anchor;
  comments: Array<{
    id: number;
    author: Author;
    body: string;
    created_at: string;
    in_this_review: boolean;
    /** The comment contains a ```suggestion block. */
    suggestion: boolean;
    applied: boolean;
  }>;
}

export interface AgentReview {
  id: number;
  status: ReviewRow['status'];
  body: string;
  submitted_at: string | null;
  threads: AgentThread[];
}

export interface CommitsInfo {
  base: BaseInfo;
  head: string | null;
  branch: string | null;
  commits: Commit[];
  uncommitted: boolean;
}

export interface Health {
  ok: true;
  service: 'postil';
  version: string;
  root: string;
  pid: number;
  /** Claude sessions listening for reviews right now. */
  listening: number;
}

export interface ResolvedDiff extends ResolvedScope {
  files: FileChange[];
  /** Paths whose content on the "to" side changed after the latest submitted review. */
  since_review: { review_id: number; changed: string[] } | null;
}

export interface AppliedSuggestion {
  comment_id: number;
  thread_id: number;
  path: string;
  /** The lines the suggestion now occupies. */
  start_line: number;
  end_line: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** What a Claude Code hook needs to decide whether to act in a given session. */
export interface HookStatus {
  /** The session has asked to be woken for reviews. Hooks stay silent otherwise. */
  listener: boolean;
  /** Reviews this session picked up and has not completed. */
  in_progress: Array<{
    review_id: number;
    unanswered: Array<{ thread_id: number; path: string; start_line: number | null; end_line: number | null }>;
  }>;
  /** Submitted reviews that no listening session is working on. */
  waiting: number[];
}

export interface ListenResult {
  /** Reviews waiting for Claude right now. */
  pending: number[];
}

/** A "done" mark with its place in the diff being viewed. Valid while its state is current or moved. */
export type AnchoredSectionMark = import('../db/types.ts').SectionMarkRow & { anchor: Anchor };
