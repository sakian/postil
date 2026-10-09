import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../db/store.ts';
import { MIGRATIONS } from '../db/schema.ts';
import { GitError } from '../git/exec.ts';
import { assertOid, PIN_ROOT, Repo } from '../git/repo.ts';
import { NotRunningError, PostilClient } from './client.ts';
import { normalizeRemote } from './history.ts';
import {
  exportName, listExports, pruneExports, removeExport, transferDir, writeExportInfo, type ExportEntry, type ExportSummary,
} from './transfer-dir.ts';
import { assertSession } from './postil.ts';
import { VERSION } from './version.ts';

/**
 * Moving a postil session to another clone, usually on another computer. An export is a git
 * bundle holding one commit, whose tree carries the database, a manifest, every snapshot the
 * database pins, the working tree as it was, and optionally the Claude Code conversation. The
 * commit's parents are HEAD and the pinned base, so local commits travel too. Objects the
 * remote-tracking branches already hold are left out: the other clone fetches those itself.
 */

const FORMAT = 1;
const EXPORT_REF = 'refs/postil-export/session';
const IMPORT_REF = 'refs/postil-import/session';
const BACKUP_SUFFIX = '.before-import';

export interface Manifest {
  format: number;
  postil: string;
  /** The database's schema version. An older postil cannot open a newer database. */
  schema: number;
  exported_at: string;
  host: string;
  /** Normalized origin URL, or `root:<oid>` without one, as in the history file. */
  repo: string | null;
  root: string;
  branch: string | null;
  head: string | null;
  /** The working tree when exported, uncommitted and untracked files included. */
  worktree: string;
  base: string | null;
  trees: string[];
  blobs: string[];
  /** The Claude Code session whose conversation travels with the export. */
  claude_session: string | null;
}

export class TransferError extends Error {
  override name = 'TransferError';
}

async function repoIdentity(repo: Repo): Promise<string | null> {
  const id = await repo.identity();
  return !id ? null : 'remote' in id ? normalizeRemote(id.remote) : `root:${id.root}`;
}

async function refTarget(repo: Repo, ref: string): Promise<string | null> {
  const out = (await repo.run(['rev-parse', '-q', '--verify', ref], { okCodes: [1] })).toString().trim();
  return out === '' ? null : out;
}

async function refsUnder(repo: Repo, prefix: string): Promise<string[]> {
  const out = (await repo.run(['for-each-ref', '--format=%(objectname)', prefix])).toString();
  return out.split('\n').filter((l) => l !== '');
}

async function hashBlob(repo: Repo, data: Buffer | string): Promise<string> {
  return (await repo.run(['hash-object', '-w', '--stdin'], { input: data })).toString().trim();
}

/** One level of a tree; mktree sorts the entries itself. Callers nest for deeper paths. */
async function mktree(repo: Repo, entries: Array<[name: string, mode: string, type: string, oid: string]>): Promise<string> {
  const input = entries.map(([name, mode, type, oid]) => `${mode} ${type} ${oid}\t${name}\n`).join('');
  return (await repo.run(['mktree'], { input })).toString().trim();
}

async function headTree(repo: Repo, head: string | null): Promise<string> {
  return head ? repo.resolveTree(head) : repo.emptyTree();
}

// ---------------------------------------------------------------------------- Claude Code conversations

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

/**
 * The folder Claude Code keeps a project's conversations in: the project path with everything
 * but letters and digits turned into dashes. Longer paths get a hash suffix we cannot reproduce,
 * so they get null.
 */
export function claudeProjectDir(projectPath: string): string | null {
  const name = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  return name.length > 200 ? null : join(claudeConfigDir(), 'projects', name);
}

/** A conversation's transcript, looked for under this project first and then under any project. */
async function findTranscript(session: string, projectPath: string): Promise<string | null> {
  const file = `${assertSession(session)}.jsonl`;
  const own = claudeProjectDir(projectPath);
  if (own && existsSync(join(own, file))) return join(own, file);
  const projects = join(claudeConfigDir(), 'projects');
  const dirs = await readdir(projects).catch(() => [] as string[]);
  for (const dir of dirs) {
    if (existsSync(join(projects, dir, file))) return join(projects, dir, file);
  }
  return null;
}

// ---------------------------------------------------------------------------- export

export interface ExportOptions {
  /** Where to write the bundle. Defaults to a timestamped file in the home directory. */
  file?: string;
  /**
   * The Claude Code session whose conversation goes along. By default, the one that listened for
   * reviews here most recently, if its transcript is on this computer; null for none.
   */
  claudeSession?: string | null;
}

