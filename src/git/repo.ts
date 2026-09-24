import { execFile } from 'node:child_process';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { basename, join, resolve as resolvePath } from 'node:path';
import { ByteLru, HttpError, Mutex } from '../core/util.ts';
import { git, GitError, gitLine, gitText, type GitRunOptions } from './exec.ts';
import {
  countLines, LOG_FORMAT, looksBinary, parseLog, parseNumstatZ, parseRawZ, parseUnifiedDiff,
  type ParsedFileDiff,
} from './parse.ts';
import type { Commit, FileChange } from './types.ts';

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function isOid(value: string): boolean {
  return OID.test(value);
}

export function assertOid(value: string, what = 'object id'): string {
  if (!OID.test(value)) throw new HttpError(400, `invalid ${what}: ${JSON.stringify(value)}`, 'invalid_oid');
  return value;
}

/**
 * Revisions come from API callers. A leading dash would be parsed as a git option, so
 * reject it along with whitespace and control characters, which no valid ref contains.
 */
export function assertRev(value: string): string {
  if (value === '' || value.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(value)) {
    throw new HttpError(400, `invalid revision: ${JSON.stringify(value)}`, 'invalid_rev');
  }
  return value;
}

/** Namespace for refs that keep postil's snapshot trees alive through `git gc`. */
/**
 * Pins live under refs/postil/<worktree>/, one namespace per worktree. Linked worktrees share
 * the repository's refs, and a shared namespace would let one worktree's prune release what
 * another worktree still needs.
 */
export const PIN_ROOT = 'refs/postil/';

export interface TreeEntry {
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  oid: string;
}

export interface BlobDiffOptions {
  context?: number;
  ignoreWhitespace?: boolean;
}

export interface BlobInfo {
  oid: string;
  size: number;
  lines: number;
  binary: boolean;
}

export class Repo {
  private readonly indexMutex = new Mutex();
  private readonly blobs = new ByteLru<string>(64 * 1024 * 1024, 8 * 1024 * 1024);
  private emptyTreeOid: string | undefined;
  /** Tree ids are content addresses, so a lookup in a tree never changes. */
  private readonly entries = new Map<string, TreeEntry | null>();
  private emptyBlobOid: string | undefined;

  /** Top level of the working tree. */
  readonly root: string;
  /** Absolute git dir for this worktree (per-worktree for linked worktrees). */
  readonly gitDir: string;

  /** This worktree's pin namespace: "main", or the name git gave a linked worktree. */
  readonly worktreeId: string;

  private constructor(root: string, gitDir: string, commonDir: string) {
    this.root = root;
    this.gitDir = gitDir;
    // A linked worktree's git dir is <common>/worktrees/<name>; the name survives moving the checkout.
    this.worktreeId = resolvePath(gitDir) === resolvePath(commonDir) ? 'main' : `wt-${basename(gitDir)}`;
  }

  private get treePins(): string {
    return `${PIN_ROOT}${this.worktreeId}/trees/`;
  }

  private get blobPins(): string {
    return `${PIN_ROOT}${this.worktreeId}/blobs/`;
  }

  /** Postil state lives in the git dir: `git clean -fdx` cannot reach it and snapshots cannot capture it. */
  get stateDir(): string {
    return join(this.gitDir, 'postil');
  }

