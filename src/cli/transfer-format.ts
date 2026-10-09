import type { ExportResult, ImportResult } from '../core/transfer.ts';

function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const short = (oid: string | null) => (oid ? oid.slice(0, 7) : 'no commit');

export function describeExport(r: ExportResult): string {
  const m = r.manifest;
  return [
    `exported the postil session for ${m.root} to ${r.file} (${size(r.bytes)})`,
    `  branch:   ${m.branch ?? `detached at ${short(m.head)}`}`,
    `  snapshots: ${m.trees.length}, plus the working tree as it is now`,
    `  Claude:   ${m.claude_session ? `conversation ${m.claude_session} included` : 'conversation not included (add --claude <session-id>)'}`,
    '',
    'In the clone on the other computer: git fetch, then',
    `  postil import ${r.file.includes(' ') ? JSON.stringify(r.file) : r.file} --worktree`,
    '--worktree also brings the uncommitted changes; leave it out if they reached that clone another way.',
    ...(m.claude_session ? [`Then resume the conversation there with \`claude --resume ${m.claude_session}\` and run /postil:review.`] : []),
    'The session stays here too, but nothing done here from now on goes with the export.',
  ].join('\n');
}

export function describeImport(r: ImportResult): string {
  const m = r.manifest;
  const worktree = {
    matches: 'matches the export',
    restored: 'now has the uncommitted changes from the export',
    differs: 'differs from the export. The review will show it as it is here; to bring the exported ' +
      'uncommitted changes, import again with --worktree --force on a clean checkout',
  }[r.worktree];
  return [
    `imported the postil session exported from ${m.host} at ${m.exported_at}`,
    `  branch:   ${m.branch ?? `detached at ${short(m.head)}`}`,
    `  working tree: ${worktree}`,
    ...(r.backup ? [`  the previous database is kept at ${r.backup}`] : []),
    ...r.warnings.map((w) => `  warning: ${w}`),
    '',
    ...(r.transcript
      ? r.transcript.resumable
        ? [`Resume the Claude Code conversation here with \`claude --resume ${m.claude_session}\` in the repository's top folder, then run /postil:review.`]
        : [`The Claude Code conversation is saved at ${r.transcript.path}. Claude Code's folder for this path could not be worked out, so copy it there yourself, then resume it.`]
      : ['Run /postil:review in Claude Code here to pick the review up.']),
  ].join('\n');
}
