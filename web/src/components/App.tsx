import { useEffect, useMemo, useState } from 'react';
import { initToken, setToken } from '../api.ts';
import { subscribe } from '../events.ts';
import { isYourTurn, markKey, viewedBlob } from '../format.ts';
import { handleKey, KEYMAP } from '../keyboard.ts';
import { useStore } from '../store.ts';
import { DiffPane } from './DiffPane.tsx';
import { FinishControls, useFinishable } from './Finish.tsx';
import { Header } from './Header.tsx';
import { Icon } from './icons.tsx';
import { Markdown } from './Markdown.tsx';
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
  const summary = useStore((s) => s.reviews.find((r) => r.id === s.completedReview)?.summary);
  const yourTurn = useStore((s) => s.threads.filter(isYourTurn).length);
  const { setScope, setPanel, dismissCompleted } = useStore.getState();
  if (id === null) return null;
  return (
    <div className="banner banner-done banner-your-turn" role="status">
      <div className="your-turn-head">
        <Icon name="check" size={18} />
        <strong>Your turn. Claude finished review #{id}.</strong>
        {yourTurn > 0 && <span className="muted">{yourTurn} conversation{yourTurn === 1 ? '' : 's'} waiting on you</span>}
        <span className="spacer" />
        <button className="icon-btn" onClick={dismissCompleted} title="Dismiss"><Icon name="close" size={14} /></button>
      </div>
      {summary && (
        <div className="history-summary">
          <span className="avatar avatar-claude" aria-hidden>C</span>
          <Markdown text={summary} suggestionBase={null} />
        </div>
      )}
      <div className="your-turn-actions">
        <button className="btn btn-small btn-primary" onClick={() => { void setScope({ kind: 'since_review', review_id: id }); setPanel('threads'); dismissCompleted(); }}>
          Show changes since review #{id}
        </button>
        <button className="btn btn-small" onClick={() => setPanel('threads')}>Open conversations</button>
      </div>
    </div>
  );
}

const TITLE = document.title;
const ICON = document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href ?? '';
/** The usual icon with a green dot in the corner. */
const ICON_YOUR_TURN = ICON.replace(/%3C\/svg%3E$/, "%3Ccircle cx='12.5' cy='12.5' r='3.5' fill='%231f883d' stroke='white'/%3E%3C/svg%3E");

/** Show in the browser tab whether Claude is working or it is the user's turn, for when postil is in the background. */
function useTabStatus() {
  const completed = useStore((s) => s.completedReview);
  const working = useStore((s) => s.reviews.some((r) => r.status === 'in_progress'));
  const waiting = useStore((s) => s.reviews.some((r) => r.status === 'submitted'));
  const wrap = useWrapUp();
  const yourTurn = completed !== null && !working && !waiting;
  useEffect(() => {
    document.title = wrap === 'wrapping' ? `Claude is wrapping up… · ${TITLE}`
      : wrap === 'done' ? `✓ Finished, close this tab · ${TITLE}`
      : yourTurn ? `● Your turn · ${TITLE}` : working ? `Claude is working… · ${TITLE}` : TITLE;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link && ICON) link.href = yourTurn && !wrap ? ICON_YOUR_TURN : ICON;
  }, [yourTurn, working, wrap]);
}

/**
 * After the session is finished: Claude is still committing or pushing while it listens, and once
 * it stops listening there is nothing left for this tab to do. Null when no session is finished, or
 * the user has started a new review in this tab.
 */
function useWrapUp(): 'wrapping' | 'done' | null {
  const finished = useStore((s) => s.sessionFinished);
  const listening = useStore((s) => s.listening);
  const busyAgain = useStore((s) => (s.draft?.comment_count ?? 0) > 0 || s.threads.some((t) => t.status === 'open'));
  if (!finished || busyAgain) return null;
  return listening > 0 ? 'wrapping' : 'done';
}

/** Scripts may only close tabs they opened, so say so when the browser refuses. */
function CloseTab({ primary }: { primary?: boolean }) {
  const [refused, setRefused] = useState(false);
  const close = () => {
    window.close();
    setTimeout(() => setRefused(true), 300);
  };
  return refused
    ? <span className="muted">Your browser keeps this tab open; close it yourself ({navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'}+W).</span>
    : <button className={`btn${primary ? ' btn-primary' : ' btn-small'}`} onClick={close}>Close tab</button>;
}

/** The dialog is gone but the session is over: keep saying the tab can go. */
function WrapUpBanner() {
  const wrap = useWrapUp();
  if (!wrap) return null;
  return (
    <div className="banner banner-done" role="status">
      {wrap === 'wrapping'
        ? <><span className="pulse" /> <span>Review finished. Claude is wrapping up…</span></>
        : <><Icon name="check" size={16} /> <span>Review finished. You can close this tab.</span> <CloseTab /></>}
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
  const told = useStore((s) => s.listeningAtFinish > 0);
  const { commit, push, message } = useStore((s) => s.finishChoices);
  const wrap = useWrapUp();
  const [open, setOpen] = useState(true);
  useEffect(() => { if (finished) setOpen(true); }, [finished]);
  if (!finished || !open) return null;
  const doing = message.trim() ? 'following your instructions' : commit && push ? 'committing and pushing' : commit ? 'committing' : 'wrapping up';
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
          resolved and archived.
        </p>
        {wrap === 'wrapping' ? (
          <p className="finished-status"><span className="pulse" /> Claude is {doing}. This updates when it stops listening.</p>
        ) : (
          <p className="finished-status">
            <strong>{told ? 'Claude has wrapped up and stopped listening. ' : ''}You can close this tab.</strong>
          </p>
        )}
        <div className="finished-actions">
          {wrap !== 'wrapping' && <CloseTab primary />}
          <button className={`btn${wrap === 'wrapping' ? ' btn-primary' : ''}`} onClick={() => setOpen(false)}>Keep browsing</button>
        </div>
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

  useTabStatus();
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
        <div className="main-col">
          <CompletedBanner />
          <WrapUpBanner />
          <main className="main">
            <StaleBanner />
            <FinishBanner />
            <DiffPane />
          </main>
        </div>
        <SidePanel />
      </div>
      <Toasts />
      <Finished />
      {help && <KeyHelp onClose={() => setHelp(false)} />}
    </div>
  );
}
