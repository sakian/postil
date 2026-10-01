import { useState } from 'react';
import { useStore } from '../store.ts';

/** Nothing is left for either side: no open conversation, unsent comment or review Claude is still on. */
export function useFinishable(): boolean {
  const threads = useStore((s) => s.threads);
  const draft = useStore((s) => s.draft);
  const reviews = useStore((s) => s.reviews);
  const finished = useStore((s) => s.sessionFinished);
  return !finished && threads.every((t) => t.status === 'resolved') && !draft?.comment_count &&
    !reviews.some((r) => r.status === 'submitted' || r.status === 'in_progress');
}

/**
 * After the session is finished: Claude is still committing or pushing while it listens, and once
 * it stops listening there is nothing left for this tab to do. Null when no session is finished, or
 * the user has started a new review in this tab.
 */
export function useWrapUp(): 'wrapping' | 'done' | null {
  const finished = useStore((s) => s.sessionFinished);
  const listening = useStore((s) => s.listening);
  const busyAgain = useStore((s) => (s.draft?.comment_count ?? 0) > 0 || s.threads.some((t) => t.status === 'open'));
  if (!finished || busyAgain) return null;
  return listening > 0 ? 'wrapping' : 'done';
}

/** Scripts may only close tabs they opened, so say so when the browser refuses. */
export function CloseTab({ primary, small }: { primary?: boolean; small?: boolean }) {
  const [refused, setRefused] = useState(false);
  const close = () => {
    window.close();
    setTimeout(() => setRefused(true), 300);
  };
  const keys = `${navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'}+W`;
  return refused
    ? <span className="muted">Your browser keeps this tab open; close it yourself ({keys}).</span>
    : <button className={`btn${primary ? ' btn-primary' : ''}${small ? ' btn-small' : ''}`} onClick={close}>Close tab</button>;
}

/** "Finish session", with what a listening Claude should commit and push as it wraps up, or the user's own words. */
export function FinishControls() {
  const listening = useStore((s) => s.listening > 0);
  const { commit, push, message } = useStore((s) => s.finishChoices);
  const { finishSession, setFinishChoices } = useStore.getState();
  const [busy, setBusy] = useState(false);
  // Typed instructions replace the checkboxes, so only one of the two shows at a time.
  const [custom, setCustom] = useState(message.trim() !== '');
  const finish = () => {
    setBusy(true);
    const choices = custom ? { message } : { commit, push };
    void finishSession(listening ? choices : {}).finally(() => setBusy(false));
  };
  return (
    <div className="finish-controls">
      {listening && (custom ? (
        <>
          <textarea className="finish-message" rows={2} value={message} autoFocus onChange={(e) => setFinishChoices({ message: e.target.value })}
            aria-label="Message to Claude" placeholder="What Claude should do as it wraps up" />
          <button className="link-btn" onClick={() => { setFinishChoices({ message: '' }); setCustom(false); }}>Commit and push options</button>
        </>
      ) : (
        <>
          <label className="option">
            <input type="checkbox" checked={commit} onChange={(e) => setFinishChoices({ commit: e.target.checked })} /> Commit anything left
          </label>
          <label className="option">
            <input type="checkbox" checked={push} onChange={(e) => setFinishChoices({ push: e.target.checked })} /> and push
          </label>
          <button className="link-btn" onClick={() => setCustom(true)}>Tell Claude something else…</button>
        </>
      ))}
      <div className="finish-go">
        <button className="btn btn-small btn-primary" disabled={busy || (listening && custom && !message.trim())} onClick={finish}>Finish session</button>
        <span className="muted">Archives the conversations{listening ? ' and tells Claude to wrap up' : ''}.</span>
      </div>
    </div>
  );
}
