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
    void finishSession(listening ? { commit, push, message: commit ? message : undefined } : {}).finally(() => setBusy(false));
  };
  return (
    <div className="finish-controls">
      {listening && (
        <>
          <label className="option"><input type="checkbox" checked={commit} onChange={(e) => setCommit(e.target.checked)} /> Commit anything left</label>
          <label className="option"><input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} /> and push</label>
          {commit && (
            <textarea className="finish-message" rows={2} value={message} onChange={(e) => setMessage(e.target.value)}
              aria-label="Commit message" placeholder="Commit message (optional: leave blank and Claude writes its own, one commit per change)" />
          )}
        </>
      )}
      <button className="btn btn-small btn-primary" disabled={busy} onClick={finish}>Finish session</button>
      <span className="muted">Archives the conversations{listening ? ' and tells Claude to wrap up' : ''}.</span>
    </div>
  );
}
