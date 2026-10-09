import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Postil } from '../src/core/postil.ts';
import { importScript, moveSession, parseTarget, remotePath } from '../src/cli/move.ts';
import { claudeProjectDir, exportSession, importSession, TransferError } from '../src/core/transfer.ts';
import { makeFixture, numbered, type Fixture } from './helpers.ts';

/** A file's text with line endings as git stores them, since Windows checkouts may write CRLF. */
const text = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('moving a session to another clone', () => {
  let scratch: string;
  let origin: string;
  let a: Fixture;
  let b: Fixture;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'postil-transfer-'));
    process.env.CLAUDE_CONFIG_DIR = join(scratch, 'claude');
    origin = join(scratch, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    a = makeFixture();
    a.write('f.txt', numbered(10));
    a.commit('base');
    a.git('remote', 'add', 'origin', origin);
    a.git('push', '-q', 'origin', 'main');
    a.git('fetch', '-q', 'origin');
    b = makeFixture();
    b.git('remote', 'add', 'origin', origin);
    b.git('fetch', '-q', 'origin');
    b.git('checkout', '-q', '-B', 'main', 'origin/main');
  });

  afterEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.POSTIL_TRANSFER_DIR;
    a.cleanup();
    b.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  /** A submitted review with one thread on an uncommitted change, and a local commit under it. */
  async function startReview(): Promise<void> {
    a.write('g.txt', 'local commit\n');
    a.commit('not pushed');
    a.write('f.txt', numbered(10, { 3: 'changed' }));
    a.write('new.txt', 'untracked\n');
    const postil = await Postil.open(a.dir);
    try {
      const base = await postil.base();
      await postil.createThread({ from_tree: base.tree, to_tree: await postil.liveTree(), path: 'f.txt', side: 'new', start_line: 3, end_line: 3, body: 'why?' });
      await postil.submitReview();
    } finally {
      postil.close();
    }
  }

  it('carries conversations, snapshots, local commits and uncommitted changes', async () => {
    await startReview();
    const file = join(scratch, 'session.bundle');
    const exported = await exportSession(a.dir, { file });
    assert.equal(exported.manifest.trees.length > 0, true);
    assert.equal(a.git('for-each-ref', 'refs/postil-export/'), '', 'the temporary ref is gone');

    const r = await importSession(b.dir, file);
    assert.equal(r.worktree, 'restored');
    assert.equal(r.backup, null);
    assert.equal(text(join(b.dir, 'f.txt')), numbered(10, { 3: 'changed' }));
    assert.equal(text(join(b.dir, 'new.txt')), 'untracked\n');
    assert.equal(b.git('rev-parse', 'HEAD').trim(), a.git('rev-parse', 'HEAD').trim(), 'the local commit came along');
    assert.equal(b.git('for-each-ref', 'refs/postil-import/'), '');

    const postil = await Postil.open(b.dir);
    try {
      const [thread] = postil.threads();
      assert.equal(thread?.comments[0]?.body, 'why?');
      // The thread's snapshots are here and pinned, so its diff can be shown.
      const pinned = b.git('for-each-ref', '--format=%(objectname)', 'refs/postil/main/trees/').split('\n');
      assert.ok(pinned.includes(thread!.to_tree));
      assert.equal(b.git('cat-file', '-t', thread!.from_tree).trim(), 'tree');
      assert.equal((await postil.liveTree()), exported.manifest.worktree);
    } finally {
      postil.close();
    }
  });

  it('fetches first when this clone lacks commits the export builds on', async () => {
    a.write('f.txt', numbered(10, { 1: 'pushed' }));
    a.commit('pushed later');
    a.git('push', '-q', 'origin', 'main');
    a.git('fetch', '-q', 'origin');
    await startReview();
    const file = join(scratch, 'session.bundle');
    await exportSession(a.dir, { file });
    await assert.rejects(importSession(b.dir, file, { fetch: false }), (e) => e instanceof TransferError && /git fetch/.test(e.message));
    const r = await importSession(b.dir, file);
    assert.equal(r.fetched, true);
    // b's main is behind, so it fast-forwards through the pushed commit to the local one.
    assert.equal(r.worktree, 'restored');
  });

  it('keeps a session already under way here unless forced, and backs it up', async () => {
    await startReview();
    const file = join(scratch, 'session.bundle');
    await exportSession(a.dir, { file });

    b.write('f.txt', numbered(10, { 5: 'mine' }));
    const theirs = await Postil.open(b.dir);
    try {
      await theirs.createThread({ from_tree: (await theirs.base()).tree, to_tree: await theirs.liveTree(), path: 'f.txt', side: 'new', start_line: 5, body: 'mine' });
    } finally {
      theirs.close();
    }
    await assert.rejects(importSession(b.dir, file), (e) => e instanceof TransferError && /under way/.test(e.message));
    const r = await importSession(b.dir, file, { force: true });
    assert.ok(r.backup && existsSync(r.backup));
    assert.deepEqual([r.worktree, r.worktreeNote], ['differs', 'it has uncommitted changes of its own']);
    assert.equal(text(join(b.dir, 'f.txt')), numbered(10, { 5: 'mine' }), 'its own changes are left alone');
  });

  it('refuses a different repository unless forced', async () => {
    await startReview();
    const file = join(scratch, 'session.bundle');
    await exportSession(a.dir, { file });
    b.git('remote', 'set-url', 'origin', 'git@github.com:someone/else.git');
    await assert.rejects(importSession(b.dir, file), (e) => e instanceof TransferError && /someone\/else/.test(e.message));
  });

  it('brings along the Claude Code conversation that last listened', async () => {
    await startReview();
    const session = '0f0e0d0c-1111-2222-3333-444455556666';
    const from = claudeProjectDir(a.dir)!;
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, `${session}.jsonl`), '{"type":"user"}\n');
    const postil = await Postil.open(a.dir);
    try {
      postil.listen('no-transcript-here');
      postil.listen(session);
    } finally {
      postil.close();
    }
    assert.equal((await exportSession(a.dir, { file: join(scratch, 'none.bundle'), claudeSession: null })).manifest.claude_session, null);
    const file = join(scratch, 'session.bundle');
    assert.equal((await exportSession(a.dir, { file })).manifest.claude_session, session);
    // One machine stands in for two here, so drop the original as moving would.
    rmSync(from, { recursive: true });

    const r = await importSession(b.dir, file);
    assert.deepEqual(r.transcript, { path: join(claudeProjectDir(b.dir)!, `${session}.jsonl`), resumable: true });
    assert.equal(readFileSync(r.transcript!.path, 'utf8'), '{"type":"user"}\n');
    await assert.rejects(exportSession(a.dir, { file: join(scratch, 'other.bundle'), claudeSession: 'missing' }), TransferError);
  });

  it('goes through a synced folder, where import finds the newest export of its repository', async () => {
    await startReview();
    const dir = join(scratch, 'synced');
    process.env.POSTIL_TRANSFER_DIR = dir;
    await assert.rejects(importSession(b.dir, undefined), (e) => e instanceof TransferError && /no export of this repository/.test(e.message));

    const older = await exportSession(a.dir);
    assert.equal(dirname(older.file), dir);
    await new Promise((r) => setTimeout(r, 1100)); // names carry the time to the second
    const newer = await exportSession(a.dir);
    const other = makeFixture();
    try {
      other.write('x', '1\n');
      other.commit('other repository');
      await Postil.open(other.dir).then((p) => p.close());
      await exportSession(other.dir);
    } finally {
      other.cleanup();
    }

    const r = await importSession(b.dir, undefined);
    assert.equal(r.file, newer.file);
    assert.equal(r.consumed, true);
    assert.equal(existsSync(newer.file), false, 'removed once imported');
    assert.equal(existsSync(older.file), true);
    assert.equal(readdirSync(dir).length, 2, "the other repository's export is left alone");
  });

  it('moves over SSH in one command', { skip: process.platform === 'win32' && 'needs a POSIX shell' }, async () => {
    await startReview();
    // Stand-ins for scp and ssh that "reach" this computer, with its own home directory.
    const home = join(scratch, 'home');
    const bin = join(scratch, 'bin');
    mkdirSync(home);
    mkdirSync(bin);
    const shim = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    shim('scp', `while [ "$1" = -q ] || [ "$1" = -o ]; do [ "$1" = -o ] && shift; shift; done\ncp "$1" ${JSON.stringify(home)}/"\${2#*:}"`);
    shim('ssh', `while [ "$1" = -o ]; do shift 2; done\nshift\nHOME=${JSON.stringify(home)} exec "$@"`);
    shim('postil', `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'cli', 'main.ts'))} "$@"`);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    let log = '';
    try {
      const r = await moveSession(a.dir, `me@laptop:${b.dir}`, { claudeSession: null, interactive: false, output: (c) => { log += c; } });
      assert.equal(r.host, 'me@laptop');
    } finally {
      process.env.PATH = path;
    }
    assert.match(log, /imported the postil session/);
    assert.equal(text(join(b.dir, 'f.txt')), numbered(10, { 3: 'changed' }));
    assert.equal(existsSync(join(b.dir, '.git', 'postil', 'postil.db')), true);
    assert.deepEqual(readdirSync(home), [], 'the copied file is removed once imported');
  });
});

describe('postil move', () => {
  it('finds the clone where this one is, relative to the home directory', () => {
    assert.equal(remotePath(undefined, join(homedir(), 'src', 'repo')), '~/src/repo');
    assert.equal(remotePath('/srv/repo', join(homedir(), 'src', 'repo')), '/srv/repo');
    assert.deepEqual(parseTarget('me@box', join(homedir(), 'r')), { host: 'me@box', path: '~/r' });
    assert.deepEqual(parseTarget('box:~/other', join(homedir(), 'r')), { host: 'box', path: '~/other' });
    assert.throws(() => parseTarget('-oProxyCommand=x', '/r'), /not an SSH host/);
  });

  it('quotes paths for the shell over there', () => {
    const script = importScript("~/it's here", 'f.bundle', { worktree: false });
    assert.match(script, /^cd "\$HOME"\/'it'\\''s here'$/m);
    assert.match(script, /^postil import --no-resume --no-worktree "\$HOME"\/'f\.bundle'$/m);
  });
});