  static async open(cwd: string): Promise<Repo> {
    let out: string;
    try {
      out = await gitText(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
    } catch (e) {
      if (e instanceof GitError) throw new Error(`not inside a git working tree: ${cwd}`);
      throw e;
    }
    const [root, gitDir, commonDir] = out.trim().split(/\r?\n/);
    if (!root || !gitDir || !commonDir) throw new Error(`could not locate the repository from ${cwd}`);
    // Git for Windows reports C:/forward/slashes; resolve gives the native form Node's paths use.
    const repo = new Repo(resolvePath(root), resolvePath(gitDir), resolvePath(commonDir));
    await mkdir(repo.stateDir, { recursive: true, mode: 0o700 });
    return repo;
  }

  run(args: readonly string[], opts?: GitRunOptions): Promise<Buffer> {
    return git(this.root, args, opts);
  }

  // ---------------------------------------------------------------- revisions

  /** The commit HEAD points at, or null on an unborn branch. */
  async head(): Promise<string | null> {
    return gitLine(this.root, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { okCodes: [1] });
  }

  async currentBranch(): Promise<string | null> {
    return gitLine(this.root, ['symbolic-ref', '-q', '--short', 'HEAD'], { okCodes: [1] });
  }

  async resolveCommit(rev: string): Promise<string> {
    return this.resolveAs(rev, 'commit');
  }

  async resolveTree(rev: string): Promise<string> {
    return this.resolveAs(rev, 'tree');
  }

  private async resolveAs(rev: string, type: 'commit' | 'tree'): Promise<string> {
    assertRev(rev);
    const oid = await gitLine(this.root, ['rev-parse', '-q', '--verify', `${rev}^{${type}}`], { okCodes: [1] });
    if (!oid) throw new HttpError(404, `no ${type} for revision ${JSON.stringify(rev)}`, 'unknown_rev');
    return oid;
  }

  async objectType(oid: string): Promise<string | null> {
    assertOid(oid);
    try {
      return (await gitText(this.root, ['cat-file', '-t', oid])).trim();
    } catch (e) {
      if (e instanceof GitError) return null;
      throw e;
    }
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    return gitLine(this.root, ['merge-base', assertRev(a), assertRev(b)], { okCodes: [1] });
  }

  /**
   * The branch that feature work is measured against. Prefers the local branch named by
   * origin/HEAD, so unpushed commits on it do not show up as part of the feature diff.
   */
  async defaultBranch(): Promise<string | null> {
    const remoteHead = await gitLine(this.root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { okCodes: [1] });
    const candidates: string[] = [];
    if (remoteHead) {
      candidates.push(remoteHead.replace(/^origin\//, ''), remoteHead);
    }
    candidates.push('main', 'master');
    for (const name of candidates) {
      const ref = name.includes('/') ? `refs/remotes/${name}` : `refs/heads/${name}`;
      if (await this.refExists(ref)) return name;
    }
    return null;
  }

  /**
   * A branch by name: local first, so unpushed commits on it stay out of a feature diff, then a
   * remote-tracking branch as given (origin/dev), then origin's. Null when none exists.
   */
  async findBranch(name: string): Promise<string | null> {
    if (await this.refExists(`refs/heads/${name}`)) return name;
    if (await this.refExists(`refs/remotes/${name}`)) return name;
    if (await this.refExists(`refs/remotes/origin/${name}`)) return `origin/${name}`;
    return null;
  }

  /**
   * The branch that the current branch's open pull request targets, asked of the GitHub CLI.
   * Null when gh is missing, signed out, offline or slow, or there is no pull request.
   */
  pullRequestBase(): Promise<string | null> {
    return new Promise((done) => {
      execFile(
        'gh', ['pr', 'view', '--json', 'baseRefName', '--jq', '.baseRefName'],
        { cwd: this.root, timeout: 5000, windowsHide: true, encoding: 'utf8', env: { ...process.env, GH_PROMPT_DISABLED: '1' } },
        (err, stdout) => done(err ? null : stdout.trim() || null),
      );
    });
  }

  private async refExists(ref: string): Promise<boolean> {
    try {
      await git(this.root, ['show-ref', '--verify', '-q', ref]);
      return true;
    } catch {
      return false;
    }
  }

  /** Commits reachable from `to` but not from `from`, newest first. */
  async log(from: string | null, to: string, limit = 500): Promise<Commit[]> {
    const range = from ? `${assertOid(from)}..${assertOid(to)}` : assertOid(to);
    const text = await gitText(this.root, [
      '-c', 'log.showSignature=false',
      'log', `--format=${LOG_FORMAT}`, '--topo-order', `--max-count=${limit}`, range, '--',
    ]);
    return parseLog(text);
  }

  // ---------------------------------------------------------------- objects

  async emptyTree(): Promise<string> {
    this.emptyTreeOid ??= (await gitText(this.root, ['hash-object', '-t', 'tree', '--stdin'])).trim();
    return this.emptyTreeOid;
  }

  /** Written to the object store, because git 2.43 does not treat the empty blob as built in. */
  async emptyBlob(): Promise<string> {
    this.emptyBlobOid ??= (await gitText(this.root, ['hash-object', '-w', '--stdin'])).trim();
    return this.emptyBlobOid;
  }

  async readBlob(oid: string): Promise<Buffer> {
    assertOid(oid, 'blob id');
    const cached = this.blobs.get(oid);
    if (cached) return cached;
    let content: Buffer;
    try {
      content = await git(this.root, ['cat-file', 'blob', oid]);
    } catch (e) {
      if (e instanceof GitError) throw new HttpError(404, `no blob ${oid}`, 'unknown_blob');
      throw e;
    }
    this.blobs.set(oid, content);
    return content;
  }

  /** Size in bytes, without reading the content. */
  async blobSize(oid: string): Promise<number> {
    assertOid(oid, 'blob id');
    try {
      return Number((await gitText(this.root, ['cat-file', '-s', oid])).trim());
    } catch (e) {
      if (e instanceof GitError) throw new HttpError(404, `no blob ${oid}`, 'unknown_blob');
      throw e;
    }
  }

  async blobInfo(oid: string): Promise<BlobInfo> {
    const content = await this.readBlob(oid);
    return { oid, size: content.length, lines: countLines(content), binary: looksBinary(content) };
  }

  /** The entry at `path` in `tree`, or null if the path does not exist there. */
  async entryAt(tree: string, path: string): Promise<TreeEntry | null> {
    assertOid(tree, 'tree id');
    const key = `${tree}\0${path}`;
    if (this.entries.has(key)) return this.entries.get(key)!;
    const entry = await this.lookupEntry(tree, path);
    if (this.entries.size > 20_000) this.entries.clear();
    this.entries.set(key, entry);
    return entry;
  }

  private async lookupEntry(tree: string, path: string): Promise<TreeEntry | null> {
    const out = await gitText(this.root, ['ls-tree', '-z', '--full-tree', tree, '--', path], {
      env: { GIT_LITERAL_PATHSPECS: '1' },
    });
    for (const record of out.split('\0')) {
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const [mode, type, oid] = record.slice(0, tab).split(' ');
      if (record.slice(tab + 1) !== path || !mode || !type || !oid) continue;
      if (type !== 'blob' && type !== 'tree' && type !== 'commit') continue;
      return { mode, type, oid };
    }
    return null;
  }

  // ---------------------------------------------------------------- snapshots

  /**
   * The tree object for the working tree as it is right now, including untracked files and
   * honouring .gitignore. Built in a private index so the user's real index is never touched.
   *
   * The private index persists between calls, which keeps git's stat cache warm: only files
   * whose metadata changed are re-hashed. It is seeded from a copy of the real index for the
   * same reason. Correctness never depends on its prior contents, because `git add -A` makes
   * it match the working tree exactly.
   */
  async worktreeTree(): Promise<string> {
    return this.indexMutex.run(async () => {
      const index = join(this.stateDir, 'worktree.index');
      try {
        return await this.buildTree(index, false);
      } catch (e) {
        if (!(e instanceof GitError)) throw e;
        // An index git cannot read, for example a copied split index. Rebuild it from HEAD.
        return this.buildTree(index, true);
      }
    });
  }

  private async buildTree(index: string, reseedFromHead: boolean): Promise<string> {
    const env = { GIT_INDEX_FILE: index };
    // Only this process uses the private index, and the mutex serialises access, so a
    // leftover lock can only come from a crash and is safe to remove.
    await rm(`${index}.lock`, { force: true });
    if (reseedFromHead) await rm(index, { force: true });

    if (!(await exists(index))) {
      const realIndex = (await gitText(this.root, ['rev-parse', '--git-path', 'index'])).trim();
      const realPath = realIndex.startsWith('/') ? realIndex : join(this.root, realIndex);
      if (!reseedFromHead && (await exists(realPath))) {
        await copyFile(realPath, index);
      } else if (await this.head()) {
        await git(this.root, ['read-tree', 'HEAD'], { env });
      }
    }
    await git(this.root, ['add', '-A'], { env });
    return (await gitText(this.root, ['write-tree'], { env })).trim();
  }

  /** Keep a tree alive through `git gc`. Idempotent. Refs to trees stay out of `git log --all`. */
  async pin(tree: string): Promise<void> {
    assertOid(tree, 'tree id');
    await git(this.root, ['update-ref', `${this.treePins}${tree}`, tree]);
  }

  async unpin(tree: string): Promise<void> {
    assertOid(tree, 'tree id');
    await git(this.root, ['update-ref', '-d', `${this.treePins}${tree}`]);
  }

  /** Keep a blob alive through `git gc`, as for a section mark on a version never snapshotted. */
  async pinBlob(blob: string): Promise<void> {
    assertOid(blob, 'blob id');
    await git(this.root, ['update-ref', `${this.blobPins}${blob}`, blob]);
  }

  async unpinBlob(blob: string): Promise<void> {
    assertOid(blob, 'blob id');
    await git(this.root, ['update-ref', '-d', `${this.blobPins}${blob}`]);
  }

  async pinnedBlobs(): Promise<string[]> {
    const out = await gitText(this.root, ['for-each-ref', '--format=%(objectname)', this.blobPins]);
    return out.split('\n').filter((l) => l !== '');
  }

  /** Keep the commit chosen as the review base alive through rebases and gc; null releases it. */
  async pinBase(commit: string | null): Promise<void> {
    const ref = `${PIN_ROOT}${this.worktreeId}/base`;
    if (commit === null) await git(this.root, ['update-ref', '-d', ref]);
    else await git(this.root, ['update-ref', ref, assertOid(commit, 'commit id')]);
  }

  async pinnedTrees(): Promise<string[]> {
    const out = await gitText(this.root, ['for-each-ref', '--format=%(objectname)', this.treePins]);
    return out.split('\n').filter((l) => l !== '');
  }

  // ---------------------------------------------------------------- diffs

  /** Changed files between two trees, with rename detection and line counts. */
  async diffFiles(from: string, to: string): Promise<FileChange[]> {
    assertOid(from, 'tree id');
    assertOid(to, 'tree id');
    // Plumbing, so user diff configuration (external tools, colour, prefixes) cannot alter the output.
    const [raw, numstat] = await Promise.all([
      git(this.root, ['diff-tree', '-r', '-z', '--raw', '--no-abbrev', '-M', from, to]),
      git(this.root, ['diff-tree', '-r', '-z', '--numstat', '-M', from, to]),
    ]);
    const files = parseRawZ(raw);
    const counts = parseNumstatZ(numstat);
    for (const file of files) {
      if (file.kind === 'submodule') continue;
      const entry = counts.get(file.new_path ?? file.old_path ?? file.path);
      if (!entry) continue;
      if (entry.additions === null) {
        if (file.kind === 'text') file.kind = 'binary';
      } else {
        file.additions = entry.additions;
        file.deletions = entry.deletions;
      }
    }
    return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Hunks between two blobs. A null side means the file is absent on that side. */
  async diffBlobs(oldBlob: string | null, newBlob: string | null, opts: BlobDiffOptions = {}): Promise<ParsedFileDiff> {
    const context = opts.context ?? 3;
    if (!Number.isInteger(context) || context < 0 || context > 1000) {
      throw new HttpError(400, 'context must be an integer from 0 to 1000', 'invalid_context');
    }
    const a = oldBlob === null ? await this.emptyBlob() : assertOid(oldBlob, 'blob id');
    const b = newBlob === null ? await this.emptyBlob() : assertOid(newBlob, 'blob id');
    if (a === b) return { binary: false, hunks: [] };

    const text = await gitText(this.root, [
      // Porcelain is the only way to diff two blobs, so neutralise every config that changes its output.
      '-c', 'diff.suppressBlankEmpty=false',
      '-c', 'diff.noprefix=false',
      '-c', 'diff.mnemonicPrefix=false',
      'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--histogram',
      `-U${context}`, '--inter-hunk-context=0',
      ...(opts.ignoreWhitespace ? ['-w'] : []),
      a, b,
    ]);
    return parseUnifiedDiff(text);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
