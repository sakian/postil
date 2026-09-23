# Postil — local code review for Claude Code diffs

*A postil is a marginal note on a text. This tool lets you write marginal notes on Claude's diffs and have Claude answer them.*

Status: plan, 2026-09-23. Nothing implemented yet.

## 1. Feasibility

Yes. Every piece needed exists today:

| Need | Mechanism | Documented? |
|---|---|---|
| Show diffs, comments, review state in a browser | Local Node server + web UI, bound to 127.0.0.1 | n/a |
| Claude reads the review and posts replies | MCP server (stdio) bundled in a Claude Code plugin | yes |
| Claude is woken automatically when you submit | Claude Code `Monitor` tool with a `ws:` source: it opens a WebSocket to the postil server and each frame becomes an event in the session, even when Claude is idle | **verified in Phase 0** on 2.1.278; not in the public docs. Does not auto-reconnect: the skill re-arms on expiry and on close |
| Claude cannot finish a turn with unanswered threads | `Stop` hook that queries the server and returns `decision: block` with the list of unanswered threads | yes |
| Claude knows about postil at session start | `SessionStart` hook injects "postil is running on port N; arm the monitor" | yes |
| Manual entry point | `/postil` skill in the plugin | yes |
| "Changes since last review" without commits | `git write-tree` against a temporary index to snapshot the working tree at each review and each Claude reply. No commits, no touching your index or stash | n/a |

Fallback if the `Monitor` wake-up turns out unreliable (it is the one thing to prototype first, see Phase 0): the `UserPromptSubmit` and `Stop` hooks still inject pending reviews the next time Claude is active, so the worst case is pressing Enter once. A second fallback is the undocumented peer-session socket in `~/.claude/sessions/<pid>.json` (`messagingSocketPath`), which is how one local Claude session messages another. Not worth building on until it is documented.

## 2. How it fits the Claude Code workflow

```
 you                 browser (postil UI)          postil server             Claude Code session
  |  /postil  ---------------------------------------> starts (if needed) --> SessionStart hook: "postil on :PORT"
  |                                                                            arms Monitor ws://127.0.0.1:PORT/events
  |  review diff, add comments (drafts autosave) ---->  SQLite
  |  Submit review -----------------------------------> snapshot tree, ----> ws frame {review.submitted, id}
  |                                                                            Claude: postil_get_review(id)
  |                                                                            edits code, runs tests
  |                                                                            postil_reply(thread, body) per thread
  |                                                     <---------------------- postil_complete_review(id, summary)
  |  UI updates live (ws to browser) <----------------- snapshot tree
  |  "Changes since last review" view, reply or resolve threads
  |  ... repeat until all threads resolved
```

Rules of the loop:

- Only you resolve threads. Claude replies; it may flag a thread "needs your decision".
- Every submission is a batch (a "review"), even a single reply. Claude processes a batch as one unit and ends with a summary.
- The Stop hook makes it impossible for Claude to end its turn while a thread in the current review has no reply from Claude.
- The server snapshots the working tree at each submit and each completion, so "since last review" is a tree-to-tree diff, independent of commits.

## 3. Feature map

Everything you listed, and where it lands.

### Kept from GitHub

