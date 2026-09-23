# postil

Local, GitHub-style code review for diffs that Claude Code produces.

Review changes in a browser, leave comments on line ranges, and submit a review. A Claude Code
session picks the review up automatically, edits the code, and replies to each thread. Iterate
until you resolve every thread. Everything stays on your machine.

*A postil is a marginal note on a text.*

## Setup

Requires Node 24, git 2.43 or newer, and Claude Code.

```sh
git clone git@github.com:sakian/postil.git ~/postil && cd ~/postil
npm install && npm run build
node src/cli/main.ts link                # puts `postil` on your PATH via ~/.local/bin
claude plugin marketplace add ~/postil
claude plugin install postil@postil
```

## Use

In a Claude Code session in the repository you want to review, run:

```
/postil:review
```

Claude starts the review server, opens the UI, and starts listening. Review the diff, leave
comments, and press **Submit review**. Claude picks the review up on its own, changes the code,
replies to each comment, and marks the review complete. Reply again or resolve threads, submit
again, and repeat until you are happy. The header shows whether Claude is listening.

For hands-free rounds, Claude must be able to edit without asking: run the session in
accept-edits or auto mode. Only the Claude session that ran `/postil:review` is affected by the
plugin's hooks; other sessions in the same repository are left alone.

Other commands: `postil status`, `postil open`, `postil stop`, and `postil help`.

## Status

- **Phase 0 — spikes: done.** The automatic wake-up, the Stop-hook gate, and commit-free
  snapshots are all verified. See [`docs/PHASE0.md`](docs/PHASE0.md).
- **Phase 1 — server core: done.** Git engine, SQLite store, review workflow, HTTP API,
  WebSocket event feed, and CLI. Verified end to end with a real Claude Code monitor.
- **Phase 2 — browser UI: done.** Unified and split diffs, expandable and recollapsible context,
  line-range comments, reviews, conversations, viewed files, and outdated comments kept in view.
- **Phase 3 — Claude Code plugin: done.** Submitted reviews wake a listening session, which
  handles them with no prompt. Verified with real Claude sessions, including an idle one.
- **Phase 4 — scope and history: done.** Comments follow their code as it moves, outdated ones
  show what changed, suggestions apply with one click (or by Claude), files updated since your
  last review are marked, and any range of commits can be reviewed.
- **Phase 5 — polish: done.** Mark sections done (they stay done through edits elsewhere),
  keyboard shortcuts (press `?`), syntax highlighting, smooth scrolling through hundreds of
  files, and archiving of finished conversations.
- **Phase 6 — hardening: next.**

## Development

Requires Node 24 and git 2.43 or newer. Node runs the TypeScript sources directly.

```sh
npm install
npm run build                 # build the browser UI into web/dist
npm run check                 # typecheck and run the unit and integration tests
node src/cli/main.ts serve    # serve the repository you are in
node src/cli/main.ts open     # open the review UI in your browser
```

UI development with hot reload, against a running server:

```sh
POSTIL_URL=http://127.0.0.1:<port> npm run dev:web
```

`node e2e/perf.ts` loads and scrolls a 300-file synthetic review and reports load time and
main-thread blocking.

Live tests run real Claude Code sessions with the plugin. They cost money and depend on the
model, so they are run by hand: `node e2e/live/headless.ts` and `node e2e/live/interactive.ts`.

Browser tests drive the built UI in headless Chromium. They need Playwright's browser and its
system libraries once:

```sh
npx playwright install --with-deps chromium
npm run build && npm run test:e2e
```

See [`docs/PLAN.md`](docs/PLAN.md) for the full design.
