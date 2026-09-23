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
- **Phase 2 — browser UI: next.**

## Development

Requires Node 24 and git 2.43 or newer. Node runs the TypeScript sources directly.

```sh
npm install
npm run check                 # typecheck and run all tests
node src/cli/main.ts serve    # serve the repository you are in
node src/cli/main.ts status
```

See [`docs/PLAN.md`](docs/PLAN.md) for the full design.
