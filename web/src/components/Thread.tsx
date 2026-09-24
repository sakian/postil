import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { CommentView, FileChange, ThreadView } from '../../../src/core/api-types.ts';
import { currentLines, isOutdated, isYourTurn, lineLabel, relativeTime, sidePath, snippet } from '../format.ts';
import { lineDiff } from '../lib/linediff.ts';
import { newThreadKey, useStore, type Target, type ThreadTarget } from '../store.ts';
import { ThreadDiff } from './ThreadDiff.tsx';
import { Icon } from './icons.tsx';
import { Markdown, type ApplyState } from './Markdown.tsx';

// ---------------------------------------------------------------------------- composer

interface ComposerProps {
  /** Identifies this composer's unsent text in the store, e.g. `reply:12`. */
  draftKey: string;
  initial?: string;
  placeholder: string;
  submitLabel: string;
  /** Text of the anchored lines; enables "Suggest change". */
  seed?: string | null;
  autoFocus?: boolean;
  onSubmit(body: string): Promise<void>;
  onCancel?(): void;
  /** Bring the composer back after "Undo" on a discarded comment. */
  onRestore?(): void;
}

export function Composer({ draftKey, initial = '', placeholder, submitLabel, seed, autoFocus, onSubmit, onCancel, onRestore }: ComposerProps) {
  const stored = useStore((s) => s.composerText[draftKey]);
  const { setComposerText } = useStore.getState();
  const body = stored ?? initial;
  const setBody = (next: string | ((prev: string) => string)) =>
    setComposerText(draftKey, typeof next === 'function' ? next(useStore.getState().composerText[draftKey] ?? initial) : next);
  // Discarding written text is easy to do by accident (Esc, Cancel), so it can be undone.
  const cancel = onCancel && (() => {
    const text = useStore.getState().composerText[draftKey];
    setComposerText(draftKey, null);
    onCancel();
    if (text?.trim() && text !== initial) {
      useStore.getState().toast('Discarded your unsent comment.', {
        label: 'Undo', run: () => { setComposerText(draftKey, text); onRestore?.(); },
      });
    }
  });
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(body);
      setComposerText(draftKey, null);
      setPreview(false);
    } catch {
      /* the store already reported it; keep the text so nothing is lost */
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape' && cancel) {
      e.preventDefault();
      cancel();
    }
  };

  const insertSuggestion = () => {
    if (seed == null) return;
    const block = `\`\`\`suggestion\n${seed}\n\`\`\`\n`;
    setBody((b) => (b && !b.endsWith('\n') ? `${b}\n${block}` : `${b}${block}`));
    setPreview(false);
    setTimeout(() => ref.current?.focus(), 0);
  };

  return (
    <div className="composer">
      <div className="composer-tabs">
        <button className={preview ? '' : 'active'} onClick={() => setPreview(false)}>Write</button>
        <button className={preview ? 'active' : ''} onClick={() => setPreview(true)}>Preview</button>
        <span className="spacer" />
        {seed != null && (
          <button className="link-btn" onClick={insertSuggestion} title="Propose replacement code for the selected lines">
            Suggest change
          </button>
        )}
      </div>
      {preview ? (
        <div className="composer-preview">{body.trim() ? <Markdown text={body} suggestionBase={seed ?? null} /> : <em>Nothing to preview</em>}</div>
      ) : (
        <textarea ref={ref} value={body} placeholder={placeholder} onChange={(e) => setBody(e.target.value)} onKeyDown={onKey}
          rows={Math.min(14, Math.max(3, body.split('\n').length + 1))} />
      )}
      <div className="composer-actions">
        <span className="hint">Markdown supported. Ctrl+Enter to save.</span>
        {cancel && <button className="btn" onClick={cancel}>Cancel</button>}
        <button className="btn btn-primary" disabled={!body.trim() || busy} onClick={() => void submit()}>{submitLabel}</button>
      </div>
    </div>
  );
}

export function NewThreadComposer({ target, seed }: { target: Target; seed: string | null }) {
  const { createThread, openComposer } = useStore.getState();
  const label = target.start === target.end ? `line ${target.start}` : `lines ${target.start}–${target.end}`;
  return (
    <div className="thread thread-new">
      <div className="thread-head">
        <span className="muted">Comment on {target.side === 'old' ? 'removed ' : ''}{label}</span>
      </div>
      <Composer draftKey={newThreadKey(target)} autoFocus placeholder="Leave a comment" submitLabel="Add review comment" seed={seed}
        onSubmit={(body) => createThread(target, body)} onCancel={() => openComposer(null)} onRestore={() => openComposer(target)} />
    </div>
  );
}

