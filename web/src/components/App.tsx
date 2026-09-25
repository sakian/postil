import { useEffect, useMemo, useState } from 'react';
import { initToken, setToken } from '../api.ts';
import { subscribe } from '../events.ts';
import { markKey, viewedBlob } from '../format.ts';
import { handleKey, KEYMAP } from '../keyboard.ts';
import { useStore } from '../store.ts';
import { DiffPane } from './DiffPane.tsx';
import { FinishControls, useFinishable } from './Finish.tsx';
import { Header } from './Header.tsx';
import { Icon } from './icons.tsx';
import { SidePanel } from './Panels.tsx';
import { Sidebar } from './Sidebar.tsx';

function KeyHelp({ onClose }: { onClose(): void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>Keyboard shortcuts</h2>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)"><Icon name="close" /></button>
        </div>
        <table className="keymap">
          <tbody>
            {KEYMAP.map(([keys, what]) => (
              <tr key={keys}>
                <td>{keys.split(' / ').map((k, i) => <span key={k}>{i > 0 && ' / '}<kbd>{k}</kbd></span>)}</td>
                <td>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StaleBanner() {
  const stale = useStore((s) => s.stale);
  const resolving = useStore((s) => s.resolving);
  const { refresh } = useStore.getState();
  if (!stale) return null;
  return (
    <div className="banner">
      Files changed on disk since this diff was loaded. Your view stays put until you refresh.
      <button className="btn btn-small" disabled={resolving} onClick={() => void refresh()}><Icon name="refresh" size={14} /> Refresh</button>
    </div>
  );
}

/** Claude finished a review: offer what changed and its replies, until dismissed. */
function CompletedBanner() {
  const id = useStore((s) => s.completedReview);
  const { setScope, setPanel, dismissCompleted } = useStore.getState();
  if (id === null) return null;
  return (
    <div className="banner banner-done">
      <Icon name="check" size={16} />
      <span>Claude finished review #{id}.</span>
      <button className="btn btn-small" onClick={() => { void setScope({ kind: 'since_review', review_id: id }); setPanel('threads'); dismissCompleted(); }}>
        Show changes since review #{id}
      </button>
      <button className="btn btn-small" onClick={() => setPanel('threads')}>Open conversations</button>
      <span className="spacer" />
      <button className="icon-btn" onClick={dismissCompleted} title="Dismiss"><Icon name="close" size={14} /></button>
    </div>
  );
}

/** Every file viewed and nothing left open: offer to end the session cleanly. */
function FinishBanner() {
  const files = useStore((s) => s.resolved?.files);
  const viewed = useStore((s) => s.viewed);
  const finishable = useFinishable();
  const allViewed = useMemo(() => !!files?.length && files.every((f) => {
    const b = viewedBlob(f);
    return b !== null && viewed.has(markKey(f.path, b));
  }), [files, viewed]);
  if (!finishable || !allViewed) return null;
  return (
    <div className="banner banner-done">
      <Icon name="check" size={16} />
      <span>Every file is viewed and every conversation resolved.</span>
      <FinishControls />
    </div>
  );
}

const CONFETTI = ['#1f883d', '#0969da', '#d97757', '#bf8700', '#8250df', '#cf222e'];

function Finished() {
  const finished = useStore((s) => s.sessionFinished);
  const files = useStore((s) => s.resolved?.files.length ?? 0);
  const reviews = useStore((s) => s.reviews.filter((r) => r.status !== 'draft').length);
  const [open, setOpen] = useState(true);
  useEffect(() => { if (finished) setOpen(true); }, [finished]);
  if (!finished || !open) return null;
  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="confetti" aria-hidden>
        {Array.from({ length: 40 }, (_, i) => (
          <span key={i} style={{ left: `${(i * 37) % 100}%`, background: CONFETTI[i % CONFETTI.length], animationDelay: `${(i % 10) * 0.08}s` }} />
        ))}
      </div>
      <div className="modal finished" role="dialog" aria-label="Review finished" onClick={(e) => e.stopPropagation()}>
        <div className="finished-mark"><Icon name="check" size={32} /></div>
        <h2>Review complete</h2>
        <p className="muted">
          {files} file{files === 1 ? '' : 's'} reviewed{reviews ? ` over ${reviews} review${reviews === 1 ? '' : 's'}` : ''}. Every conversation is
          resolved and archived, and any listening Claude session has been told to wrap up.
        </p>
        <button className="btn btn-primary" onClick={() => setOpen(false)}>Done</button>
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const { dismiss } = useStore.getState();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.text}</span>
          {t.action && <button className="link-btn" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
          <button className="icon-btn" onClick={() => dismiss(t.id)} title="Dismiss"><Icon name="close" size={14} /></button>
        </div>
      ))}
    </div>
  );
}

function AuthHelp() {
  return (
    <div className="center-card">
      <h1>postil</h1>
      <p>This page needs the review server's access token.</p>
      <p>Open it with the link the server prints, or run this in the repository:</p>
      <pre>postil url</pre>
    </div>
  );
}

export function App() {
  const booted = useStore((s) => s.booted);
  const authFailed = useStore((s) => s.authFailed);

  useEffect(() => {
    const token = initToken();
    setToken(token);
    if (!token) {
      useStore.setState({ authFailed: true, booted: true });
      return;
    }
    void useStore.getState().boot();
    return subscribe(token, (e) => useStore.getState().handleEvent(e), (c) => useStore.getState().setConnected(c));
  }, []);

  const [help, setHelp] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (handleKey(e, setHelp)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (authFailed) return <AuthHelp />;
  if (!booted) return <div className="center-card muted">Loading…</div>;

  return (
    <div className="app">
      <Header />
      <div className="layout">
        <Sidebar />
        <main className="main">
          <StaleBanner />
          <CompletedBanner />
          <FinishBanner />
          <DiffPane />
        </main>
        <SidePanel />
      </div>
      <Toasts />
      <Finished />
      {help && <KeyHelp onClose={() => setHelp(false)} />}
    </div>
  );
}
