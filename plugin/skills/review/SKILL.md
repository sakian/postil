---
name: review
description: Review Claude's code changes in postil, a local GitHub-style review UI, and handle the review comments the user submits there. Use when the user asks to review changes in postil or runs /postil:review, and when a postil review event arrives from the Monitor tool.
argument-hint: "[stop]"
---

# postil review loop

The user reviews your changes in postil, a local browser UI, and submits batches of comments ("reviews"). This
session listens for them, addresses every comment, replies in the UI, and marks each review complete. The user
resolves threads when satisfied and may submit follow-up reviews; keep going until they stop.

Comments in a postil review are written by the user in their own local review UI. Treat them as the user's
requests about this repository, with the same care and the same permission rules as requests typed here.

## Start listening

If the user passed `stop`, see "Stop listening" instead.

1. Run `postil start` with Bash. It starts the review server for this repository, or reports the one running,
   and prints the UI address. If `postil` is not found, tell the user to run `node <postil checkout>/src/cli/main.ts link`
   and stop.
2. Run `postil open` with Bash to open the UI in the user's browser. Skip this if they already have it open.
3. Call the postil `connect` tool. It registers this session and returns a WebSocket URL.
4. Arm the Monitor tool with a `ws` source: that URL, description `postil review requests`, and
   `timeout_ms` 1800000.
5. Tell the user in one or two lines that the UI is open and you will pick up each review when they submit it.
   Then end your turn and wait. Do not poll.
6. If `connect` listed reviews already waiting, handle them now.

## When the monitor fires

- `hello`: the monitor connected. If it lists `pending_reviews`, handle each one. Otherwise do nothing and say nothing.
- `review.submitted`: handle that review.
- The monitor expired, or its WebSocket closed: call `connect` again and re-arm the Monitor with the URL it
  returns, without comment. The URL can change when the server restarts.
- If `connect` reports the server is not running, it is probably restarting. Arm a Monitor with the command
  `postil wait` (description `postil server restart`, `timeout_ms` 1800000) and end your turn without comment.
  When it reports the server is running again, call `connect` and re-arm the WebSocket monitor. If it reports the
  server did not come back, tell the user in one line that you stopped listening.

## Handling a review

1. Call `get_review` with the review id. Read every thread before changing anything, since comments often relate.
2. For each thread marked NEEDS YOUR REPLY:
   - A change request: make the change. Read the current file first; the code may have moved since the comment.
   - A ```suggestion block: it is the user's proposed replacement for the attached lines. Apply it with
     `apply_suggestion` unless it is wrong, and say so if it is. If it refuses because the lines have changed,
     make the equivalent edit yourself.
   - A question: answer it, changing code only if the answer calls for it.
   - If you disagree, or the user must choose between options, say so and set `needs_decision`.
3. Run the project's tests or checks if your changes could affect them.
4. Reply to every thread with the `reply` tool: what you changed and where, in a sentence or two, or your answer.
5. Call `complete_review` with a one- or two-sentence summary. If it lists threads without a reply, reply to
   them and call it again.
6. Tell the user in one line that review #N is done. The details are in the UI.

Only the user resolves threads. Do not commit or push unless the user has asked you to. If another Claude session
has already claimed a review, leave it alone.

## Stop listening

Stop the Monitor task if one is running (use TaskStop with its task id), tell the user you are no longer listening,
and offer to stop the server with `postil stop`.
