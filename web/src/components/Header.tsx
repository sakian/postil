import { useEffect, useState } from 'react';
import type { Scope } from '../../../src/core/api-types.ts';
import { api } from '../api.ts';
import { basename, isYourTurn, shortSha } from '../format.ts';
import { useStore } from '../store.ts';
import { CommitPicker } from './CommitPicker.tsx';

function scopeValue(scope: Scope): string {
  if (scope.kind === 'since_review') return `since_review:${scope.review_id ?? 'latest'}`;
  if (scope.kind === 'commits') return 'commits';
  return scope.kind;
}

function commitsLabel(scope: Extract<Scope, { kind: 'commits' }>): string {
  const to = scope.to === 'worktree' ? 'uncommitted' : shortSha(scope.to);
  return scope.from === scope.to ? `Commit ${shortSha(scope.from)}` : `Commits ${shortSha(scope.from)} … ${to}`;
}

function ScopePicker() {
  const scope = useStore((s) => s.scope);
  const reviews = useStore((s) => s.reviews);
  const { setScope } = useStore.getState();
  const [picking, setPicking] = useState(false);
  const submitted = reviews.filter((r) => r.status !== 'draft').sort((a, b) => b.id - a.id);
  const latest = submitted[0];

  const onChange = (value: string) => {
    if (value === 'pick') setPicking(true);
    else if (value === 'all' || value === 'uncommitted') void setScope({ kind: value });
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
  if (scope.kind === 'commits') options.push(['commits', commitsLabel(scope)]);
  else if (!options.some(([v]) => v === current)) options.push([current, `Changes since review #${scope.kind === 'since_review' ? scope.review_id : ''}`]);
  options.push(['pick', 'Choose commits…']);

  return (
    <span className="scope-wrap">
      <label className="scope-picker">
        <span className="sr-only">Changes to show</span>
        <select value={current} onChange={(e) => onChange(e.target.value)}>
          {options.map(([value, label, disabled]) => <option key={value} value={value} disabled={disabled}>{label}</option>)}
        </select>
      </label>
      {picking && <CommitPicker onClose={() => setPicking(false)} />}
    </span>
  );
}

const DEFAULT_BASE = ' default';
const FIXED_BASE = ' fixed';

/** The branch "all changes" is measured from: a fallback for when the default guessed wrong. */
function BasePicker() {
  const base = useStore((s) => s.base);
  const { setBaseBranch } = useStore.getState();
  const [branches, setBranches] = useState<string[]>([]);
  const load = () => void api.branches().then((b) => setBranches(b.branches), () => {});
  useEffect(load, []);
  if (!base) return null;

  const current = base.config.mode === 'merge-base' ? base.config.target : FIXED_BASE;
  const names = current !== FIXED_BASE && !branches.includes(current) ? [current, ...branches] : branches;
  const onChange = (value: string) => {
    if (value !== FIXED_BASE) void setBaseBranch(value === DEFAULT_BASE ? null : value);
  };

  return (
    <label className="base-picker" title={`Measured from the ${base.label}${base.warning ? ` (${base.warning})` : ''}`}>
      <span className="muted">compared to</span>
      <select value={current} onChange={(e) => onChange(e.target.value)} onFocus={load}>
        <option value={DEFAULT_BASE}>default</option>
        {current === FIXED_BASE && <option value={FIXED_BASE}>{base.commit ? `commit ${shortSha(base.commit)}` : 'nothing (every file)'}</option>}
        {names.map((b) => <option key={b} value={b}>{b}</option>)}
      </select>
    </label>
  );
}

function ClaudeStatus() {
  const reviews = useStore((s) => s.reviews);
  const listening = useStore((s) => s.listening);
  const completed = useStore((s) => s.completedReview);
  const { setPanel } = useStore.getState();
  const working = reviews.find((r) => r.status === 'in_progress');
  const waiting = reviews.filter((r) => r.status === 'submitted');
  if (completed !== null && !working && !waiting.length) {
    return (
      <button className="claude-status your-turn" title="Claude is done with your review. Open its replies." onClick={() => setPanel('threads')}>
        <span className="dot" /> Your turn: Claude finished #{completed}
      </button>
    );
  }
  if (working) {
    return <span className="claude-status working" title="Claude has picked up this review"><span className="pulse" /> Claude is working on #{working.id}</span>;
  }
  if (waiting.length) {
    return (
      <span className="claude-status waiting" title={listening ? 'Submitted; a listening Claude session will pick it up.' : 'No Claude session is listening. Run /postil:review in Claude Code.'}>
        Waiting for Claude: {waiting.map((r) => `#${r.id}`).join(', ')}{!listening && ' (not listening)'}
      </span>
    );
  }
  return listening ? (
    <span className="claude-status listening" title="A Claude Code session will pick up your review as soon as you submit it">
      <span className="dot" /> Claude is listening
    </span>
  ) : (
    <span className="claude-status idle" title="Run /postil:review in Claude Code so submitted reviews are picked up automatically">
      Claude is not listening
    </span>
  );
}

export function Header() {
  const health = useStore((s) => s.health);
  const scopeKind = useStore((s) => s.scope.kind);
  const view = useStore((s) => s.view);
  const connected = useStore((s) => s.connected);
  const draft = useStore((s) => s.draft);
  const panel = useStore((s) => s.panel);
  const threads = useStore((s) => s.threads);
  const { setView, setPanel } = useStore.getState();
  const yourTurn = threads.filter(isYourTurn).length;
  const pending = draft?.comment_count ?? 0;

  return (
    <header className="topbar">
      <span className="brand">postil</span>
      <span className="repo" title={health?.root}>{health ? basename(health.root) : ''}</span>
      <ScopePicker />
      {scopeKind === 'all' && <BasePicker />}
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
      <button className="icon-btn help-btn" title="Keyboard shortcuts (?)" onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }))}>?</button>
      <span className={`conn ${connected ? 'on' : 'off'}`} title={connected ? 'Live updates connected' : 'Reconnecting to the postil server…'} />
    </header>
  );
}
