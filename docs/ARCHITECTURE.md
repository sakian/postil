# Architecture

postil has three parts: a local server per repository, a browser UI that talks to it, and a
Claude Code plugin that lets a Claude session receive reviews, reply to them, and complete them.

## The review loop

```
 you                  browser (postil UI)        postil server                Claude Code session
  |  /postil:review  ------------------------------------------------------>  connect (MCP): starts the
  |                                                 server <-----------------  server, registers the session
  |                                                                            arms Monitor on ws://…/events
  |  comment on lines (drafts autosave) ---------->  SQLite
  |  Submit review ------------------------------->  snapshot tree  ------->  frame: review.submitted
  |                                                                            get_review (MCP)
  |                                                                            edits code, runs tests
  |                                                  <----------------------  reply, per thread
  |                                                  <----------------------  complete_review(summary)
  |  UI updates live (ws) <-----------------------   snapshot tree
  |  reply or resolve threads, submit again … until every thread is resolved
```

Rules of the loop:

- Only you resolve threads. Claude replies, and can flag a thread as needing your decision.
- Every submission is a batch (a review), even a single reply. Claude handles a batch as one unit
  and ends with a summary.
- A review is claimed by the session that fetches it. Another session can take it over only after
  the first one stops listening, so two sessions never work on one review.
- The server snapshots the working tree at each submit and each completion, so "since last review"
  is a diff between two trees and needs no commits.

## Layout

A single TypeScript package on Node 24. Node runs the TypeScript directly (type stripping), so the
server has no build step and `tsc` only typechecks. Only the UI and the plugin bundle are built.

```
src/git/        git process runner, output parsers, Repo (snapshots, pins, diffs)
src/db/         SQLite schema, migrations, Store
src/core/       Postil service (all review rules), events, anchors, discovery, HTTP client
src/server/     Hono HTTP API, WebSocket event feed, static UI, server lifecycle
src/cli/        the postil command, MCP server, hook handlers, doctor
web/            Vite + React UI; pure logic in web/src/lib is unit-tested under Node
plugin/         Claude Code plugin: skill, .mcp.json, hooks; the build writes plugin/dist
scripts/        build-plugin (esbuild bundle into plugin/dist) and install-plugin
test/           node:test suites against throwaway repositories
e2e/            Playwright tests against the built UI, a benchmark, and live Claude tests
```

## State

Everything lives in the repository's git directory, where `git clean -fdx` cannot delete it and
snapshots cannot capture it:

| Path | Contents |
|---|---|
| `.git/postil/postil.db` | SQLite (`node:sqlite`): snapshots, reviews, threads, comments, file and section marks, UI state, listening sessions |
| `.git/postil/server.json` | The running server's port, token, pid and version (mode 0600) |
| `.git/postil/token` | The API token, kept across restarts so an open browser tab can reconnect |
| `.git/postil/server.lock` | Exclusive lock: one server per repository, and stale locks from crashed servers are detected |
| `.git/postil/worktree.index` | The private index used for snapshots |
| `refs/postil/<worktree>/…` | Refs that keep snapshot trees, file versions and a fixed base alive through `git gc` |

Linked worktrees share the repository's refs, so each worktree has its own ref namespace. Pruning
one worktree's archive cannot release snapshots another still needs.

## Snapshots without commits

A snapshot is `git add -A` into a private index followed by `git write-tree`. The user's real index,
stash and history are never touched. The private index persists between snapshots and is seeded
from a copy of the real index, so git's stat cache stays warm and only changed files are re-hashed.

Tree objects are ordinary git objects, so any two snapshots can be diffed. Unreferenced trees are
deleted by `git gc`, so every snapshot is pinned by a ref when it is taken. Pins stay out of
`git branch -a` and `git log --all`. Archiving finished reviews unpins what nothing live still needs.

Diffs are addressed by tree and blob ids, never by scope. Trees are immutable, so the view never
shifts while Claude edits, and every diff result can be cached forever. Snapshots at submit and
completion wait until two reads a moment apart agree, so a file Claude is halfway through writing
is not captured.

The base for "all changes" is, on a feature branch, the merge base with the branch its pull
request targets, asked of the `gh` CLI when it is installed, or else the default branch. The
remote's copy of that branch is preferred, since a local copy can be stale. Anywhere else the base
is HEAD when postil first ran in the repository. `postil base` or the header's branch picker
changes it, and a fixed commit is pinned so a rebase or `git gc` cannot take it away.

## Anchors

A comment records the path, side, line range and blob it was written on, and pins both trees of the
diff it was written in, so its original context survives edits, rebases and `git gc`. When the file
changes, its lines are mapped through a zero-context diff from the old blob to the new one,
following renames. The result is one of four states:

- **current**: the file is unchanged.
- **moved**: the lines are unchanged but shifted by edits elsewhere. Shown at the new position with
  no warning, since the comment is still accurate.
- **outdated**: the lines themselves changed. Shown where that code is now, with a diff of the lines
  then against the lines now.
- **gone**: the code no longer exists. Grouped at the top of the file.

"Section done" marks use the same anchors, so a section stays done while Claude edits elsewhere in
the file and lapses only when its own lines change. Claude's view of a review uses them too, so it
is told whether code moved or changed, and sees the current code.

Applying a suggestion is refused unless the target lines are exactly as they were when suggested.
The file is re-read just before the final rename, so a concurrent edit is never overwritten. Files
that are not UTF-8 are refused, and line endings and a missing final newline are preserved.

## Server

- Hono on `127.0.0.1`, reusing the previous port when it is free. Every request needs the bearer
  token, and requests with an unrecognised `Host` header are rejected, which blocks DNS rebinding.
