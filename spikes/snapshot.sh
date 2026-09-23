#!/usr/bin/env bash
# Phase 0 spike: commit-free working-tree snapshots via a temporary index.
# Proven: captures modified/untracked/deleted, leaves the real index byte-identical.
set -euo pipefail
repo_root=$(git rev-parse --show-toplevel)
idx="$repo_root/.postil/tmp-index"
mkdir -p "$(dirname "$idx")"
grep -qxF '/.postil/' "$repo_root/.git/info/exclude" 2>/dev/null || echo '/.postil/' >> "$repo_root/.git/info/exclude"

snapshot() {                      # -> tree SHA
  rm -f "$idx"
  GIT_INDEX_FILE="$idx" git read-tree HEAD
  GIT_INDEX_FILE="$idx" git add -A
  GIT_INDEX_FILE="$idx" git write-tree
}
pin()  { git update-ref "refs/postil/snapshots/$2" "$1"; }   # tree, id — REQUIRED, gc prunes unpinned trees
diff_trees()    { git diff "$1" "$2"; }
diff_live()     { rm -f "$idx"; GIT_INDEX_FILE="$idx" git read-tree HEAD
                  GIT_INDEX_FILE="$idx" git add -A; GIT_INDEX_FILE="$idx" git diff "$1"; }
"$@"
