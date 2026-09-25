/**
 * Ordered migrations. Each runs once, inside a transaction, and bumps PRAGMA user_version.
 * Never edit a migration that has shipped; append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE setting (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Trees kept alive by a ref under refs/postil/<worktree>/trees/. One row per distinct tree.
  CREATE TABLE snapshot (
    id         INTEGER PRIMARY KEY,
    tree       TEXT NOT NULL UNIQUE,
    head       TEXT,
    reason     TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- A batch of comments. The user writes one draft at a time and submits it; Claude
  -- picks it up (in_progress), replies to its threads and completes it (addressed).
  CREATE TABLE review (
    id            INTEGER PRIMARY KEY,
    status        TEXT NOT NULL CHECK (status IN ('draft', 'submitted', 'in_progress', 'addressed')),
    body          TEXT NOT NULL DEFAULT '',
    summary       TEXT,
    created_at    TEXT NOT NULL,
    submitted_at  TEXT,
    started_at    TEXT,
    completed_at  TEXT,
    submit_tree   TEXT,
    complete_tree TEXT
  );
  CREATE UNIQUE INDEX review_single_draft ON review (status) WHERE status = 'draft';

  -- A conversation anchored to lines of one side of a diff. The diff it was written
  -- against (from_tree, to_tree) is pinned, so the original context survives any later
  -- edit, rebase or gc. anchor_text keeps the anchored lines for quick display.
  CREATE TABLE thread (
    id             INTEGER PRIMARY KEY,
    path           TEXT NOT NULL,
    side           TEXT NOT NULL CHECK (side IN ('old', 'new')),
    start_line     INTEGER,
    end_line       INTEGER,
    blob           TEXT NOT NULL,
    from_tree      TEXT NOT NULL,
    to_tree        TEXT NOT NULL,
    anchor_text    TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    needs_decision INTEGER NOT NULL DEFAULT 0 CHECK (needs_decision IN (0, 1)),
    created_at     TEXT NOT NULL,
    resolved_at    TEXT,
    CHECK ((start_line IS NULL) = (end_line IS NULL)),
    CHECK (start_line IS NULL OR (start_line >= 1 AND end_line >= start_line))
  );
  CREATE INDEX thread_path ON thread (path);

  CREATE TABLE comment (
    id         INTEGER PRIMARY KEY,
    thread_id  INTEGER NOT NULL REFERENCES thread (id) ON DELETE CASCADE,
    review_id  INTEGER NOT NULL REFERENCES review (id),
    author     TEXT NOT NULL CHECK (author IN ('user', 'claude')),
    body       TEXT NOT NULL,
    draft      INTEGER NOT NULL DEFAULT 0 CHECK (draft IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (author = 'user' OR draft = 0)
  );
  CREATE INDEX comment_thread ON comment (thread_id, id);
  CREATE INDEX comment_review ON comment (review_id);

  -- "Viewed": the user has reviewed this exact content of this file. A new blob clears it.
  CREATE TABLE file_mark (
    path       TEXT NOT NULL,
    blob       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (path, blob)
  );

  -- "Done": the user has reviewed this range of one diff. Keyed by both blobs, so it holds
  -- only for the diff it was made on; content_hash lets later re-anchoring keep it alive.
  CREATE TABLE section_mark (
    id           INTEGER PRIMARY KEY,
    path         TEXT NOT NULL,
    from_blob    TEXT,
    to_blob      TEXT,
    side         TEXT NOT NULL CHECK (side IN ('old', 'new')),
    start_line   INTEGER NOT NULL CHECK (start_line >= 1),
    end_line     INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    CHECK (end_line >= start_line)
  );
  CREATE UNIQUE INDEX section_mark_unique
    ON section_mark (path, IFNULL(from_blob, ''), IFNULL(to_blob, ''), side, start_line, end_line);

  -- Opaque UI state (expanded ranges, view mode, scope selection) so a review resumes where it stopped.
  CREATE TABLE ui_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  -- The Claude Code session that picked a review up. Another session may take it over only
  -- once this one has stopped listening, so two sessions never work on one review at once.
  ALTER TABLE review ADD COLUMN agent_session TEXT;

  -- Sessions that have asked to be woken for reviews. Hooks act only in these sessions, so an
  -- unrelated Claude session in the same repository is never blocked or nudged.
  CREATE TABLE listener (
    session_id    TEXT PRIMARY KEY,
    registered_at TEXT NOT NULL,
    last_seen     TEXT NOT NULL
  );
  `,
  `
  -- When a suggestion in this comment was written into the working tree.
  ALTER TABLE comment ADD COLUMN applied_at TEXT;
  `,
  `
  -- Archived conversations and reviews are hidden from the normal views, and no longer keep
  -- their snapshots pinned.
  ALTER TABLE thread ADD COLUMN archived_at TEXT;
  ALTER TABLE review ADD COLUMN archived_at TEXT;
  `,
];
