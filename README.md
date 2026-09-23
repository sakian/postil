# postil

Local, GitHub-style code review for diffs that Claude Code produces.

Review changes in a browser, leave comments on line ranges, and submit a review. A Claude Code
session picks the review up automatically, edits the code, and replies to each thread. Iterate
until you resolve every thread. Everything stays on your machine.

*A postil is a marginal note on a text.*

## Status

- **Phase 0 — spikes: done.** The automatic wake-up, the Stop-hook gate, and commit-free
  snapshots are all verified. See [`docs/PHASE0.md`](docs/PHASE0.md).
- **Phase 1 — server core: done.** Git engine, SQLite store, review workflow, HTTP API,
  WebSocket event feed, and CLI. Verified end to end with a real Claude Code monitor.
- **Phase 2 — browser UI: done.** Unified and split diffs, expandable and recollapsible context,
  line-range comments, reviews, conversations, viewed files, and outdated comments kept in view.
- **Phase 3 — Claude Code plugin: next.** Until then, Claude's side is reachable only through the
  HTTP API.

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

Browser tests drive the built UI in headless Chromium. They need Playwright's browser and its
system libraries once:

```sh
npx playwright install --with-deps chromium
npm run build && npm run test:e2e
```

See [`docs/PLAN.md`](docs/PLAN.md) for the full design.