/** A comment on a whole file rather than on some of its lines. */
export function FileComposer({ file }: { file: FileChange }) {
  const { createThread, openFileComposer } = useStore.getState();
  const side = file.new_blob ? 'new' : 'old';
  const target: ThreadTarget = { path: file.path, sidePath: sidePath(file, side), side, start: null, end: null };
  return (
    <div className="thread thread-new">
      <div className="thread-head"><span className="muted">Comment on the whole file</span></div>
      <Composer draftKey={newThreadKey(target)} autoFocus placeholder="Leave a comment about this file" submitLabel="Add review comment"
        onSubmit={(body) => createThread(target, body)} onCancel={() => openFileComposer(null)} onRestore={() => openFileComposer(file.path)} />
    </div>
  );
}

// ---------------------------------------------------------------------------- comments

/** Whether a comment's suggestion can be written into the working tree right now. */
function applyState(comment: CommentView, thread: ThreadView, run: () => Promise<void>): ApplyState | undefined {
  if (thread.side !== 'new' || thread.start_line === null) return undefined;
  if (comment.applied_at) return { state: 'applied', run };
  if (!thread.anchor) return { state: 'blocked', reason: 'Reload the diff to check whether this can still be applied', run };
  if (thread.anchor.state === 'outdated' || thread.anchor.state === 'gone') {
    return { state: 'blocked', reason: 'The lines this replaces have changed since it was suggested', run };
  }
  return { state: 'ready', run };
}

