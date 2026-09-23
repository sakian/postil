# postil

Local, GitHub-style code review for diffs that Claude Code produces.

Review changes in a browser, leave comments on line ranges, and submit a review. A Claude Code
session picks the review up automatically, edits the code, and replies to each thread. Iterate
until you resolve every thread. Everything stays on your machine.

*A postil is a marginal note on a text.*

## Status

- **Phase 0 — spikes: done.** The automatic wake-up, the Stop-hook gate, and commit-free
  snapshots are all verified. See [`docs/PHASE0.md`](docs/PHASE0.md).
- **Phase 1 — server core: in progress.**

See [`docs/PLAN.md`](docs/PLAN.md) for the full design.
