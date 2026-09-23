import { useEffect, useMemo, useRef, useState } from 'react';
import type { ThreadView } from '../../../src/core/api-types.ts';
import { isOutdated, lineLabel, placement, relativeTime, snippet, threadFile, threadPath } from '../format.ts';
import { useStore } from '../store.ts';
import { Icon } from './icons.tsx';
import { Markdown } from './Markdown.tsx';
import { StatusChips, ThreadWidget } from './Thread.tsx';

type Filter = 'yours' | 'claude' | 'pending' | 'open' | 'outdated' | 'resolved' | 'all';

const FILTERS: Array<[Filter, string, (t: ThreadView) => boolean]> = [
  ['yours', 'Your turn', (t) => t.status === 'open' && t.awaiting === 'user'],
  ['claude', 'Waiting for Claude', (t) => t.status === 'open' && t.awaiting === 'claude'],
  ['pending', 'Pending', (t) => t.comments.some((c) => c.draft)],
  ['open', 'Open', (t) => t.status === 'open'],
  ['outdated', 'Outdated', (t) => t.status === 'open' && isOutdated(t)],
  ['resolved', 'Resolved', (t) => t.status === 'resolved'],
  ['all', 'All', () => true],
];

function ThreadsPanel() {
  const threads = useStore((s) => s.threads);
  const resolved = useStore((s) => s.resolved);
  const [filter, setFilter] = useState<Filter>('open');
  const [expanded, setExpanded] = useState<number | null>(null);
  const { focus } = useStore.getState();

  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([k, , fn]) => [k, threads.filter(fn).length])), [threads]);
  const shown = threads.filter(FILTERS.find(([k]) => k === filter)![2]);

  return (
    <>
      <div className="panel-filters">
        {FILTERS.map(([key, label]) => (
          <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>
            {label} <span className="muted">{counts[key]}</span>
          </button>
        ))}
      </div>
      <div className="panel-list">
        {shown.length === 0 && <div className="empty muted">No conversations here.</div>}
        {shown.map((t) => {
          const where = placement(t, resolved ? threadFile(t, resolved.files) : undefined);
          const last = t.comments.at(-1);
          const isOpen = expanded === t.id;
          return (
            <div key={t.id} className="panel-item">
              {isOpen ? (
                <ThreadWidget thread={t} showLocation />
              ) : (
                <button className="panel-item-summary" onClick={() => setExpanded(t.id)}>
                  <div className="panel-item-head">
                    <code>{threadPath(t)}:{lineLabel(t)}</code>
                    {where === 'elsewhere' && <span className="chip" title="This file is not part of the current view">Not in view</span>}
                    <StatusChips thread={t} />
                  </div>
                  {last && (
                    <div className="panel-item-last">
                      <strong>{last.author === 'claude' ? 'Claude' : 'You'}:</strong> {snippet(last.body)}
                    </div>
                  )}
                </button>
              )}
              <div className="panel-item-actions">
                {isOpen && <button className="link-btn" onClick={() => setExpanded(null)}>Collapse</button>}
                {where !== 'elsewhere' && <button className="link-btn" onClick={() => focus(t.id)}>Show in diff</button>}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function ReviewPanel() {
  const draft = useStore((s) => s.draft);
  const reviews = useStore((s) => s.reviews);
  const threads = useStore((s) => s.threads);
  const { setDraftBody, submit, focus } = useStore.getState();
  const [body, setBody] = useState(draft?.body ?? '');
  const [busy, setBusy] = useState(false);
  const save = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => setBody((b) => (b === '' ? (draft?.body ?? '') : b)), [draft?.body]);

  const onBody = (value: string) => {
    setBody(value);
    clearTimeout(save.current);
    save.current = setTimeout(() => void setDraftBody(value), 500);
  };

  const pendingThreads = threads.filter((t) => t.comments.some((c) => c.draft));
  const pendingCount = draft?.comment_count ?? 0;
  const canSubmit = (pendingCount > 0 || body.trim() !== '') && !busy;
  const history = reviews.filter((r) => r.status !== 'draft').sort((a, b) => b.id - a.id);

  const doSubmit = async () => {
    setBusy(true);
    clearTimeout(save.current);
    try {
      await submit(body);
      setBody('');
    } catch {
      /* reported by the store */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="review-panel">
      <section>
        <h3>Your review</h3>
        <p className="muted">
          {pendingCount === 0 ? 'No pending comments.' : `${pendingCount} pending comment${pendingCount === 1 ? '' : 's'}`} Claude sees
          nothing until you submit.
        </p>
        {pendingThreads.length > 0 && (
          <ul className="pending-list">
            {pendingThreads.map((t) => (
              <li key={t.id}>
                <button className="link-btn" onClick={() => focus(t.id)}>{t.path}:{lineLabel(t)}</button>
                <span className="muted"> {snippet(t.comments.find((c) => c.draft)?.body ?? '', 80)}</span>
              </li>
            ))}
          </ul>
        )}
        <textarea value={body} onChange={(e) => onBody(e.target.value)} rows={4} placeholder="Overall comment for this review (optional)" />
        <button className="btn btn-primary btn-block" disabled={!canSubmit} onClick={() => void doSubmit()}>
          {busy ? 'Submitting…' : 'Submit review'}
        </button>
      </section>
      {history.length > 0 && (
        <section>
          <h3>Previous reviews</h3>
          {history.map((r) => (
            <div key={r.id} className="history-item">
              <div className="history-head">
                <strong>#{r.id}</strong>
                <span className={`chip chip-status-${r.status}`}>{r.status.replace('_', ' ')}</span>
                <span className="muted">{relativeTime(r.submitted_at)}</span>
                <span className="muted">{r.thread_ids.length} conversation{r.thread_ids.length === 1 ? '' : 's'}</span>
              </div>
              {r.body && <div className="history-body"><Markdown text={r.body} suggestionBase={null} /></div>}
              {r.summary && (
                <div className="history-summary">
                  <span className="avatar avatar-claude" aria-hidden>C</span>
                  <Markdown text={r.summary} suggestionBase={null} />
                </div>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

export function SidePanel() {
  const panel = useStore((s) => s.panel);
  const { setPanel } = useStore.getState();
  if (!panel) return null;
  return (
    <aside className="side-panel" aria-label={panel === 'threads' ? 'Conversations' : 'Finish review'}>
      <div className="panel-head">
        <h2>{panel === 'threads' ? 'Conversations' : 'Finish your review'}</h2>
        <button className="icon-btn" onClick={() => setPanel(null)} title="Close (Esc)"><Icon name="close" /></button>
      </div>
      {panel === 'threads' ? <ThreadsPanel /> : <ReviewPanel />}
    </aside>
  );
}
