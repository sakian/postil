import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * One finished review session, appended to a history file outside every repository. Tree ids are
 * content addresses, so a tree recorded on one computer names the same content on another; the
 * file can be shared between computers (a synced folder) to carry "since last review" across.
 */
export interface HistoryEntry {
  v: 1;
  /** The repository's identity: its normalized origin URL, or `root:<commit>` without one. */
  repo: string;
  branch: string | null;
  /** The working tree the user had reviewed when they finished. */
  tree: string;
  head: string | null;
  finished_at: string;
  host: string;
}

/** `$POSTIL_HISTORY`, or `~/.postil/history.jsonl`. */
export function defaultHistoryFile(): string {
  return process.env.POSTIL_HISTORY || join(homedir(), '.postil', 'history.jsonl');
}

/**
 * The same repository cloned by SSH or HTTPS, with or without `.git` or credentials, gives the
 * same identity: `github.com/owner/name`.
 */
export function normalizeRemote(url: string): string {
  let s = url.trim();
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(s); // git@host:owner/name
  if (/^[a-z]:[\\/]/i.test(s)) { /* a Windows path */ }
  else if (scp) s = `${scp[1]!.toLowerCase()}/${scp[2]}`;
  else if (URL.canParse(s)) {
    const u = new URL(s); // hostname comes back lowercased
    if (u.protocol !== 'file:') s = `${u.hostname}${u.pathname}`;
  }
  return s.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/, '');
}

export class History {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async append(entry: Omit<HistoryEntry, 'v' | 'host'>): Promise<HistoryEntry> {
    const full: HistoryEntry = { v: 1, ...entry, host: hostname() };
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(full)}\n`);
    return full;
  }

  /** Every entry for one repository, oldest first. Lines that do not parse (a torn sync) are skipped. */
  async entries(repo: string): Promise<HistoryEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: HistoryEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as HistoryEntry;
        if (e.v === 1 && e.repo === repo && typeof e.tree === 'string' && typeof e.finished_at === 'string') out.push(e);
      } catch { /* skip */ }
    }
    // Lines from several computers may interleave out of order once merged.
    return out.sort((a, b) => a.finished_at.localeCompare(b.finished_at));
  }

  /** The most recent session finished on this branch, on any computer. */
  async latest(repo: string, branch: string | null): Promise<HistoryEntry | null> {
    return (await this.entries(repo)).filter((e) => e.branch === branch).at(-1) ?? null;
  }
}
