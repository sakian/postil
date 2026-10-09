import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Postil } from '../src/core/postil.ts';
import { claudeProjectDir, exportSession, importSession, TransferError } from '../src/core/transfer.ts';
import { makeFixture, numbered, type Fixture } from './helpers.ts';

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

    const r = await importSession(b.dir, file, { worktree: true });
    assert.equal(r.worktree, 'restored');
    assert.equal(r.backup, null);
    assert.equal(readFileSync(join(b.dir, 'f.txt'), 'utf8'), numbered(10, { 3: 'changed' }));
    assert.equal(readFileSync(join(b.dir, 'new.txt'), 'utf8'), 'untracked\n');
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

  it('asks for a fetch when this clone lacks commits the export builds on', async () => {
    a.write('f.txt', numbered(10, { 1: 'pushed' }));
    a.commit('pushed later');
    a.git('push', '-q', 'origin', 'main');
    a.git('fetch', '-q', 'origin');
    await startReview();
    const file = join(scratch, 'session.bundle');
    await exportSession(a.dir, { file });
    await assert.rejects(importSession(b.dir, file), (e) => e instanceof TransferError && /git fetch/.test(e.message));
    b.git('fetch', '-q', 'origin');
    const r = await importSession(b.dir, file);
    assert.equal(r.worktree, 'differs');
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
    await assert.rejects(importSession(b.dir, file, { force: true, worktree: true }), (e) => e instanceof TransferError && /uncommitted/.test(e.message));
    const r = await importSession(b.dir, file, { force: true });
    assert.ok(r.backup && existsSync(r.backup));
  });

  it('refuses a different repository unless forced', async () => {
    await startReview();
    const file = join(scratch, 'session.bundle');
    await exportSession(a.dir, { file });
    b.git('remote', 'set-url', 'origin', 'git@github.com:someone/else.git');
    await assert.rejects(importSession(b.dir, file), (e) => e instanceof TransferError && /someone\/else/.test(e.message));
  });

  it('brings the Claude Code conversation along', async () => {
    await startReview();
    const session = '0f0e0d0c-1111-2222-3333-444455556666';
    const from = claudeProjectDir(a.dir)!;
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, `${session}.jsonl`), '{"type":"user"}\n');
    const file = join(scratch, 'session.bundle');
    await exportSession(a.dir, { file, claudeSession: session });
    // One machine stands in for two here, so drop the original as moving would.
    rmSync(from, { recursive: true });

    const r = await importSession(b.dir, file);
    assert.deepEqual(r.transcript, { path: join(claudeProjectDir(b.dir)!, `${session}.jsonl`), resumable: true });
    assert.equal(readFileSync(r.transcript!.path, 'utf8'), '{"type":"user"}\n');
    await assert.rejects(exportSession(a.dir, { file: join(scratch, 'other.bundle'), claudeSession: 'missing' }), TransferError);
  });
});