function Comment({ comment, thread }: { comment: CommentView; thread: ThreadView }) {
  const [editingNow, setEditing] = useState(false);
  const editing = useStore((s) => s.composerText[`edit:${comment.id}`] !== undefined) || editingNow;
  const { editComment, deleteComment, applySuggestion } = useStore.getState();
  const who = comment.author === 'claude' ? 'Claude' : 'You';
  const suggestionBase = thread.side === 'new' && thread.start_line !== null ? thread.anchor_text : null;
  const apply = applyState(comment, thread, () => applySuggestion(comment.id));

  return (
    <div className={`comment comment-${comment.author}`}>
      <div className="comment-head">
        <span className={`avatar avatar-${comment.author}`} aria-hidden>{who[0]}</span>
        <strong>{who}</strong>
        <span className="muted" title={comment.created_at}>{relativeTime(comment.created_at)}</span>
        {comment.draft && <span className="chip chip-pending">Pending</span>}
        <span className="spacer" />
        {comment.draft && !editing && (
          <>
            <button className="link-btn" onClick={() => setEditing(true)}>Edit</button>
            <button className="link-btn danger" onClick={() => void deleteComment(comment.id)}>Delete</button>
          </>
        )}
      </div>
      {editing ? (
        <Composer draftKey={`edit:${comment.id}`} initial={comment.body} autoFocus placeholder="Edit comment" submitLabel="Update comment"
          seed={suggestionBase} onSubmit={async (b) => { await editComment(comment.id, b); setEditing(false); }}
          onCancel={() => setEditing(false)} onRestore={() => setEditing(true)} />
      ) : (
        <div className="comment-body"><Markdown text={comment.body} suggestionBase={suggestionBase} apply={apply} /></div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- thread

export function StatusChips({ thread }: { thread: ThreadView }) {
  return (
    <>
      {thread.anchor?.state === 'outdated' && <span className="chip chip-outdated" title="The code this comment refers to has changed">Outdated</span>}
      {thread.anchor?.state === 'gone' && <span className="chip chip-outdated" title="The code this comment refers to no longer exists">Code removed</span>}
      {!thread.published && <span className="chip chip-pending">Pending</span>}
      {thread.status === 'resolved' && <span className="chip chip-resolved">Resolved</span>}
      {thread.needs_decision && isYourTurn(thread) && <span className="chip chip-decision">Needs your decision</span>}
      {thread.awaiting === 'claude' && <span className="chip chip-claude">Waiting for Claude</span>}
      {isYourTurn(thread) && !thread.needs_decision && <span className="chip chip-you">Your turn</span>}
    </>
  );
}

/** The anchored lines when the comment was written, against the same place now. */
function WhatChanged({ before, after }: { before: string; after: string }) {
  const ops = lineDiff(before === '' ? [] : before.split('\n'), after === '' ? [] : after.split('\n'));
  return (
    <div className="what-changed">
      <div className="what-changed-title">Since this comment was written</div>
      <table className="diff diff-unified">
        <tbody>
          {ops.map((o, i) => (
            <tr key={i} className={`line ${o.kind}`}>
              <td className="marker">{o.kind === 'add' ? '+' : o.kind === 'del' ? '-' : ' '}</td>
              <td className="code"><span className="code-text">{o.text}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ThreadWidget({ thread, showLocation = false, defaultOpen }: {
  thread: ThreadView;
  /** Show the file and lines in the head, and offer the original and current diff (the conversations list). */
  showLocation?: boolean;
  /** Start expanded or not; by default open unless resolved. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? thread.status !== 'resolved');
  const replyKey = `reply:${thread.id}`;
  const [replyingNow, setReplying] = useState(false);
  // Unsent reply text keeps the composer open, across remounts and after "Undo".
  const replying = useStore((s) => s.composerText[replyKey] !== undefined) || replyingNow;
  const [showChange, setShowChange] = useState(false);
  const [diffView, setDiffView] = useState<'original' | 'current' | null>(null);
  const outdated = isOutdated(thread);
  const moved = thread.anchor?.state === 'moved';
  const focused = useStore((s) => s.focusThread === thread.id);
  const { reply, setResolved, focus } = useStore.getState();
  const ref = useRef<HTMLDivElement>(null);
  const last = thread.comments.at(-1);

  useEffect(() => setOpen(defaultOpen ?? thread.status !== 'resolved'), [thread.status, defaultOpen]);
  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const t = setTimeout(() => focus(null), 1600);
    return () => clearTimeout(t);
  }, [focused, focus]);

  return (
    <div ref={ref} id={`thread-${thread.id}`} className={`thread${thread.status === 'resolved' ? ' is-resolved' : ''}${focused ? ' is-focused' : ''}${open ? '' : ' is-collapsed'}`}>
      <div className="thread-head" onClick={() => setOpen((o) => !o)} role="button" aria-expanded={open}>
        <div className="thread-head-line">
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
          {showLocation && <code className="thread-loc">{thread.anchor?.path ?? thread.path}:{lineLabel(thread)}</code>}
          {!showLocation && (
            <span className="muted" title={moved ? `Written on ${thread.start_line === thread.end_line ? `line ${thread.start_line}` : `lines ${thread.start_line}–${thread.end_line}`}; the code has moved` : undefined}>
              {currentLines(thread).start === null ? 'File' : <>{thread.side === 'old' ? 'Removed ' : ''}{lineLabel(thread)}{moved ? ' (moved)' : ''}</>}
            </span>
          )}
          <StatusChips thread={thread} />
        </div>
        {!open && last && (
          <div className="thread-peek">
            <strong>{last.author === 'claude' ? 'Claude' : 'You'}:</strong> {snippet(last.body, 160)}
          </div>
        )}
      </div>
      {open && (
        <div className="thread-body">
          {showLocation && thread.start_line !== null && (
            <div className="change-toggle">
              <button className={`link-btn${diffView === 'original' ? ' active' : ''}`} onClick={() => setDiffView((v) => (v === 'original' ? null : 'original'))}>
                Original diff
              </button>
              <button className={`link-btn${diffView === 'current' ? ' active' : ''}`} onClick={() => setDiffView((v) => (v === 'current' ? null : 'current'))}>
                Current diff
              </button>
              {diffView && <ThreadDiff thread={thread} which={diffView} />}
            </div>
          )}
          {thread.anchor?.state === 'outdated' && thread.anchor.current_text !== undefined ? (
            <div className="change-toggle">
              <button className="link-btn" onClick={() => setShowChange((v) => !v)}>
                {showChange ? 'Hide what changed' : 'Show what changed'}
              </button>
              {showChange && <WhatChanged before={thread.anchor_text} after={thread.anchor.current_text} />}
            </div>
          ) : (
            outdated && !showLocation && thread.anchor_text && (
              <pre className="anchor-snippet" title="The lines as they were when the comment was written">{thread.anchor_text}</pre>
            )
          )}
          {thread.comments.map((c) => <Comment key={c.id} comment={c} thread={thread} />)}
          <div className="thread-actions">
            {replying ? (
              <Composer draftKey={replyKey} autoFocus placeholder="Reply" submitLabel="Add reply"
                seed={thread.side === 'new' && thread.start_line !== null ? thread.anchor_text : null}
                onSubmit={async (b) => { await reply(thread.id, b); setReplying(false); }}
                onCancel={() => setReplying(false)} onRestore={() => { setOpen(true); setReplying(true); }} />
            ) : (
              <>
                <button className="reply-stub" onClick={() => setReplying(true)}>Reply…</button>
                {thread.published && (
                  <button className="btn" onClick={() => void setResolved(thread.id, thread.status !== 'resolved')}>
                    {thread.status === 'resolved' ? 'Unresolve' : 'Resolve conversation'}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