export interface ExportResult {
  file: string;
  manifest: Manifest;
  bytes: number;
  summary: ExportSummary | null;
  /** Older exports of this branch removed from the transfer folder. */
  replaced: number;
}

/** This repository's exports in the transfer folder, newest first. */
export async function sessionExports(cwd: string): Promise<ExportEntry[]> {
  return listExports(await repoIdentity(await Repo.open(cwd)));
}

/** Counts that tell one export from another in a list. Best effort: null for a database it cannot read. */
function summarize(conn: DatabaseSync): ExportSummary | null {
  try {
    const n = (sql: string) => Number((conn.prepare(sql).get() as { n: number }).n);
    const last = conn.prepare('SELECT id, status FROM review WHERE status != \'draft\' AND archived_at IS NULL ORDER BY id DESC LIMIT 1').get() as
      { id: number; status: string } | undefined;
    return {
      open_threads: n(`SELECT COUNT(*) AS n FROM thread WHERE archived_at IS NULL AND status = 'open'
                       AND EXISTS (SELECT 1 FROM comment WHERE thread_id = thread.id AND draft = 0)`),
      waiting_reviews: n(`SELECT COUNT(*) AS n FROM review WHERE archived_at IS NULL AND status IN ('submitted', 'in_progress')`),
      drafts: n('SELECT COUNT(*) AS n FROM comment WHERE draft = 1'),
      last_review: last ? { id: Number(last.id), status: String(last.status) } : null,
    };
  } catch {
    return null;
  }
}