- Git is run as a process (no libgit binding) and its output parsed into a hunk model.
- The working tree is polled every 1.5s, but only while a browser is connected, and the private
  index keeps each poll to a stat walk. A filesystem watcher was rejected: recursive inotify on a
  repository with `node_modules` exhausts watch limits. Changes Claude makes during a review do not
  move your view; they show as badges until you refresh a file or switch scope.

### Event feed

The WebSocket at `/events` has two channels. `?channel=ui` carries everything: drafts, submits,
replies, resolves, completions, marks, base changes and working-tree changes. `?channel=agent`
carries only what Claude must act on, `review.submitted` and `session.finished`, because every
frame Claude receives costs a turn of its context, and Claude must never be woken by its own
edits. The agent channel's greeting lists reviews
already waiting, so a monitor that re-arms after a gap still sees what it missed. Browsers must
send an `Origin` matching the server's own, so a page on another site cannot open the feed.

## Claude Code plugin

The plugin is self-contained. `plugin/dist/postil.mjs` is an esbuild bundle of the CLI, server, MCP
server and hooks, with the built UI beside it, and runs with plain `node`, so nothing has to be on
PATH. Claude Code caches a failed MCP connection for about 15 minutes, and a missing binary was the
usual cause. `npm run install-plugin` rebuilds and reinstalls, since Claude Code ignores a rebuilt
plugin whose version has not changed.

Sessions are identified by `CLAUDE_CODE_SESSION_ID`, which Claude Code gives both MCP servers and
hooks. `connect` registers the session as a listener and the monitor URL names it, so the server
knows which sessions are listening, and the UI shows it.

### Wake-up

The skill arms Claude Code's `Monitor` tool with a `ws` source on the agent channel. Each frame
becomes an event in the session, and it wakes an idle session with no user input. A monitor expires
after at most 30 minutes, and it does not reconnect when the socket closes, so the skill re-arms on
both. If the server is down at that moment, the session arms a one-shot monitor on `postil wait`,
which exits when the server is back, and re-arms from there. It never restarts a server the user
stopped.

The doorbell frame carries the whole procedure for handling a review, so a long session whose skill
text was compacted away still knows what to do when woken.

**Finish session** in the UI sends `session.finished`, optionally asking Claude to commit what is
left and push. Claude does so, stops its monitor and does not re-arm. Claude never commits or pushes
otherwise, unless the user asks, or ticks the option for Claude to commit (never push) after each
review.

### MCP tools

Run over stdio by `.mcp.json`, and proxied to the HTTP server found through `.git/postil/server.json`,
so the plugin needs no fixed port.

| Tool | Purpose |
|---|---|
| `connect` | Start the server if needed (unless `start` is false), register the session, return the monitor URL |
| `open_ui` | Open the review UI in the browser |
| `list_pending` | Reviews waiting for Claude |
| `get_review` | Every thread in a review, rendered as Markdown with current code and anchor state, and the next steps |
| `get_thread` | One thread with wider context |
| `reply` | Post Claude's reply to a thread, optionally flagging it as needing the user's decision |
| `apply_suggestion` | Apply a suggestion block to the working tree |
| `complete_review` | Snapshot, mark the review done, and notify the browser; fails while any thread lacks a reply |

### Hooks

The hooks act only in a session that is listening. Every other session in the repository is left
alone, and a server that is not running makes every hook a silent no-op.

- `SessionStart` re-injects the procedure after compaction and asks a resumed session to re-arm its
  monitor.
- `UserPromptSubmit` adds a note about reviews that are waiting.
- `Stop` blocks the session from ending its turn while it owes replies or a completion, or while a
  review waits. It honours `stop_hook_active`, so it blocks once per turn chain: a strong nudge,
  not an absolute gate. Its reason arrives with no surrounding context, so it names the threads and
  the tool to call.

The hooks are also the fallback if the monitor misses a review: the next time the session is
active, it is told.

## Web UI

React and Vite, with a zustand store fed by REST and the event feed. The token arrives in the URL
fragment, which is never sent to the server; the page keeps it in `localStorage` and removes it
from the address bar. The page runs under a strict content security policy, and raw file previews
under a sandboxing one, so an SVG opened directly cannot run script.

The diff renderer is custom, built on the server's hunk model, because sections done, recollapsing
context and outdated anchors are not exposed by existing diff components. Syntax highlighting uses
Shiki in a Web Worker with its JavaScript regex engine, so the content security policy needs no
WebAssembly exception. Each grammar is its own chunk, loaded on first use.

Large reviews stay responsive in two ways. Off-screen file bodies skip layout and paint
(`content-visibility`), which keeps their state, unlike unmounting. Reviews over 150 files also
render only the files near the viewport, with heights measured as they mount. Unsent comment text
lives in the store, so nothing is lost when a file leaves the page. `node e2e/perf.ts` measures it.

## Risks

- **The `Monitor` tool is undocumented** and could change. The hooks still deliver reviews the next
  time the session is active, and the wake-up lives in the skill text, not the server. The server
  is a plain WebSocket publisher, so a different transport would change only the skill.
- **Claude Code channels** (an MCP server sending `notifications/claude/channel`) are a documented
  alternative with no expiry to re-arm. They are not used yet: they are a research preview, each
  session must be started with a flag, and a custom channel needs
  `--dangerously-load-development-channels`. Worth revisiting if that changes.
- **Permissions:** review comments are the user's requests, but they arrive as events. The skill
  tells Claude to apply the session's normal permission rules to them.
