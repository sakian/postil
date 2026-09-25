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

/** "Finish session", with what a listening Claude should commit and push as it wraps up. */
export function FinishControls() {
  const listening = useStore((s) => s.listening > 0);
  const { commit, push, message } = useStore((s) => s.finishChoices);
  const { finishSession, setFinishChoices } = useStore.getState();
  const [busy, setBusy] = useState(false);
  const setCommit = (v: boolean) => setFinishChoices({ commit: v });
  const setPush = (v: boolean) => setFinishChoices({ push: v });
  const setMessage = (v: string) => setFinishChoices({ message: v });
  const finish = () => {
    setBusy(true);
    void finishSession(listening ? { commit, push, message } : {}).finally(() => setBusy(false));
  };
  // Typed instructions replace the checkboxes.
  const custom = message.trim() !== '';
  return (
    <div className="finish-controls">
      {listening && (
        <>
          <label className={`option${custom ? ' disabled' : ''}`}>
            <input type="checkbox" checked={commit && !custom} disabled={custom} onChange={(e) => setCommit(e.target.checked)} /> Commit anything left
          </label>
          <label className={`option${custom ? ' disabled' : ''}`}>
            <input type="checkbox" checked={push && !custom} disabled={custom} onChange={(e) => setPush(e.target.checked)} /> and push
          </label>
          <textarea className="finish-message" rows={2} value={message} onChange={(e) => setMessage(e.target.value)}
            aria-label="Message to Claude" placeholder="Or tell Claude what to do instead (replaces the options above)" />
        </>
      )}
      <button className="btn btn-small btn-primary" disabled={busy} onClick={finish}>Finish session</button>
      <span className="muted">Archives the conversations{listening ? ' and tells Claude to wrap up' : ''}.</span>
    </div>
  );
}
