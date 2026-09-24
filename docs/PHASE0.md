# Phase 0 results — 2026-09-23

Go/no-go spikes for the postil design. **Verdict: go.** All three passed on Claude Code 2.1.278, Node 24.21.0.
Spike code kept in `spikes/`.

## Spike 1 — Monitor wake-up (the risky one)

The `Monitor` tool with a `ws:` source subscribes to a local WebSocket; each text frame becomes an event in
the session.

| Question | Result |
|---|---|
| Does a frame reach Claude mid-turn? | Yes |
| **Does a frame wake an idle session with no user input?** | **Yes** — a submit fired 50s after the turn ended and re-invoked the session unprompted |
| Token auth in the query string? | Yes — `ws://127.0.0.1:PORT/events?token=…`; bad path or token is rejected at upgrade |
| What happens at expiry? | Socket is closed cleanly by Claude Code, and one notice arrives: `[Monitor expired after 2m with 2 events delivered. Re-arm it if you still need the watch.]` |
| Does it reconnect if the server restarts? | **No.** The watch ends with `[WebSocket closed: 1006 Connection ended]` |

This is the feature the whole "automatic on submit" idea rests on, and it works.

**Consequences for the build:**
- The skill must re-arm on both the expiry notice and any close event. A close is not an error; a server
  restart produces one, and without re-arming the session goes deaf silently.
- Max monitor lifetime is 30 minutes, so re-arming is routine, not exceptional.
- Frames should be small and self-describing (`{type, review_id, thread_count}`). The frame is a doorbell;
  Claude fetches the real content over MCP.
- No heartbeat needed to reap subscribers: sockets close on expiry. (An earlier reading of "2 clients" was
  simply two monitors briefly alive at once, not a leak.)

## Spike 2 — Stop hook gate

A plugin loaded with `--plugin-dir` fired its `Stop` hook; returning `{"decision":"block","reason":"…"}`
injected the reason into the session as a **`Stop hook feedback:`** user turn and forced another turn.

- Unanswered thread → blocked, 2 turns.
- All threads answered → clean stop, 1 turn, no interference.
- Hook input includes `stop_hook_active`, `session_id`, `transcript_path`, `cwd`, `permission_mode`,
  `last_assistant_message`.

**Consequences for the build:**
- `stop_hook_active` is `true` on the retry and **must** be honoured, so the gate fires **once per turn
  chain**. It is a strong nudge, not an absolute gate. If Claude still does not reply, allow the stop and
  leave the review pending; the next event picks it up.
- The reason text arrives with no surrounding context, so it must be self-contained: name the files, the
  line ranges, and the exact MCP tool to call.
- The hook must no-op when the server is unreachable. A dead server must never wedge an unrelated session.

## Spike 3 — commit-free snapshots

`git write-tree` against a temporary index, in `spikes/snapshot.sh`.

- Captures modified, untracked, and deleted files; honours `.gitignore`.
- **The real `.git/index` is byte-identical afterwards** — staged work is untouched.
- `git diff <t1> <t2>` gives "since last review"; diffing a tree against a temp index rebuilt from the
  working tree gives the live view.

**Two findings that change the plan:**
1. `.postil/` captures itself unless excluded. Writing `/.postil/` to `.git/info/exclude` is load-bearing.
2. **Unpinned snapshot trees are destroyed by `git gc --prune=now`.** Pinning under
   `refs/postil/snapshots/<id>` survives gc and does not appear in `git branch -a` or `git log --all`.

## Carried into Phase 1

1. Re-arm the monitor on expiry *and* on close; treat a close as "server restarted".
2. Pin every snapshot ref immediately; unpin only on archive.
3. Write the exclude entry at server start, before the first snapshot.
4. Stop-hook reason must be self-contained and name the MCP tool.
5. Stop hook no-ops when the server is unreachable.
