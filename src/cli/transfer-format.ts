import { dirname } from 'node:path';
import type { ExportResult, ImportResult } from '../core/transfer.ts';
import { transferDir, type ExportEntry, type ExportSummary } from '../core/transfer-dir.ts';

function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const short = (oid: string | null) => (oid ? oid.slice(0, 7) : 'no commit');
const arg = (s: string) => (/^[\w./~:@%+-]+$/.test(s) ? s : JSON.stringify(s));

/** The command that picks the conversation up again, and with it the review. */
export function resumeCommand(session: string): string {
  return `claude --resume ${session} /postil:review`;
}

export function describeExport(r: ExportResult): string {
  const m = r.manifest;
  const dir = transferDir();
  const synced = dir !== null && dirname(r.file) === dir;
  return [
    `exported the postil session for ${m.root} to ${r.file} (${size(r.bytes)})`,
    `  branch:   ${m.branch ?? `detached at ${short(m.head)}`}`,
    `  snapshots: ${m.trees.length}, plus the working tree as it is now`,
    `  Claude:   ${m.claude_session ? `conversation ${m.claude_session} included` : 'no conversation included'}`,
    ...(r.summary ? [`  state:    ${describeSummary(r.summary)}`] : []),
    ...(r.replaced ? [`  replaced ${r.replaced} older export(s) of this branch in the transfer folder`] : []),
    '',
    synced
      ? 'Once it has synced, run `postil import` in the clone on the other computer.'
      : `Copy it to the other computer and run \`postil import ${arg(r.file)}\` in the clone there.`,
    'The session stays here too, but nothing done here from now on goes with the export.',
  ].join('\n');
}

export function describeImport(r: ImportResult): string {
  const m = r.manifest;
  const worktree = {
    matches: 'matches the export',
    restored: 'now has the exported changes',
    differs: `left as it is, since ${r.worktreeNote ?? 'it differs'}. The review shows it as it is here`,
  }[r.worktree];
  return [
    `imported the postil session exported from ${m.host} at ${m.exported_at}`,
    ...(r.consumed ? [`  removed ${r.file} from the transfer folder`] : []),
    `  branch:   ${m.branch ?? `detached at ${short(m.head)}`}`,
    `  working tree: ${worktree}`,
    ...(r.fetched ? ['  fetched from the remotes first, for commits the export builds on'] : []),
    ...(r.backup ? [`  the previous database is kept at ${r.backup}`] : []),
    ...r.warnings.map((w) => `  warning: ${w}`),
    '',
    ...(r.transcript
      ? r.transcript.resumable
        ? [`To carry on with Claude: cd ${arg(r.root)} && ${resumeCommand(m.claude_session!)}`]
        : [`The Claude Code conversation is saved at ${r.transcript.path}. Claude Code's folder for this path could not be worked out, so copy it there yourself, then resume it.`]
      : ['Run /postil:review in Claude Code here to pick the review up.']),
  ].join('\n');
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export function describeSummary(s: ExportSummary): string {
  const parts = [plural(s.open_threads, 'open conversation')];
  if (s.waiting_reviews) parts.push(`${plural(s.waiting_reviews, 'review')} waiting for Claude`);
  else if (s.last_review) parts.push(`review #${s.last_review.id} ${s.last_review.status.replace('_', ' ')}`);
  if (s.drafts) parts.push(plural(s.drafts, 'unsent comment'));
  return parts.join(', ');
}

function ago(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return 'at an unknown time';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${plural(hours, 'hour')} ago`;
  return `${plural(Math.round(hours / 24), 'day')} ago`;
}

/** One line per export, numbered from 1, for picking one. */
export function describeExports(entries: ExportEntry[], now = Date.now()): string {
  return entries.map((e, i) => {
    const n = `${String(i + 1).padStart(3)}. `;
    if (!e.info) return `${n}${e.file.split(/[\\/]/).pop()}`;
    const { info } = e;
    const what = [
      info.branch ?? `detached at ${short(info.head)}`,
      `from ${info.host}, ${ago(info.exported_at, now)}`,
      ...(info.summary ? [describeSummary(info.summary)] : []),
      ...(info.claude_session ? ['with the Claude conversation'] : []),
    ];
    return `${n}${what.join(' · ')}`;
  }).join('\n');
}
