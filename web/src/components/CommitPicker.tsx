import { useEffect, useState } from 'react';
import type { Commit, Scope } from '../../../src/core/api-types.ts';
import { relativeTime, shortSha } from '../format.ts';
import { useStore } from '../store.ts';

type Item = { kind: 'uncommitted' } | { kind: 'commit'; commit: Commit };

/**
 * Pick a contiguous range of commits since the base, newest first, optionally including
 * uncommitted changes. Click selects one; shift-click extends the range.
 */
export function CommitPicker({ onClose }: { onClose(): void }) {
  const commits = useStore((s) => s.commits);
  const scope = useStore((s) => s.scope);
  const { loadCommits, setScope } = useStore.getState();
  const [range, setRange] = useState<[number, number] | null>(null);

  useEffect(() => {
    void loadCommits();
  }, [loadCommits]);

  const info = commits?.state === 'ready' ? commits.value : null;
  const items: Item[] = info
    ? [...(info.uncommitted ? [{ kind: 'uncommitted' as const }] : []), ...info.commits.map((commit) => ({ kind: 'commit' as const, commit }))]
    : [];

  // Show the current commit scope as the initial selection.
  useEffect(() => {
    if (!info || range || scope.kind !== 'commits') return;
    const index = (sha: string) => items.findIndex((i) => i.kind === 'commit' && i.commit.sha.startsWith(sha));
    const newest = scope.to === 'worktree' ? items.findIndex((i) => i.kind === 'uncommitted') : index(scope.to);
    const oldest = index(scope.from);
    if (newest >= 0 && oldest >= 0) setRange([newest, oldest]);
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  const [lo, hi] = range ? [Math.min(...range), Math.max(...range)] : [-1, -1];
  const click = (i: number, shift: boolean) => setRange(shift && range ? [range[0], i] : [i, i]);

  const apply = () => {
    if (!range) return;
    const newest = items[lo]!;
    const oldest = items[hi]!;
    let next: Scope;
    if (oldest.kind === 'uncommitted') next = { kind: 'uncommitted' };
    else next = { kind: 'commits', from: oldest.commit.sha, to: newest.kind === 'uncommitted' ? 'worktree' : newest.commit.sha };
    void setScope(next);
    onClose();
  };

  const count = range ? hi - lo + 1 : 0;
  return (
    <div className="popover commit-picker" role="dialog" aria-label="Choose commits">
      <div className="popover-head">
        <strong>Choose commits</strong>
        <span className="muted">since {info?.base.label ?? 'the base'} · click one, shift-click for a range</span>
      </div>
      <div className="commit-list">
        {commits?.state === 'loading' && <div className="empty muted">Loading commits…</div>}
        {commits?.state === 'error' && <div className="empty error">{commits.message}</div>}
        {info && items.length === 0 && <div className="empty muted">No commits or changes since the base.</div>}
        {items.map((item, i) => (
          <button key={item.kind === 'commit' ? item.commit.sha : 'uncommitted'} className={`commit-row${i >= lo && i <= hi ? ' selected' : ''}`}
            onClick={(e) => click(i, e.shiftKey)}>
            <span className="commit-check">{i >= lo && i <= hi ? '✓' : ''}</span>
            {item.kind === 'uncommitted' ? (
              <span className="commit-subject"><em>Uncommitted changes</em></span>
            ) : (
              <>
                <code className="commit-sha">{shortSha(item.commit.sha)}</code>
                <span className="commit-subject">{item.commit.subject}</span>
                <span className="muted commit-meta">{item.commit.author_name} · {relativeTime(item.commit.authored_at)}</span>
              </>
            )}
          </button>
        ))}
      </div>
      <div className="popover-actions">
        <span className="muted">{count ? `${count} selected` : 'Nothing selected'}</span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!count} onClick={apply}>Show changes</button>
      </div>
    </div>
  );
}