| Feature | Design |
|---|---|
| All changes / since last review / pick commits | Scope selector. "All" = base ref vs working tree. "Since last review" = snapshot at your last submit vs working tree. "Commits" = multi-select from `git log base..HEAD`, plus "uncommitted" as a pseudo-commit. |
| Comments in code or in a list | Inline widgets under the anchored lines, and a Threads panel with filters (open, awaiting me, awaiting Claude, resolved, outdated). |
| Multi-line targets | Click-drag or shift-click on gutter selects a range; comment anchors to (path, side, start, end, blob SHA). |
| Mark file viewed | Per-file checkbox stored with the blob SHA; auto-cleared when the file changes, like GitHub. |
| Inline vs side-by-side | Both rendered from the same hunk model. |
| Backtick code and suggestions | Markdown body. A ```suggestion fence renders as a diff with an Apply button (server patches the working tree) and Claude can apply it via `postil_apply_suggestion`. |
| Submit a group of comments | Drafts live in SQLite until you press Submit. Submit = one review record. |
| Partial review, resume later | All UI state (drafts, viewed, section-done, expanded ranges, scope selection) is persisted server-side, keyed by review scope. Close the tab, reopen, same place. |
| Collapsed files, expand sections | Hunks with context, expand-up / expand-down / expand-all per gap. |
| Collapsible file tree | Sidebar tree with per-file status (viewed, comment count, changed-since-review badge). |

### Improvements you asked for

| Improvement | Design |
|---|---|
| Local, not online | Server binds 127.0.0.1 with a random bearer token in the opened URL, and rejects foreign `Host` and `Origin` headers. State lives in the repository's git dir (`.git/postil/`), where `git clean -fdx` cannot delete it and snapshots cannot capture it. |
| Automatic Claude pickup | Monitor + hooks as in section 1. No "go look at the review" prompt. |
| Fast inline/split toggle | Single keystroke (`s`) and a header toggle. Preference persisted. No config screen. |
| Mark sections done | Each hunk (or an arbitrary selected line range) can be marked done. Done sections collapse to a one-line summary and dim in the tree count. Stored with blob SHA; invalidated on change. File-done is just all-sections-done. |
| Faster expansion | Expand buttons on hover, keyboard `e` on a gap, expand-all per file, expand-all in file tree context menu. |
| Recollapse | Every expanded gap gets a collapse handle; `E` collapses all in the file; file header has expand-all/collapse-all. |
| Collapse-all in tree | Button in the tree header, plus per-directory collapse. |
| Old comments on changed code | Threads anchor to a blob SHA. When the blob changes, the thread becomes "outdated" and is re-anchored by diffing the old blob to the new one. Inline view still shows it at the re-anchored position with an "outdated" chip; clicking it opens a three-part view: the comment, the lines as they were when commented, and the same region now. The Threads panel has the same view. |

## 4. Architecture

Single TypeScript package on Node 24. Node runs the TypeScript directly (type stripping), so the
server has no build step; `tsc` only typechecks. Changed from the original workspace layout in
Phase 1: one package is simpler and avoids type stripping's refusal to run `.ts` under `node_modules`.

```
postil/
  src/git/                git process runner, parsers, Repo (snapshots, pins, diffs)
  src/db/                 SQLite schema, migrations, Store
  src/core/               Postil service (all review rules), events, discovery, client
  src/server/             Hono HTTP API, WebSocket event feed, server lifecycle
  src/cli/                `postil` binary, MCP server, and hook handlers
  test/                   node:test suites against throwaway repositories
  web/                    Vite + React UI; pure logic in web/src/lib is unit-tested under Node
  e2e/                    Playwright tests that drive the built UI against a real server
  plugin/                 Claude Code plugin: skill, .mcp.json, hooks
  .claude-plugin/         marketplace.json, so `claude plugin marketplace add <checkout>` works
