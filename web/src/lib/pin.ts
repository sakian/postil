/**
 * Keeping the page on a file whose body is about to fold. Folding a file while its header is
 * stuck to the top of the pane (you are partway through it) leaves the page wherever the shorter
 * content and the browser's scroll anchoring put it, often mid-way through another file. The
 * check has to happen before the fold, since afterwards the file no longer looks stuck.
 */
let pinned: string | null = null;

export function fileAnchor(path: string): string {
  return `file-${encodeURIComponent(path).replace(/%/g, '_')}`;
}

/** Call before folding or unfolding a file: remembers it if you are partway through it. */
export function notePin(path: string): void {
  const el = typeof document === 'undefined' ? null : document.getElementById(fileAnchor(path));
  const pane = el?.closest('main');
  pinned = el && pane && el.getBoundingClientRect().top < pane.getBoundingClientRect().top ? path : null;
}

/** Whether the file should be brought back to the top now that it folded; true only once. */
export function takePin(path: string): boolean {
  if (pinned !== path) return false;
  pinned = null;
  return true;
}
