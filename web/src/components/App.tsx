import { useEffect } from 'react';
import { initToken, setToken } from '../api.ts';
import { subscribe } from '../events.ts';
import { useStore } from '../store.ts';
import { DiffPane } from './DiffPane.tsx';
import { Header } from './Header.tsx';
import { Icon } from './icons.tsx';
import { SidePanel } from './Panels.tsx';
import { Sidebar } from './Sidebar.tsx';

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useStore.getState();
      if (e.key === 's' || e.key === 'S') s.setView(s.view === 'split' ? 'unified' : 'split');
      else if (e.key === 'Escape') {
        if (s.composer) s.openComposer(null);
        else if (s.panel) s.setPanel(null);
        else s.select(null);
      }
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
          <DiffPane />
        </main>
        <SidePanel />
      </div>
      <Toasts />
    </div>
  );
}
