import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { CommentView, ThreadView } from '../../../src/core/api-types.ts';
import { currentLines, isOutdated, lineLabel, relativeTime, snippet } from '../format.ts';
import { lineDiff } from '../lib/linediff.ts';
import { useStore, type Target } from '../store.ts';
import { Icon } from './icons.tsx';
import { Markdown, type ApplyState } from './Markdown.tsx';

// ---------------------------------------------------------------------------- composer

interface ComposerProps {
  initial?: string;
  placeholder: string;
  submitLabel: string;
  /** Text of the anchored lines; enables "Suggest change". */
  seed?: string | null;
  autoFocus?: boolean;
  onSubmit(body: string): Promise<void>;
  onCancel?(): void;
}

export function Composer({ initial = '', placeholder, submitLabel, seed, autoFocus, onSubmit, onCancel }: ComposerProps) {
  const [body, setBody] = useState(initial);
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
      setBody('');
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
    } else if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      onCancel();
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
        {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
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
      <Composer autoFocus placeholder="Leave a comment" submitLabel="Add review comment" seed={seed}
        onSubmit={(body) => createThread(target, body)} onCancel={() => openComposer(null)} />
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
  const [editing, setEditing] = useState(false);
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
        <Composer initial={comment.body} autoFocus placeholder="Edit comment" submitLabel="Update comment"
          seed={suggestionBase} onSubmit={async (b) => { await editComment(comment.id, b); setEditing(false); }}
          onCancel={() => setEditing(false)} />
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
      {thread.needs_decision && thread.status === 'open' && <span className="chip chip-decision">Needs your decision</span>}
      {thread.awaiting === 'claude' && <span className="chip chip-claude">Waiting for Claude</span>}
      {thread.awaiting === 'user' && !thread.needs_decision && <span className="chip chip-you">Your turn</span>}
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

export function ThreadWidget({ thread, showLocation = false }: { thread: ThreadView; showLocation?: boolean }) {
  const [open, setOpen] = useState(thread.status !== 'resolved');
  const [replying, setReplying] = useState(false);
  const [showChange, setShowChange] = useState(false);
  const outdated = isOutdated(thread);
  const moved = thread.anchor?.state === 'moved';
  const focused = useStore((s) => s.focusThread === thread.id);
  const { reply, setResolved, focus } = useStore.getState();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setOpen(thread.status !== 'resolved'), [thread.status]);
  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const t = setTimeout(() => focus(null), 1600);
    return () => clearTimeout(t);
  }, [focused, focus]);

  return (
    <div ref={ref} id={`thread-${thread.id}`} className={`thread${thread.status === 'resolved' ? ' is-resolved' : ''}${focused ? ' is-focused' : ''}`}>
      <div className="thread-head" onClick={() => setOpen((o) => !o)} role="button" aria-expanded={open}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
        {showLocation && <code className="thread-loc">{thread.anchor?.path ?? thread.path}:{lineLabel(thread)}</code>}
        {!showLocation && currentLines(thread).start !== null && (
          <span className="muted" title={moved ? `Written on ${thread.start_line === thread.end_line ? `line ${thread.start_line}` : `lines ${thread.start_line}–${thread.end_line}`}; the code has moved` : undefined}>
            {thread.side === 'old' ? 'Removed ' : ''}{lineLabel(thread)}{moved ? ' (moved)' : ''}
          </span>
        )}
        <StatusChips thread={thread} />
        {!open && <span className="thread-peek muted">{snippet(thread.comments.at(-1)?.body ?? '', 90)}</span>}
      </div>
      {open && (
        <div className="thread-body">
          {thread.anchor?.state === 'outdated' && thread.anchor.current_text !== undefined ? (
            <div className="change-toggle">
              <button className="link-btn" onClick={() => setShowChange((v) => !v)}>
                {showChange ? 'Hide what changed' : 'Show what changed'}
              </button>
              {showChange && <WhatChanged before={thread.anchor_text} after={thread.anchor.current_text} />}
            </div>
          ) : (
            (outdated || showLocation) && thread.anchor_text && (
              <pre className="anchor-snippet" title="The lines as they were when the comment was written">{thread.anchor_text}</pre>
            )
          )}
          {thread.comments.map((c) => <Comment key={c.id} comment={c} thread={thread} />)}
          <div className="thread-actions">
            {replying ? (
              <Composer autoFocus placeholder="Reply" submitLabel="Add reply"
                seed={thread.side === 'new' && thread.start_line !== null ? thread.anchor_text : null}
                onSubmit={async (b) => { await reply(thread.id, b); setReplying(false); }} onCancel={() => setReplying(false)} />
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