```

### Server

- Hono on 127.0.0.1. The port is reused from the last run when free, and written to `.git/postil/server.json` (mode 0600) with the token and pid. The token persists across restarts so an open browser tab can reconnect. An exclusive lock file enforces one server per repository and detects locks left by crashed servers.
- SQLite via `node:sqlite`. Tables: `snapshot`, `review`, `thread`, `comment`, `file_state`, `section_state`, `ui_state`, `scope`.
- Git engine shells out to `git` (no libgit dependency): `write-tree` snapshots, `diff-tree` / `diff-index` for file lists, `diff` with `--no-color -U3` parsed into a hunk model, `cat-file` for full-file expansion and blob content at any snapshot.
- WebSocket `/events` has two channels. `?channel=ui` carries everything: `draft.changed`, `review.submitted`, `review.started`, `thread.replied`, `thread.resolved`, `review.completed`, `marks.changed`, `base.changed`, `worktree.changed`. `?channel=agent` carries only `review.submitted`, because every frame Claude receives costs a turn of its context, and it must never be woken by its own edits. On connect, the agent greeting lists reviews already waiting, so a monitor that re-arms after a gap still sees what it missed.
- Working-tree changes are detected by polling the snapshot tree every 1.5s, only while a browser is connected. The private index keeps this to a stat walk. A filesystem watcher was rejected: recursive inotify on a repo with `node_modules` exhausts watch limits.
- Working tree changes by Claude during a review do not move your view; they show as badges until you refresh a file or switch scope.

### Snapshots without commits

```
GIT_INDEX_FILE=.postil/tmp-index git read-tree HEAD
GIT_INDEX_FILE=.postil/tmp-index git add -A
GIT_INDEX_FILE=.postil/tmp-index git write-tree   -> tree SHA
```

Tree objects are ordinary git objects, so `git diff <tree1> <tree2>` works, and diffing a tree against a temp index rebuilt from the working tree gives the live view. Verified in Phase 0, including that the real `.git/index` is byte-identical afterwards. Two hard requirements found there: `git gc --prune=now` **destroys** unpinned trees, so every snapshot is pinned under `refs/postil/snapshots/<id>` at creation (pinned refs stay out of `git branch -a` and `git log --all`); and `.postil/` captures itself unless `/.postil/` is written to `.git/info/exclude` at server start, before the first snapshot.

### MCP tools (namespace `postil`)

| Tool | Purpose |
|---|---|
| `postil_pending` | Reviews awaiting Claude, with counts. Backed by `GET /api/agent/pending`, which exists since Phase 1, as do the routes behind the tools below. |
| `postil_get_review(review_id)` | Threads in the batch: path, side, range, code context (old and new), comment history, suggestion blocks, "outdated" status. |
| `postil_get_thread(thread_id)` | One thread with wider context. |
| `postil_reply(thread_id, body, {needs_decision?})` | Post Claude's reply. Body is markdown. |
| `postil_apply_suggestion(comment_id)` | Server applies the suggestion patch; returns result. |
| `postil_complete_review(review_id, summary)` | Snapshot, mark done, notify browser. Fails if any thread has no Claude reply. |

Transport: `.mcp.json` runs `postil mcp` over stdio; it proxies to the HTTP server using `.postil/server.json`. This avoids needing a fixed port in the plugin config.

### Hooks (plugin `hooks/hooks.json`)

- `SessionStart` → `postil hook session-start`: if a server is running for this cwd, emit `additionalContext` with the port and the instruction to arm `Monitor` on `ws://127.0.0.1:PORT/events?token=…`, plus a pointer to the `/postil` skill.
- `UserPromptSubmit` → `postil hook prompt`: if reviews are pending, inject a one-line notice.
- `Stop` → `postil hook stop`: if the in-progress review has threads without a Claude reply, return `{"decision":"block","reason":"…list…"}`. Verified in Phase 0, with three constraints: honour `stop_hook_active`, so the gate fires **once per turn chain** and is a nudge rather than an absolute gate; the reason must be self-contained (files, line ranges, the exact MCP tool to call) because it arrives with no surrounding context; and it must no-op when the server is unreachable so a dead server never wedges an unrelated session.

### Skill (`/postil`)

