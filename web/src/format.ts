import type { FileChange, ThreadView } from '../../src/core/api-types.ts';

export function shortSha(oid: string | null | undefined): string {
  return oid ? oid.slice(0, 7) : '';
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

/** Content-addressed key for a file's diff: the same pair of blobs always gives the same diff. */
export function diffKey(f: Pick<FileChange, 'old_blob' | 'new_blob'>): string {
  return `${f.old_blob ?? '-'}..${f.new_blob ?? '-'}`;
}

/** The blob a "viewed" mark refers to: the new content, or the old one for a deletion. */
export function viewedBlob(f: FileChange): string | null {
  return f.new_blob ?? f.old_blob;
}

export function markKey(path: string, blob: string): string {
  return `${path}\u0000${blob}`;
}

export function lineLabel(t: Pick<ThreadView, 'start_line' | 'end_line'>): string {
  if (t.start_line === null) return 'file';
  return t.start_line === t.end_line ? `L${t.start_line}` : `L${t.start_line}–${t.end_line}`;
}

/** Where a thread sits relative to the file as shown in the current diff. */
export type Placement = 'inline' | 'file' | 'outdated' | 'elsewhere';

export function threadFile(t: ThreadView, files: readonly FileChange[]): FileChange | undefined {
  return files.find((f) => (t.side === 'new' ? f.new_path === t.path : f.old_path === t.path) || f.path === t.path);
}

export function placement(t: ThreadView, file: FileChange | undefined): Placement {
  if (!file) return 'elsewhere';
  const blob = t.side === 'new' ? file.new_blob : file.old_blob;
  if (blob !== t.blob) return 'outdated';
  return t.start_line === null ? 'file' : 'inline';
}

/** A one-line plain-text preview of a Markdown comment. */
export function snippet(markdown: string, max = 140): string {
  const text = markdown
    .replace(/```suggestion[\s\S]*?```/g, '[suggested change]')
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/[`*_>#]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
