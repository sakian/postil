import type { Scope } from '../../../src/core/api-types.ts';
import { basename } from '../format.ts';
import { useStore } from '../store.ts';

function scopeValue(scope: Scope): string {
  return scope.kind === 'since_review' ? `since_review:${scope.review_id ?? 'latest'}` : scope.kind;
}

function ScopePicker() {
  const scope = useStore((s) => s.scope);
  const reviews = useStore((s) => s.reviews);
  const { setScope } = useStore.getState();
  const submitted = reviews.filter((r) => r.status !== 'draft').sort((a, b) => b.id - a.id);
  const latest = submitted[0];

  const onChange = (value: string) => {
    if (value === 'all' || value === 'uncommitted') void setScope({ kind: value });
    else if (value.startsWith('since_review:')) {
      const id = value.split(':')[1];
      void setScope(id === 'latest' ? { kind: 'since_review' } : { kind: 'since_review', review_id: Number(id) });
    }
  };

  const current = scopeValue(scope);
  const options: Array<[string, string, boolean?]> = [
    ['all', 'All changes'],
    ['uncommitted', 'Uncommitted changes'],
    ['since_review:latest', latest ? `Changes since last review (#${latest.id})` : 'Changes since last review', !latest],
    ...submitted.slice(1, 6).map((r): [string, string] => [`since_review:${r.id}`, `Changes since review #${r.id}`]),
  ];
  if (!options.some(([v]) => v === current)) options.push([current, `Changes since review #${scope.kind === 'since_review' ? scope.review_id : ''}`]);

  return (
    <label className="scope-picker">
      <span className="sr-only">Changes to show</span>
      <select value={current} onChange={(e) => onChange(e.target.value)}>
        {options.map(([value, label, disabled]) => <option key={value} value={value} disabled={disabled}>{label}</option>)}
      </select>
    </label>
  );
}

function ClaudeStatus() {
  const reviews = useStore((s) => s.reviews);
  const working = reviews.find((r) => r.status === 'in_progress');
  const waiting = reviews.filter((r) => r.status === 'submitted');
  if (working) {
    return <span className="claude-status working" title="Claude has picked up this review"><span className="pulse" /> Claude is working on #{working.id}</span>;
  }
  if (waiting.length) {
    return (
      <span className="claude-status waiting" title="Submitted, but no Claude session has fetched it yet. Is a session watching this repository?">
        Waiting for Claude: {waiting.map((r) => `#${r.id}`).join(', ')}
      </span>
    );
  }
  return null;
}

export function Header() {
  const health = useStore((s) => s.health);
  const view = useStore((s) => s.view);
  const connected = useStore((s) => s.connected);
  const draft = useStore((s) => s.draft);
  const panel = useStore((s) => s.panel);
  const threads = useStore((s) => s.threads);
  const { setView, setPanel } = useStore.getState();
  const yourTurn = threads.filter((t) => t.status === 'open' && t.awaiting === 'user').length;
  const pending = draft?.comment_count ?? 0;

  return (
    <header className="topbar">
      <span className="brand">postil</span>
      <span className="repo" title={health?.root}>{health ? basename(health.root) : ''}</span>
      <ScopePicker />
      <ClaudeStatus />
      <span className="spacer" />
      <div className="segmented" role="group" aria-label="Diff layout (press S to toggle)">
        <button className={view === 'unified' ? 'active' : ''} onClick={() => setView('unified')} title="Unified view (S)">Unified</button>
        <button className={view === 'split' ? 'active' : ''} onClick={() => setView('split')} title="Split view (S)">Split</button>
      </div>
      <button className={`btn${panel === 'threads' ? ' active' : ''}`} onClick={() => setPanel(panel === 'threads' ? null : 'threads')}>
        Conversations{yourTurn > 0 && <span className="count">{yourTurn}</span>}
      </button>
      <button className={`btn btn-primary${panel === 'review' ? ' active' : ''}`} onClick={() => setPanel(panel === 'review' ? null : 'review')}>
        Finish review{pending > 0 && <span className="count">{pending}</span>}
      </button>
      <span className={`conn ${connected ? 'on' : 'off'}`} title={connected ? 'Live updates connected' : 'Reconnecting to the postil server…'} />
    </header>
  );
}
