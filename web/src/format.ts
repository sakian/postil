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
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path; // the repository root is C:\... on Windows
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

/**
 * A file's path on one side of the diff. A renamed file has different paths on its two sides,
 * and the server looks each side up in its own tree.
 */
export function sidePath(f: Pick<FileChange, 'path' | 'old_path' | 'new_path'>, side: 'old' | 'new'): string {
  return (side === 'old' ? f.old_path : f.new_path) ?? f.path;
}

/** The lines a thread covers now: its anchor in the current diff, else where it was written. */
export function currentLines(t: Pick<ThreadView, 'start_line' | 'end_line' | 'anchor'>): { start: number | null; end: number | null } {
  if (t.anchor && t.anchor.state !== 'gone') return { start: t.anchor.start_line, end: t.anchor.end_line };
  return { start: t.start_line, end: t.end_line };
}

export function lineLabel(t: Pick<ThreadView, 'start_line' | 'end_line' | 'anchor'>): string {
  const { start, end } = currentLines(t);
  if (start === null) return 'file';
  return start === end ? `L${start}` : `L${start}–${end}`;
}

/** Where a thread sits relative to the diff on screen. */
export type Placement = 'inline' | 'file' | 'gone' | 'elsewhere';

export function threadPath(t: ThreadView): string {
  return t.anchor?.path ?? t.path;
}

export function threadFile(t: ThreadView, files: readonly FileChange[]): FileChange | undefined {
  const path = threadPath(t);
  return files.find((f) => (t.side === 'new' ? f.new_path === path : f.old_path === path)) ?? files.find((f) => f.path === t.path);
}

export function placement(t: ThreadView, file: FileChange | undefined): Placement {
  if (!file) return 'elsewhere';
  if (t.anchor?.state === 'gone') return 'gone';
  return currentLines(t).start === null ? 'file' : 'inline';
}

export function isOutdated(t: ThreadView): boolean {
  return t.anchor?.state === 'outdated' || t.anchor?.state === 'gone';
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
