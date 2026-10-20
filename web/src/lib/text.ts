/** `text` with `snippet` on lines of its own in place of the selection `at`, or at the end. */
export function insertBlock(text: string, at: readonly [number, number] | null, snippet: string): string {
  const [start, end] = at && at[1] <= text.length ? at : [text.length, text.length];
  const before = text.slice(0, start);
  const after = text.slice(end);
  return `${before}${before && !before.endsWith('\n') ? '\n' : ''}${snippet}${after.startsWith('\n') ? '' : '\n'}${after}`;
}
