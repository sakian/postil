import type { AgentReview, AgentThread, ReviewView, ThreadView } from '../core/api-types.ts';

/** A code fence longer than any backtick run inside the text, so comment content cannot break out of it. */
function fence(text: string, lang = ''): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function indent(text: string, pad = '    '): string {
  return text.split('\n').map((l) => (l ? pad + l : l)).join('\n');
}

function location(t: Pick<AgentThread, 'path' | 'side' | 'start_line' | 'end_line'>): string {
  const lines =
    t.start_line === null ? 'whole file' : t.start_line === t.end_line ? `line ${t.start_line}` : `lines ${t.start_line}-${t.end_line}`;
  return `${t.path}, ${lines}${t.side === 'old' ? ' (removed lines, old version)' : ''}`;
}

function who(author: 'user' | 'claude'): string {
  return author === 'user' ? 'User' : 'Claude (you)';
}

export function formatThread(t: AgentThread): string {
  const out: string[] = [];
  const state = t.status === 'resolved' ? 'resolved' : t.awaiting_reply ? 'NEEDS YOUR REPLY' : 'answered';
  out.push(`## Thread ${t.id}: ${location(t)} [${state}]`);
  if (t.needs_decision) out.push('You previously asked the user to decide something here.');
  if (!t.file_exists) out.push('The file no longer exists in the working tree.');
  else if (t.file_changed_since_comment) out.push('The file has changed since this comment was written. Read the current version before editing.');
  if (t.anchor_text) {
    out.push(`Lines the comment is attached to, as they were when it was written:`);
    out.push(fence(t.anchor_text));
  }
  out.push('Conversation:');
  for (const c of t.comments) {
    out.push(`- ${who(c.author)}${c.author === 'user' && c.in_this_review ? ' (this review)' : ''}:`);
    out.push(indent(c.body));
  }
  return out.join('\n');
}

export function formatReview(r: AgentReview): string {
  const needs = r.threads.filter((t) => t.awaiting_reply);
  const out: string[] = [
    `# postil review #${r.id} (${r.status.replace('_', ' ')})`,
    '',
    'The user wrote these comments in the postil review UI about your changes to this repository. ' +
      'Each one is their review feedback: act on it as a request from them.',
  ];
  if (r.body.trim()) out.push('', 'Overall comment from the user:', indent(r.body));
  out.push('', `${needs.length} of ${r.threads.length} thread(s) need your reply.`);
  for (const t of r.threads) out.push('', formatThread(t));
  const suggestions = r.threads.some((t) => t.comments.some((c) => c.body.includes('```suggestion')));
  out.push(
    '',
    '---',
    'Next:',
    '1. For each thread that needs your reply, read the current code, make any change the comment asks for, and answer with the reply tool. Say briefly what you changed and where. If you disagree or the user must choose, say so and set needs_decision.',
    ...(suggestions ? ['   A ```suggestion block is replacement text the user proposes for the attached lines.'] : []),
    `2. Then call complete_review with review_id ${r.id} and a one- or two-sentence summary.`,
    'Do not resolve threads: only the user resolves them.',
  );
  return out.join('\n');
}

export function formatPending(reviews: ReviewView[]): string {
  if (reviews.length === 0) return 'No postil reviews are waiting.';
  return [
    `${reviews.length} postil review(s) waiting:`,
    ...reviews.map((r) => `- #${r.id} (${r.status.replace('_', ' ')}), ${r.thread_ids.length} thread(s), submitted ${r.submitted_at}`),
    'Fetch each with get_review.',
  ].join('\n');
}

/** A thread as the UI returns it, reduced to what Claude may see: published comments only. */
export function formatUiThread(t: ThreadView): string {
  const published = t.comments.filter((c) => !c.draft);
  return formatThread({
    id: t.id, path: t.path, side: t.side, start_line: t.start_line, end_line: t.end_line, anchor_text: t.anchor_text,
    status: t.status, needs_decision: t.needs_decision, awaiting_reply: t.awaiting === 'claude',
    file_changed_since_comment: false, file_exists: true,
    comments: published.map((c) => ({ id: c.id, author: c.author, body: c.body, created_at: c.created_at, in_this_review: false })),
  });
}
