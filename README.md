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
npm install
npm run install-plugin          # builds postil and installs its Claude Code plugin from this checkout
```

The plugin is self-contained: it runs from a bundle inside the plugin with plain `node`, so
nothing needs to be on your PATH. For the `postil` command in your own terminal (`status`,
`open`, `doctor` and so on), link it once:

```sh
node plugin/dist/postil.mjs link   # symlinks postil into ~/.local/bin
```

After pulling changes, run `npm run install-plugin` again: Claude Code only picks up a rebuilt
plugin on reinstall. `postil doctor` checks the whole setup.

## Use

In a Claude Code session in the repository you want to review, run:

```
/postil:review
```

Claude starts the review server (if it is not already running), opens the UI, and starts
listening. Review the diff, leave comments, and press **Submit review**. Claude picks the review
up on its own, changes the code, replies to each comment, and marks the review complete. Reply
again or resolve threads, submit again, and repeat until you are happy. The header shows whether
Claude is listening.

For hands-free rounds, Claude must be able to edit without asking: run the session in
accept-edits or auto mode. The plugin's hooks act only in the session that ran `/postil:review`;
another session started in the same repository is just told, in one line, that a review server
is running.

By default "all changes" means the changes on your branch since it left `main`, or, on `main`
itself, everything since postil was first used in the repository. `postil base <rev>` measures
from another commit, and `postil base --empty` puts every file in the repository under review.
The scope menu in the UI also offers uncommitted changes, changes since your last review, and any
range of commits.

postil keeps its state (reviews, comments, the server's address and token) in `.git/postil/`
and pins the snapshots it needs under `refs/postil/`. It adds nothing to your working tree, and
the server only listens on `127.0.0.1`.

Other commands: `postil start`, `stop`, `status`, `open`, `url`, `base`, `archive`, `doctor`, and
`help`.

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
- **Phase 6 — hardening: done.** Safe against Claude editing while you review, image previews,
  minified and renamed files, 2,000-file reviews, several repositories and worktrees at once, and
  a self-contained plugin with a one-command install.

## Development

Requires Node 24 and git 2.43 or newer. Node runs the TypeScript sources directly.

```sh
npm install
npm run build                 # build the UI into web/dist, then bundle the plugin into plugin/dist
npm run check                 # typecheck and run the unit and integration tests
node src/cli/main.ts serve    # serve the repository you are in, from source
node src/cli/main.ts open     # open the review UI in your browser
claude --plugin-dir ./plugin  # try the plugin without installing it (after npm run build)
```

UI development with hot reload, against a running server:

```sh
POSTIL_URL=http://127.0.0.1:<port> npm run dev:web
```

Then open `http://localhost:5173/#token=<token>`, with the token from `postil url`.

`node e2e/perf.ts` loads and scrolls a synthetic review (300 files; set `FILES=2000` for more)
and reports load time, main-thread blocking and DOM size.

Live tests run real Claude Code sessions with the plugin's bundle, so run `npm run build` first.
They cost money and depend on the model, so they are run by hand: `node e2e/live/headless.ts`
and `node e2e/live/interactive.ts` (the second needs tmux).

Browser tests drive the built UI in headless Chromium. They need Playwright's browser and its
system libraries once:

```sh
npx playwright install --with-deps chromium
npm run build && npm run test:e2e
```

See [`docs/PLAN.md`](docs/PLAN.md) for the full design.
