import type { DiffLine, FileChange, FileKind, FileStatus, Hunk } from './types.ts';

const ZERO_OID = /^0+$/;

function oid(value: string): string | null {
  return ZERO_OID.test(value) ? null : value;
}

function kindForMode(mode: string | null): FileKind {
  if (mode === '160000') return 'submodule';
  if (mode === '120000') return 'symlink';
  return 'text';
}

const STATUS: Record<string, FileStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  T: 'type_changed',
};

function splitZ(buf: Buffer | string): string[] {
  const parts = (typeof buf === 'string' ? buf : buf.toString('utf8')).split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

/**
 * Parse `git diff --raw -z --no-abbrev -M` output. Copies and unmerged entries are not
 * requested by postil and are skipped if they appear.
 */
export function parseRawZ(buf: Buffer | string): FileChange[] {
  const tokens = splitZ(buf);
  const files: FileChange[] = [];
  let i = 0;
  while (i < tokens.length) {
    const meta = tokens[i++];
    if (meta === undefined || !meta.startsWith(':')) throw new Error(`unexpected raw diff token: ${meta}`);
    const [oldMode, newMode, oldOid, newOid, statusField] = meta.slice(1).split(' ');
    if (!oldMode || !newMode || !oldOid || !newOid || !statusField) throw new Error(`malformed raw diff record: ${meta}`);
    const letter = statusField[0] ?? '';
    const score = statusField.length > 1 ? Number(statusField.slice(1)) : null;
    const twoPaths = letter === 'R' || letter === 'C';
    const first = tokens[i++];
    const second = twoPaths ? tokens[i++] : undefined;
    if (first === undefined || (twoPaths && second === undefined)) throw new Error('truncated raw diff output');

    const status = STATUS[letter];
    if (!status) continue;

    const oldPath = status === 'added' ? null : first;
    const newPath = status === 'deleted' ? null : (second ?? first);
    const oldModeOrNull = oldMode === '000000' ? null : oldMode;
    const newModeOrNull = newMode === '000000' ? null : newMode;
    files.push({
      status,
      kind: kindForMode(newModeOrNull ?? oldModeOrNull),
      path: newPath ?? oldPath ?? first,
      old_path: oldPath,
      new_path: newPath,
      old_blob: oid(oldOid),
      new_blob: oid(newOid),
      old_mode: oldModeOrNull,
      new_mode: newModeOrNull,
      similarity: status === 'renamed' ? score : null,
      additions: null,
      deletions: null,
    });
  }
  return files;
}

export interface NumstatEntry {
  additions: number | null;
  deletions: number | null;
}

/** Parse `git diff --numstat -z -M`, keyed by the new path (the old path for deletions). */
export function parseNumstatZ(buf: Buffer | string): Map<string, NumstatEntry> {
  const tokens = splitZ(buf);
  const result = new Map<string, NumstatEntry>();
  let i = 0;
  while (i < tokens.length) {
    const record = tokens[i++] ?? '';
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new Error(`malformed numstat record: ${record}`);
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    if (path === '') {
      i++; // old path of a rename; the new path follows
      path = tokens[i++] ?? '';
    }
    result.set(path, {
      additions: added === '-' ? null : Number(added),
      deletions: deleted === '-' ? null : Number(deleted),
    });
  }
  return result;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export interface ParsedFileDiff {
  binary: boolean;
  hunks: Hunk[];
}

/**
 * Parse the unified diff of a single file. Hunk bodies are consumed by the line counts
 * in their headers rather than by pattern, so file content that looks like diff syntax
 * cannot confuse the parser.
 */
export function parseUnifiedDiff(text: string): ParsedFileDiff {
  const lines = text.split('\n');
  const hunks: Hunk[] = [];
  let binary = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i++] ?? '';
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      binary = true;
      continue;
    }
    const m = HUNK_HEADER.exec(line);
    if (!m) continue;

    const hunk: Hunk = {
      old_start: Number(m[1]),
      old_lines: m[2] === undefined ? 1 : Number(m[2]),
      new_start: Number(m[3]),
      new_lines: m[4] === undefined ? 1 : Number(m[4]),
      header: m[5] ?? '',
      lines: [],
    };
    let oldNo = hunk.old_start;
    let newNo = hunk.new_start;
    let oldLeft = hunk.old_lines;
    let newLeft = hunk.new_lines;

    while (oldLeft > 0 || newLeft > 0) {
      const body = lines[i++];
      // The split leaves one empty string after the final newline; reaching it here means truncation.
      if (body === undefined || (body === '' && i === lines.length)) {
        throw new Error('unified diff ended inside a hunk');
      }
      const marker = body[0];
      const content = body.slice(1);
      let parsed: DiffLine;
      // An empty line mid-hunk is a blank context line printed under diff.suppressBlankEmpty.
      if (marker === ' ' || body === '') {
        parsed = { kind: 'context', old_no: oldNo++, new_no: newNo++, text: content };
        oldLeft--;
        newLeft--;
      } else if (marker === '-') {
        parsed = { kind: 'del', old_no: oldNo++, new_no: null, text: content };
        oldLeft--;
      } else if (marker === '+') {
        parsed = { kind: 'add', old_no: null, new_no: newNo++, text: content };
        newLeft--;
      } else if (marker === '\\') {
        markNoEol(hunk.lines);
        continue;
      } else {
        throw new Error(`unexpected line in hunk: ${JSON.stringify(body)}`);
      }
      hunk.lines.push(parsed);
    }
    // A trailing "\ No newline at end of file" follows the counted lines.
    while (lines[i]?.startsWith('\\')) {
      markNoEol(hunk.lines);
      i++;
    }
    hunks.push(hunk);
  }
  return { binary, hunks };
}

function markNoEol(lines: DiffLine[]): void {
  const last = lines.at(-1);
  if (last) last.no_eol = true;
}

/** Number of lines in a file, counting a final line with no trailing newline. */
export function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (const byte of buf) if (byte === 10) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

/** Split file content into lines, consistent with `countLines`. */
export function splitLines(buf: Buffer): string[] {
  if (buf.length === 0) return [];
  const parts = buf.toString('utf8').split('\n');
  if (buf[buf.length - 1] === 10) parts.pop();
  return parts;
}

/** Git's own heuristic: a NUL byte in the first 8000 bytes means binary. */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

export interface LogRecord {
  sha: string;
  parents: string[];
  subject: string;
  author_name: string;
  author_email: string;
  authored_at: string;
}

/** Field and record separators for `git log --format`. Neither can appear in commit metadata. */
export const LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e';

export function parseLog(text: string): LogRecord[] {
  return text
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r !== '')
    .map((r) => {
      const [sha = '', parents = '', name = '', email = '', date = '', subject = ''] = r.split('\x1f');
      return {
        sha,
        parents: parents === '' ? [] : parents.split(' '),
        subject,
        author_name: name,
        author_email: email,
        authored_at: date,
      };
    });
}