Instructions for Claude: how to arm and re-arm the monitor, how to process a review (read all threads first, group related ones, edit, run the project's tests if any, reply per thread with what changed and why, never resolve, call complete), and how to reply on disagreement (say so and set `needs_decision`). Also starts the server and opens the browser when invoked by you with no server running.

### Web UI

- React + Vite. State via a small store (zustand) fed by REST plus the WebSocket.
- Custom diff renderer built on the server's hunk model, not a drop-in diff component. The section-done, recollapse, and outdated-anchor features are the reason; existing components (diff2html, @git-diff-view, Monaco diff) do not expose them. Syntax highlighting with shiki, computed per file lazily.
- Virtualised file list so large reviews stay responsive.
- Keyboard: `j/k` next/prev file, `n/p` next/prev thread, `s` split/inline, `v` viewed, `d` section done, `e`/`E` expand/collapse, `c` comment on selection, `ctrl+enter` submit.

## 5. Phases

### Phase 0: spikes — DONE 2026-09-23

All three passed. Results and consequences in `docs/PHASE0.md`; code in `spikes/`. Idle wake-up is
confirmed: a submit fired 50s after a turn ended re-invoked the session with no user input.

### Phase 1: server core — DONE 2026-09-23

Everything planned, plus the agent-side API that Phase 3 wraps in MCP tools. 72 tests. Design
changes made during the phase:

- State moved from `.postil/` to `.git/postil/`, so `git clean -fdx` cannot delete a review.
- The snapshot index persists and is seeded from a copy of the real index, so each snapshot
  re-hashes only changed files instead of the whole tree.
- Diffs are addressed by tree and blob ids, not by scope. Trees are immutable, so a view never
  shifts while Claude edits, and every diff result is cacheable forever.
- Commit selection is a contiguous range, since non-contiguous commit sets have no single
  well-defined diff.
- Comments pin both trees of the diff they were written on, so the original context survives
  edits, rebases and gc. This is what the Phase 4 old-vs-new view will be built on.
- The agent event channel is separate from the UI channel, and its greeting lists missed reviews.

### Phase 2: UI MVP — DONE 2026-09-23

Everything planned: file tree, unified and split views with a one-key toggle (`S`), gap expansion
and recollapse, drag-to-select line ranges, draft comments, submit, the conversations list,
resolve, viewed files, Markdown with rendered suggestion blocks, and server-side persistence of
layout, scope, expansion and tree state. Verified by 15 Playwright tests in headless Chromium.

Pulled forward from later phases because they were cheap once the pieces existed:
- **Outdated comments stay in the diff (from Phase 4).** A thread whose code changed shows at the
  top of its file with an Outdated chip and the original lines. Full re-anchoring is still Phase 4.
- **A simple scope picker (from Phase 4):** all changes, uncommitted, and since any review. The
  commit-range picker is still Phase 4.
- **Tree collapse-all and expand-all, file expand-all and collapse-all (from Phase 5).**
- **`postil open` (from Phase 5).**
- **Live Claude status in the header:** "Waiting for Claude" until a session picks the review up,
  which makes a session that is not listening visible.

Design notes:
- The token travels in the URL fragment, is kept in `localStorage` (scoped to host and port),
  and is scrubbed from the address bar. The page runs under a strict content security policy.
- Diffs load lazily as files approach the viewport, which covers large reviews until Phase 5
  adds virtualised rendering.
- Expansion state is keyed by the new blob id, so it survives reloads and resets by itself when
  the file changes.
- Syntax highlighting remains in Phase 5.

### Phase 3: Claude loop — DONE 2026-09-23

The plugin in `plugin/`, installed through the repository's own marketplace:
- **Skill `/postil:review`** starts the server, opens the UI, registers the session, arms the
  Monitor, and holds the procedure for handling a review and re-arming after expiry or restart.
- **MCP tools** (`mcp__plugin_postil_postil__*`): `connect`, `list_pending`, `get_review`,
  `get_thread`, `reply`, `complete_review`. Reviews are rendered as Markdown for the model, with the
  next steps at the end. `apply_suggestion` stays in Phase 4 with the UI's Apply button; until
  then Claude applies suggestions by editing.
- **Hooks**: `Stop` blocks a listening session from ending its turn while it owes replies or a
  completion, or while a review waits; `UserPromptSubmit` adds the same as context;
  `SessionStart` re-injects the procedure after compaction and asks a resumed session to re-arm.
- **CLI**: `start`, `stop`, `link`, `mcp`, `hook`; `status` shows whether Claude is listening.

Design decisions made in the phase:
- **Sessions are identified**, from `CLAUDE_CODE_SESSION_ID`, which Claude Code gives both MCP
  servers and hooks. `connect` registers the session as a listener, and the monitor URL names it,
  so the server knows which sessions are listening right now. Hooks act only in listening
  sessions, so other sessions in the same repository are never blocked.
- **Reviews are claimed** by the session that fetches them. Another session can take a review over
  only after the claimer stops listening, so two sessions never work one review.
- **The doorbell carries the whole procedure**, so a long session whose skill text was compacted
  away still knows what to do when woken.
- **`postil` must be on PATH** for the plugin, because installed plugins are copied away from the
  checkout. `postil link` symlinks it into `~/.local/bin` without sudo.
- **The UI shows whether Claude is listening**, and a submitted review says "not listening" when
  nothing will pick it up.

- **Server restarts are survived.** A restart closes the monitor, and the reconnect can land in
  the gap while the server is down. The session then arms a second, one-shot Monitor on
  `postil wait`, which exits with one line when the server is back, and re-arms from there.

Verified with real Claude sessions (`e2e/live/`, run by hand since they cost money):
- Headless: handled a waiting review in 18 seconds, then armed its monitor to keep listening.
- Interactive, idle at its prompt with nobody typing: listening 8 seconds after `/postil:review`;
  woken by a review and done in 16 seconds; a follow-up on the same thread done in 8 seconds;
  re-armed 8 seconds after a server restart; a third review done in 10 seconds. A review that
  landed as Claude was ending a turn was caught by the Stop hook instead, exercising the fallback.
- Failure path: with `postil` missing from PATH, Claude explained the problem and gave the
  `postil link` command instead of failing silently.

### Phase 4: scope and history

- Scope selector with commit picker and "since last review".
- Outdated thread re-anchoring and the old-vs-new context view.
- Changed-since-review badges from the file watcher.
- Apply suggestion (UI button and MCP tool).

### Phase 5: polish

- Section done, collapse-all, expand-all, keyboard map, syntax highlighting, virtualised lists.
- `postil status` and `postil open`.
- Archive a finished review, prune snapshot refs.

### Phase 6: hardening

- Concurrency: you commenting while Claude edits the same file; blob-SHA checks on every write.
- Large diffs (binary files, renames, thousands of lines) and performance.
- Multiple repos at once (one server each; `postil open` picks by cwd).
- Install story: `npm i -g postil`, `claude plugin install ./plugin` or a marketplace entry.

## 6. Open decisions

- Base ref default: merge-base with the main branch, or the first snapshot taken when postil is started in the repo. Recommendation: merge-base when a main branch exists, first snapshot otherwise, always overridable.
- Whether Claude commits between rounds. Recommendation: no; snapshots make commits unnecessary, and you keep control of history. Optional setting later.
- Where drafts live when the same repo is reviewed from two machines. Out of scope; local only.

## 7. Risks

- The `Monitor` tool is undocumented and could change. Mitigation: hooks give a one-keypress fallback, and the wake-up code is isolated in the skill text, not in the server. The server stays a plain WebSocket publisher, so a replacement transport changes only the skill.
- Monitor expiry every 30 minutes costs one small turn to re-arm. Acceptable; the skill re-arms silently. It must also re-arm on close, since a server restart ends the watch and the session otherwise goes deaf without saying so.
- Cross-session permission modes: the monitor event is data, and the skill must make clear Claude still applies the session's normal permission rules when editing.
- Claude Code "channels" (an MCP server declaring `claude/channel` and sending
  `notifications/claude/channel`) are a documented alternative to the Monitor with no expiry to
  re-arm. Not used for now: they are a research preview, each session must be started with a
  flag, and a custom channel like postil's needs `--dangerously-load-development-channels`.
  Worth revisiting if that opt-in goes away.
- Claude Code caches a failed MCP connection for about 15 minutes. A user who installs the plugin
  before running `postil link` must reconnect with `/mcp` or wait.
