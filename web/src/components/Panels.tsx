import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import type { ThreadView } from '../../../src/core/api-types.ts';
import { isOutdated, isYourTurn, lineLabel, placement, relativeTime, snippet, threadFile } from '../format.ts';
import { askToNotify, useStore } from '../store.ts';
import { FinishControls, useFinishable } from './Finish.tsx';
import { Icon } from './icons.tsx';
import { Markdown } from './Markdown.tsx';
import { ThreadWidget } from './Thread.tsx';

type Filter = 'yours' | 'claude' | 'pending' | 'open' | 'outdated' | 'resolved' | 'all' | 'archived';

const FILTERS: Array<[Filter, string, (t: ThreadView) => boolean]> = [
  ['yours', 'Your turn', isYourTurn],
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
  const completed = useStore((s) => s.completedReview);
  // Claude's replies are what the user comes here for, once there are any.
  const [filter, setFilter] = useState<Filter>(() => (threads.some(isYourTurn) ? 'yours' : 'open'));
  useEffect(() => {
    if (completed !== null) setFilter('yours');
  }, [completed]);
  const { focus } = useStore.getState();

  const [archived, setArchived] = useState<ThreadView[] | null>(null);
  const { archiveResolved } = useStore.getState();
  useEffect(() => {
    if (filter === 'archived') void api.archivedThreads().then((r) => setArchived(r.threads), () => setArchived([]));
  }, [filter, threads]);

  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([k, , fn]) => [k, threads.filter(fn).length])), [threads]);
  const shown = filter === 'archived' ? (archived ?? []) : threads.filter(FILTERS.find(([k]) => k === filter)![2]);

  // Handling the conversation the user opened (replying, resolving) takes it out of the list; open the
  // one that moves up into its place, so working down the list takes no extra clicks.
  const active = useRef<number | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const ids = shown.map((t) => t.id);
  const before = useRef(ids);
  const idsKey = ids.join(',');
  useEffect(() => {
    const was = before.current;
    before.current = ids;
    const a = active.current;
    if (a === null || ids.includes(a) || !was.includes(a)) return;
    const after = was.slice(was.indexOf(a) + 1).find((id) => ids.includes(id)) ?? null;
    active.current = after;
    setNext(after);
  }, [idsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { active.current = null; }, [filter]);

  return (
    <>
      <div className="panel-filters">
        {FILTERS.map(([key, label]) => (
          <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>
            {label} <span className="muted">{counts[key]}</span>
          </button>
        ))}
        <button className={filter === 'archived' ? 'active' : ''} onClick={() => setFilter('archived')}>Archived</button>
      </div>
      {filter === 'resolved' && (counts.resolved ?? 0) > 0 && (
        <div className="panel-note">
          <button className="btn btn-small" onClick={() => void archiveResolved()}>Archive resolved ({counts.resolved})</button>
          <span className="muted">Hides them and the finished reviews, and lets git reclaim their snapshots.</span>
        </div>
      )}
      <div className="panel-list">
        {shown.length === 0 && <div className="empty muted">No conversations here.</div>}
        {shown.map((t) => {
          const where = placement(t, resolved ? threadFile(t, resolved.files) : undefined);
          return (
            <div key={t.id} className="panel-item">
              <ThreadWidget thread={t} showLocation defaultOpen={false} autoOpen={t.id === next}
                onToggle={(open) => { if (open) active.current = t.id; else if (active.current === t.id) active.current = null; }} />
              <div className="panel-item-actions">
                {where === 'elsewhere'
                  ? <span className="muted" title="This file is not part of the current view">Not in view</span>
                  : <button className="link-btn" onClick={() => focus(t.id)}>Show in diff</button>}
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
  const number = useStore((s) => s.draftNumber);
  const reviews = useStore((s) => s.reviews);
  const threads = useStore((s) => s.threads);
  const commitEach = useStore((s) => s.preferences.commit_each_review);
  const { setDraftBody, submit, focus, setPreferences, resetReviews } = useStore.getState();
  const [body, setBody] = useState(draft?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [writingOverall, setWritingOverall] = useState(false);
  const save = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => setBody((b) => (b === '' ? (draft?.body ?? '') : b)), [draft?.body]);

  const onBody = (value: string) => {
    setBody(value);
    clearTimeout(save.current);
    save.current = setTimeout(() => void setDraftBody(value), 500);
  };

  const pendingThreads = threads.filter((t) => t.comments.some((c) => c.draft));
  const pendingCount = draft?.comment_count ?? 0;
  const nothingToSend = pendingCount === 0 && body.trim() === '';
  const canSubmit = !nothingToSend && !busy;
  const finishable = useFinishable();
  const history = reviews.filter((r) => r.status !== 'draft').sort((a, b) => b.id - a.id);

  const doSubmit = async () => {
    askToNotify();
    setBusy(true);
    clearTimeout(save.current);
    try {
      await submit(body);
      setBody('');
      setWritingOverall(false);
    } catch {
      /* reported by the store */
    } finally {
      setBusy(false);
    }
  };

  // The overall comment is rarely needed, so it waits behind a link unless it has text.
  const overall = writingOverall || body.trim() !== '';
  const overallLink = (label: string) => <button className="link-btn" onClick={() => setWritingOverall(true)}>{label}</button>;

  return (
    <div className="review-panel">
      {nothingToSend && finishable && !overall ? (
        <section>
          <h3>Finish the session</h3>
          <p className="muted">Nothing to send Claude. If the changes look right, finish the session.</p>
          <FinishControls />
          <p className="muted">Or {overallLink('send Claude a comment')} to keep going.</p>
        </section>
      ) : (
        <section>
          <h3>Your review{number !== null && ` #${number}`}</h3>
          <p className="muted">
            {pendingCount === 0
              ? <>No pending comments. Comment on the code, or {overallLink('add an overall comment')}.</>
              : `${pendingCount} pending comment${pendingCount === 1 ? '' : 's'}. Claude sees nothing until you submit.`}
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
          {overall ? (
            <>
              <textarea value={body} onChange={(e) => onBody(e.target.value)} rows={4} autoFocus={writingOverall}
                placeholder="Overall comment for this review" />
              <button className="link-btn" onClick={() => { onBody(''); setWritingOverall(false); }}>Remove overall comment</button>
            </>
          ) : pendingCount > 0 && <p>{overallLink('Add an overall comment')}</p>}
          {!nothingToSend && (
            <>
              <label className="option" title="Claude commits what it changes for each review, one logical change per commit, and leaves pushing to you">
                <input type="checkbox" checked={commitEach} onChange={(e) => void setPreferences({ commit_each_review: e.target.checked })} />
                Claude commits its changes after each review (never pushes)
              </label>
              <button className="btn btn-primary btn-block" disabled={!canSubmit} onClick={() => void doSubmit()}>
                {busy ? 'Submitting…' : 'Submit review'}
              </button>
            </>
          )}
        </section>
      )}
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
      {(threads.length > 0 || pendingCount > 0 || history.length > 0) && (
        <section className="start-over">
          <h3>Start over</h3>
          <p className="muted">
            Archives every conversation and review, deletes unsent comments, clears viewed marks, and tells Claude to drop
            whatever it is working on.
          </p>
          <button className="btn btn-small" onClick={() => {
            if (window.confirm('Discard this review and start over? Unsent comments are deleted; everything else moves to Archived.')) {
              clearTimeout(save.current);
              void resetReviews().then(() => setBody(''));
            }
          }}>Discard review…</button>
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