/** Bundle this clone's postil session. Safe beside a running server: nothing here changes. */
export async function exportSession(cwd: string, opts: ExportOptions = {}): Promise<ExportResult> {
  const repo = await Repo.open(cwd);
  const dbPath = join(repo.stateDir, 'postil.db');
  if (!existsSync(dbPath)) throw new TransferError(`postil has not been used in ${repo.root}, so there is nothing to export`);
  const identity = await repoIdentity(repo);
  const dir = transferDir();
  if (opts.file === undefined && dir) await mkdir(dir, { recursive: true });
  const file = resolve(cwd, opts.file ?? join(dir ?? homedir(), exportName(repo.root, identity)));
  if (existsSync(file)) throw new TransferError(`${file} already exists`);

  // VACUUM INTO writes a consistent copy even while the server is writing.
  const tmp = await mkdtemp(join(tmpdir(), 'postil-export-'));
  let db: Buffer;
  let schema: number;
  let listeners: string[];
  let summary: ExportSummary | null = null;
  try {
    const copy = join(tmp, 'postil.db');
    const conn = new DatabaseSync(dbPath);
    try {
      conn.exec('PRAGMA busy_timeout = 5000');
      schema = Number((conn.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      listeners = schema >= 2
        ? (conn.prepare('SELECT session_id FROM listener ORDER BY last_seen DESC').all() as Array<{ session_id: string }>).map((r) => r.session_id)
        : [];
      conn.prepare('VACUUM INTO ?').run(copy);
    } finally {
      conn.close();
    }
    const snapshot = new DatabaseSync(copy, { readOnly: true });
    try {
      summary = summarize(snapshot);
    } finally {
      snapshot.close();
    }
    db = await readFile(copy);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  let transcript: { session: string; content: Buffer } | null = null;
  if (typeof opts.claudeSession === 'string') {
    const path = await findTranscript(opts.claudeSession, repo.root);
    if (!path) throw new TransferError(`no Claude Code conversation ${opts.claudeSession} was found under ${join(claudeConfigDir(), 'projects')}`);
    transcript = { session: opts.claudeSession, content: await readFile(path) };
  } else if (opts.claudeSession === undefined) {
    for (const session of listeners) {
      const path = await findTranscript(session, repo.root).catch(() => null);
      if (path) {
        transcript = { session, content: await readFile(path) };
        break;
      }
    }
  }

  const ns = `${PIN_ROOT}${repo.worktreeId}/`;
  const [trees, blobs, base, head, branch] = await Promise.all([
    refsUnder(repo, `${ns}trees/`),
    refsUnder(repo, `${ns}blobs/`),
    refTarget(repo, `${ns}base`),
    repo.head(),
    repo.currentBranch(),
  ]);
  // Its own index, so this never races a running server over the shared one.
  const worktree = await repo.worktreeTree('export.index');
  await rm(join(repo.stateDir, 'export.index'), { force: true });

  const manifest: Manifest = {
    format: FORMAT, postil: VERSION, schema, exported_at: new Date().toISOString(), host: hostname(),
    repo: identity, root: repo.root, branch, head, worktree, base, trees, blobs,
    claude_session: transcript?.session ?? null,
  };

  const pinTrees = await mktree(repo, trees.map((t) => [t, '040000', 'tree', t]));
  const pinBlobs = await mktree(repo, blobs.map((b) => [b, '100644', 'blob', b]));
  const entries: Array<[string, string, string, string]> = [
    ['manifest.json', '100644', 'blob', await hashBlob(repo, `${JSON.stringify(manifest, null, 2)}\n`)],
    ['postil.db', '100644', 'blob', await hashBlob(repo, db)],
    ['pins', '040000', 'tree', await mktree(repo, [['blobs', '040000', 'tree', pinBlobs], ['trees', '040000', 'tree', pinTrees]])],
    ['worktree', '040000', 'tree', worktree],
  ];
  if (transcript) {
    entries.push(['claude', '040000', 'tree', await mktree(repo, [[`${manifest.claude_session}.jsonl`, '100644', 'blob', await hashBlob(repo, transcript.content)]])]);
  }
  const tree = await mktree(repo, entries);

  const parents = [...new Set([head, base].filter((c): c is string => c !== null))];
  const identityEnv = {
    GIT_AUTHOR_NAME: 'postil', GIT_AUTHOR_EMAIL: 'postil@localhost',
    GIT_COMMITTER_NAME: 'postil', GIT_COMMITTER_EMAIL: 'postil@localhost',
  };
  const commit = (await repo.run(['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', 'postil session export'], { env: identityEnv })).toString().trim();

  await repo.run(['update-ref', EXPORT_REF, commit]);
  try {
    // What origin already has, the other clone can fetch. A clone without remotes bundles everything.
    await repo.run(['bundle', 'create', '-q', file, EXPORT_REF, '--not', '--remotes']);
  } finally {
    await repo.run(['update-ref', '-d', EXPORT_REF]);
  }
  // In the transfer folder, describe it for the list, and let it replace older exports of this branch.
  let replaced = 0;
  if (dir && dirname(file) === dir) {
    await writeExportInfo(file, { exported_at: manifest.exported_at, host: manifest.host, branch, head, claude_session: manifest.claude_session, summary });
    replaced = await pruneExports(identity, branch, file);
  }
  return { file, manifest, bytes: (await stat(file)).size, summary, replaced };
}

// ---------------------------------------------------------------------------- import

export interface ImportOptions {
  /** Replace a session this clone already has under way, and import into a different repository. */
  force?: boolean;
  /**
   * Bring the exported working tree here, fast-forwarding to its commit first if need be (default
   * true). Only done when this working tree has no changes of its own and the export builds on its
   * commit; otherwise it is left alone and the result says why.
   */
  worktree?: boolean;
  /** Fetch from the remotes when this clone lacks commits the export builds on (default true). */
  fetch?: boolean;
  /** Told of each step as it starts, since an import can take a while. */
  progress?: (step: string) => void;
}

export type WorktreeState = 'matches' | 'restored' | 'differs';

export interface ImportResult {
  manifest: Manifest;
  /** The export imported, and whether it was removed from the transfer folder afterwards. */
  file: string;
  consumed: boolean;
  /** This clone's top folder. */
  root: string;
  worktree: WorktreeState;
  /** Why a differing working tree was left alone. */
  worktreeNote: string | null;
  /** Fetched from the remotes first, for commits the export builds on. */
  fetched: boolean;
  /** Where the previous database went, when this clone had one. */
  backup: string | null;
  /** Where the conversation was written, and the folder Claude Code looks in for it. */
  transcript: { path: string; resumable: boolean } | null;
  warnings: string[];
}

/** Paths that differ between two trees, by what restoring the second over the first must do. */
async function treeChanges(repo: Repo, from: string, to: string): Promise<{ write: string[]; remove: string[] }> {
  const out = (await repo.run(['diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to])).toString();
  const parts = out.split('\0').filter((p) => p !== '');
  const write: string[] = [];
  const remove: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    (parts[i] === 'D' ? remove : write).push(parts[i + 1]!);
  }
  return { write, remove };
}

/**
 * Write `tree` over a working tree that matches `base`, leaving the user's index alone so the
 * changes show as uncommitted, as they were where they came from.
 */
async function restoreWorktree(repo: Repo, base: string, tree: string): Promise<void> {
  const { write, remove } = await treeChanges(repo, base, tree);
  for (const path of remove) {
    // git never writes such a tree itself, but the bundle came from a file.
    const target = resolve(repo.root, path);
    if (!target.startsWith(repo.root + sep)) throw new TransferError(`the export names a path outside the repository: ${path}`);
    await rm(target, { force: true });
  }
  if (write.length === 0) return;
  const index = join(repo.stateDir, 'import.index');
  const env = { GIT_INDEX_FILE: index };
  try {
    await repo.run(['read-tree', tree], { env });
    await repo.run(['checkout-index', '-f', '-z', '--stdin'], { env, input: write.map((p) => `${p}\0`).join('') });
  } finally {
    await rm(index, { force: true });
  }
}

/** Conversations, reviews or unsent comments still under way in this clone's database. */
function liveContent(dbPath: string): number {
  const store = new Store(dbPath);
  try {
    const row = store.db.prepare(`
      SELECT (SELECT COUNT(*) FROM thread WHERE archived_at IS NULL)
           + (SELECT COUNT(*) FROM review WHERE archived_at IS NULL AND status IN ('submitted', 'in_progress')) AS n
    `).get() as { n: number };
    return Number(row.n);
  } finally {
    store.close();
  }
}

async function moveAside(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  await rm(`${path}${BACKUP_SUFFIX}`, { force: true });
  await rename(path, `${path}${BACKUP_SUFFIX}`);
  return true;
}

/**
 * Take over an exported session. Without a file, the newest export of this repository in the
 * transfer folder, which is removed once imported so the folder does not fill up.
 */
export async function importSession(cwd: string, file: string | undefined, opts: ImportOptions = {}): Promise<ImportResult> {
  const repo = await Repo.open(cwd);
  let path: string;
  const picked = file === undefined;
  if (file === undefined) {
    const dir = transferDir();
    if (!dir) throw new TransferError('give the file `postil export` wrote, or set POSTIL_TRANSFER_DIR to a folder synced between your computers');
    const latest = (await sessionExports(cwd))[0]?.file;
    if (!latest) throw new TransferError(`there is no export of this repository in ${dir} (yet: it may still be syncing)`);
    path = latest;
  } else {
    path = resolve(cwd, file);
  }
  if (!existsSync(path)) throw new TransferError(`${path} does not exist`);
  try {
    await PostilClient.connect(cwd, { probeTimeoutMs: 800 });
    throw new TransferError('a postil server is running for this repository; stop it first with `postil stop`');
  } catch (e) {
    if (!(e instanceof NotRunningError)) throw e;
  }

  const verify = async (): Promise<'ok' | 'missing'> => {
    try {
      await repo.run(['bundle', 'verify', path]);
      return 'ok';
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
      if (/prerequisite/i.test(e.stderr)) return 'missing';
      throw new TransferError(`${path} is not a postil export${picked ? ', or has not finished syncing' : ''}: ${e.stderr.trim()}`);
    }
  };
  const progress = opts.progress ?? (() => undefined);
  progress(`Checking ${basename(path)}`);
  let fetched = false;
  if ((await verify()) === 'missing') {
    const advice = 'this clone lacks commits the export builds on, which the other clone had from its remote. Fetch them (git fetch), then import again';
    if (opts.fetch === false) throw new TransferError(advice);
    progress('Fetching the commits it builds on from the remotes');
    try {
      await repo.run(['fetch', '-q', '--all', '--no-tags']);
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
      throw new TransferError(`${advice}. Fetching here failed: ${e.stderr.trim()}`);
    }
    fetched = true;
    if ((await verify()) === 'missing') throw new TransferError(`${advice}. They are not on its remotes either: has the other clone pushed them?`);
  }
  progress('Reading the export');
  await repo.run(['fetch', '-q', '--no-tags', '--no-write-fetch-head', path, `+${EXPORT_REF}:${IMPORT_REF}`]);

  try {
    const read = async (name: string) => repo.run(['cat-file', 'blob', `${IMPORT_REF}:${name}`]);
    let manifest: Manifest;
    try {
      manifest = JSON.parse((await read('manifest.json')).toString('utf8')) as Manifest;
    } catch {
      throw new TransferError(`${path} is not a postil export`);
    }
    if (manifest.format !== FORMAT) throw new TransferError(`${path} was written by a newer postil (export format ${manifest.format}); upgrade postil`);
    if (manifest.schema > MIGRATIONS.length) throw new TransferError(`${path} was written by a newer postil (${manifest.postil}); upgrade postil`);
    for (const oid of [manifest.worktree, ...manifest.trees, ...manifest.blobs]) assertOid(oid);
    if (manifest.base) assertOid(manifest.base);
    if (manifest.claude_session) assertSession(manifest.claude_session);

    const warnings: string[] = [];
    const identity = await repoIdentity(repo);
    if (manifest.repo !== identity) {
      const what = `the export is of ${manifest.repo ?? 'a repository without an origin'}, and this is ${identity ?? 'a repository without an origin'}`;
      if (!opts.force) throw new TransferError(`${what}. Pass --force to import it anyway`);
      warnings.push(what);
    }

    // Everything that can refuse does so before anything here changes.
    const dbPath = join(repo.stateDir, 'postil.db');
    if (existsSync(dbPath) && !opts.force) {
      const n = liveContent(dbPath);
      if (n > 0) {
        throw new TransferError(
          `this clone has a postil session of its own under way (${n} open conversation(s) or review(s)). ` +
            'Finish or reset it, or pass --force to replace it (its database is kept as a backup)',
        );
      }
    }
    const [head, current] = await Promise.all([repo.head(), repo.worktreeTree()]);
    let worktree: WorktreeState = current === manifest.worktree ? 'matches' : 'differs';
    // Bringing the working tree may first mean fast-forwarding to commits that never left the other clone.
    let fastForward = false;
    let worktreeNote: string | null = null;
    if (worktree === 'differs') {
      if (opts.worktree === false) {
        worktreeNote = 'you asked to leave it alone';
      } else if (current !== (await headTree(repo, head))) {
        worktreeNote = 'it has uncommitted changes of its own';
      } else if (head !== manifest.head) {
        const behind = manifest.head !== null && head !== null && (await repo.mergeBase(head, manifest.head)) === head;
        if (behind) fastForward = true;
        else worktreeNote = `it is at ${head?.slice(0, 7) ?? 'no commit'}, which the export does not build on; check out ${manifest.branch ?? 'the exported branch'}`;
      }
    }

    progress('Bringing over the review');
    // The database, with whatever was here kept aside.
    let backup: string | null = null;
    if (await moveAside(dbPath)) backup = `${dbPath}${BACKUP_SUFFIX}`;
    await moveAside(`${dbPath}-wal`);
    await moveAside(`${dbPath}-shm`);
    await writeFile(dbPath, await read('postil.db'), { mode: 0o600 });

    // Pins in this worktree's own namespace, whatever the other clone called its worktree.
    for (const tree of manifest.trees) await repo.pin(tree);
    for (const blob of manifest.blobs) await repo.pinBlob(blob);
    await repo.pinBase(manifest.base);
    // Keep the exported working tree too, so it can still be restored after gc.
    await repo.pin(manifest.worktree);

    if (worktree === 'differs' && worktreeNote === null) {
      progress(fastForward ? `Fast-forwarding to ${manifest.head!.slice(0, 7)} and restoring the working tree` : 'Restoring the working tree');
      if (fastForward) await repo.run(['merge', '-q', '--ff-only', manifest.head!]);
      await restoreWorktree(repo, await headTree(repo, await repo.head()), manifest.worktree);
      worktree = (await repo.worktreeTree()) === manifest.worktree ? 'restored' : 'differs';
    }

    let transcript: ImportResult['transcript'] = null;
    if (manifest.claude_session) {
      const name = `${manifest.claude_session}.jsonl`;
      const content = await read(`claude/${name}`);
      const projectDir = claudeProjectDir(repo.root);
      const existing = await findTranscript(manifest.claude_session, repo.root);
      if (existing && existing !== (projectDir && join(projectDir, name)) && !opts.force) {
        // Claude Code refuses to pick between two copies of one conversation.
        warnings.push(`Claude Code already has conversation ${manifest.claude_session} at ${existing}; it was left alone`);
        transcript = { path: existing, resumable: true };
      } else if (projectDir) {
        await mkdir(projectDir, { recursive: true });
        await writeFile(join(projectDir, name), content, { mode: 0o600 });
        transcript = { path: join(projectDir, name), resumable: true };
      } else {
        const dir = join(repo.stateDir, 'claude');
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(join(dir, name), content, { mode: 0o600 });
        transcript = { path: join(dir, name), resumable: false };
      }
    }

    let consumed = false;
    if (picked || (transferDir() !== null && dirname(path) === transferDir())) {
      consumed = await removeExport(path).then(() => true, () => false);
    }
    return { manifest, file: path, consumed, root: repo.root, worktree, worktreeNote, fetched, backup, transcript, warnings };
  } finally {
    await repo.run(['update-ref', '-d', IMPORT_REF]).catch(() => undefined);
  }
}
