export type ReviewStatus = 'draft' | 'submitted' | 'in_progress' | 'addressed';
export type ThreadStatus = 'open' | 'resolved';
export type Author = 'user' | 'claude';
export type Side = 'old' | 'new';

export interface SnapshotRow {
  id: number;
  tree: string;
  head: string | null;
  reason: string;
  created_at: string;
}

export interface ReviewRow {
  id: number;
  status: ReviewStatus;
  body: string;
  summary: string | null;
  created_at: string;
  submitted_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  submit_tree: string | null;
  complete_tree: string | null;
}

export interface ThreadRow {
  id: number;
  path: string;
  side: Side;
  start_line: number | null;
  end_line: number | null;
  blob: string;
  from_tree: string;
  to_tree: string;
  anchor_text: string;
  status: ThreadStatus;
  needs_decision: boolean;
  created_at: string;
  resolved_at: string | null;
}

export interface CommentRow {
  id: number;
  thread_id: number;
  review_id: number;
  author: Author;
  body: string;
  draft: boolean;
  created_at: string;
  updated_at: string;
}

export interface FileMarkRow {
  path: string;
  blob: string;
  created_at: string;
}

export interface SectionMarkRow {
  id: number;
  path: string;
  from_blob: string | null;
  to_blob: string | null;
  side: Side;
  start_line: number;
  end_line: number;
  content_hash: string;
  created_at: string;
}
