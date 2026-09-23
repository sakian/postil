/**
 * Finds the ```suggestion block in a comment. Returns its text (which may be empty, meaning
 * "delete these lines"), null when there is none, and throws when there are several, since
 * it would be ambiguous which one to apply.
 */
export function extractSuggestion(markdown: string): string | null {
  const lines = markdown.split('\n');
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s{0,3}(`{3,}|~{3,})\s*suggestion\s*$/.exec(lines[i] ?? '');
    if (!open) continue;
    const fence = open[1]!;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j] ?? '';
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) break;
      body.push(line);
    }
    found.push(body.join('\n'));
    i = j;
  }
  if (found.length > 1) throw new Error('the comment has more than one suggestion block');
  return found[0] ?? null;
}

export function hasSuggestion(markdown: string): boolean {
  return /^\s{0,3}(`{3,}|~{3,})\s*suggestion\s*$/m.test(markdown);
}

/**
 * Replace lines [start, end] (1-based, inclusive) of a file's text, keeping its line-ending
 * style and whether it ends with a newline.
 */
export function replaceLines(text: string, start: number, end: number, replacement: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailing = text.endsWith('\n');
  const lines = text.split(/\r?\n/);
  if (trailing) lines.pop();
  const insert = replacement === '' ? [] : replacement.split(/\r?\n/);
  lines.splice(start - 1, end - start + 1, ...insert);
  if (lines.length === 0) return '';
  return lines.join(eol) + (trailing ? eol : '');
}
