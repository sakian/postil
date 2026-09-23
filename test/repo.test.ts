import { strict as assert } from 'node:assert';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Repo } from '../src/git/repo.ts';
import { makeFixture, numbered, type Fixture } from './helpers.ts';

describe('Repo.worktreeTree', () => {
  let fx: Fixture;
  let repo: Repo;
  before(async () => {
    fx = makeFixture();
    fx.write('a.txt', numbered(3));
    fx.write('b.txt', 'keep\n');
    fx.commit('base');
    repo = await Repo.open(fx.dir);
  });
  after(() => fx.cleanup());

  it('captures modified, untracked and deleted files without touching the real index', async () => {
    fx.write('a.txt', numbered(3, { 2: 'changed' }));
    fx.git('add', 'a.txt'); // staged work the user expects to keep
    fx.write('c.txt', 'untracked\n');
    fx.remove('b.txt');
    const indexBefore = readFileSync(join(fx.dir, '.git/index'));

    const tree = await repo.worktreeTree();
    const listing = fx.git('ls-tree', '--name-only', tree).trim().split('\n');
    assert.deepEqual(listing, ['a.txt', 'c.txt']);
    assert.deepEqual(readFileSync(join(fx.dir, '.git/index')), indexBefore);
    assert.match(fx.git('status', '--porcelain'), /^M  a\.txt$/m, 'staged change preserved');
  });

  it('keeps its state out of the working tree', async () => {
    await repo.worktreeTree();
    assert.ok(repo.stateDir.startsWith(join(fx.dir, '.git')));
    assert.doesNotMatch(fx.git('status', '--porcelain', '--ignored'), /postil/);
  });

  it('reflects later deletions and edits through the persistent private index', async () => {
    const first = await repo.worktreeTree();
    fx.remove('c.txt');
    fx.write('a.txt', numbered(4));
    const second = await repo.worktreeTree();
    assert.notEqual(first, second);
    assert.deepEqual(fx.git('ls-tree', '--name-only', second).trim().split('\n'), ['a.txt']);
    assert.equal(await repo.worktreeTree(), second, 'same content gives the same tree');
  });

  it('respects .gitignore', async () => {
    fx.write('.gitignore', 'build/\n');
    fx.write('build/out.bin', 'x');
    const names = fx.git('ls-tree', '-r', '--name-only', await repo.worktreeTree());
    assert.doesNotMatch(names, /build\//);
  });

  it('ignores inherited variables that would redirect git elsewhere', async () => {
    const saved = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = join(fx.dir, 'bogus-index');
    try {
      const tree = await repo.worktreeTree();
      assert.match(tree, /^[0-9a-f]{40}$/);
      assert.doesNotMatch(fx.git('status', '--porcelain', '--ignored'), /bogus-index/);
    } finally {
      if (saved === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = saved;
    }
  });

  it('serialises concurrent callers on the private index', async () => {
    const trees = await Promise.all(Array.from({ length: 8 }, () => repo.worktreeTree()));
    assert.equal(new Set(trees).size, 1);
  });
});

describe('Repo on an unborn branch', () => {
  it('snapshots a repository with no commits yet', async () => {
    const fx = makeFixture();
    try {
      fx.write('first.txt', 'hello\n');
      const repo = await Repo.open(fx.dir);
      assert.equal(await repo.head(), null);
      const tree = await repo.worktreeTree();
      assert.equal(fx.git('ls-tree', '--name-only', tree).trim(), 'first.txt');
    } finally {
      fx.cleanup();
    }
  });
});

describe('Repo pinning', () => {
  it('keeps pinned trees through an aggressive gc and lets unpinned ones go', async () => {
    const fx = makeFixture();
    try {
      fx.write('a.txt', 'a\n');
      fx.commit('base');
      const repo = await Repo.open(fx.dir);
      fx.write('pinned.txt', 'keep me\n');
      const pinned = await repo.worktreeTree();
      await repo.pin(pinned);
      fx.remove('pinned.txt');
      fx.write('loose.txt', 'drop me\n');
      const loose = await repo.worktreeTree();
      fx.remove('loose.txt');
      await repo.worktreeTree(); // move the private index on so it no longer references `loose`

      fx.git('gc', '--prune=now', '-q');
      assert.equal(await repo.objectType(pinned), 'tree');
      assert.equal(await repo.objectType(loose), null);
      assert.deepEqual(await repo.pinnedTrees(), [pinned]);
      assert.doesNotMatch(fx.git('log', '--all', '--oneline'), /pinned/);

      await repo.unpin(pinned);
      assert.deepEqual(await repo.pinnedTrees(), []);
    } finally {
      fx.cleanup();
    }
  });
});

describe('Repo diffs', () => {
  let fx: Fixture;
  let repo: Repo;
  let base: string;
  before(async () => {
    fx = makeFixture();
    fx.write('mod.txt', numbered(30));
    fx.write('del.txt', 'bye\n');
    fx.write('mv/old.ts', numbered(20));
    fx.write('img.bin', Buffer.from([0, 1, 2, 3, 0, 255]));
    fx.write('run.sh', 'echo hi\n');
    fx.write('noeol.txt', 'a\nb');
    fx.commit('base');
    repo = await Repo.open(fx.dir);
    base = await repo.resolveTree('HEAD');

    fx.write('mod.txt', numbered(30, { 2: 'two', 25: 'twenty-five' }));
    fx.remove('del.txt');
    fx.remove('mv/old.ts');
    fx.write('mv/new.ts', numbered(20, { 20: 'renamed tail' }));
    fx.write('add.txt', 'x\ny\n');
    fx.write('img.bin', Buffer.from([0, 9, 9, 9, 0, 255]));
    fx.git('update-index', '--chmod=+x', 'run.sh');
    fx.symlink('mod.txt', 'link');
    fx.write('noeol.txt', 'a\nB');
  });
  after(() => fx.cleanup());

  it('lists every kind of change with counts', async () => {
    const files = await repo.diffFiles(base, await repo.worktreeTree());
    const byPath = new Map(files.map((f) => [f.path, f]));
    assert.deepEqual([...byPath.keys()], ['add.txt', 'del.txt', 'img.bin', 'link', 'mod.txt', 'mv/new.ts', 'noeol.txt']);
    assert.equal(byPath.get('add.txt')?.status, 'added');
    assert.equal(byPath.get('del.txt')?.status, 'deleted');
    assert.equal(byPath.get('mod.txt')?.additions, 2);
    assert.equal(byPath.get('mod.txt')?.deletions, 2);
    assert.equal(byPath.get('img.bin')?.kind, 'binary');
    assert.equal(byPath.get('img.bin')?.additions, null);
    assert.equal(byPath.get('link')?.kind, 'symlink');
    const renamed = byPath.get('mv/new.ts');
    assert.equal(renamed?.status, 'renamed');
    assert.equal(renamed?.old_path, 'mv/old.ts');
    assert.ok((renamed?.similarity ?? 0) >= 90);
  });

  it('does not report run.sh, because the private index snapshots the working tree, not the staged mode', async () => {
    // update-index --chmod changes only the real index; the file on disk is still 644.
    const files = await repo.diffFiles(base, await repo.worktreeTree());
    assert.equal(files.some((f) => f.path === 'run.sh'), false);
  });

  it('produces hunks between blobs with correct numbering and separate hunks for distant edits', async () => {
    const file = (await repo.diffFiles(base, await repo.worktreeTree())).find((f) => f.path === 'mod.txt')!;
    const { hunks } = await repo.diffBlobs(file.old_blob, file.new_blob);
    assert.equal(hunks.length, 2);
    const firstChange = hunks[0]!.lines.find((l) => l.kind === 'add');
    assert.deepEqual([firstChange?.new_no, firstChange?.text], [2, 'two']);
    const { hunks: wide } = await repo.diffBlobs(file.old_blob, file.new_blob, { context: 20 });
    assert.equal(wide.length, 1, 'wide context merges the two hunks');
  });

  it('diffs additions and deletions against the empty blob', async () => {
    const files = await repo.diffFiles(base, await repo.worktreeTree());
    const added = files.find((f) => f.path === 'add.txt')!;
    const { hunks } = await repo.diffBlobs(null, added.new_blob);
    assert.deepEqual(hunks[0]?.lines.map((l) => [l.kind, l.new_no]), [['add', 1], ['add', 2]]);
    const deleted = files.find((f) => f.path === 'del.txt')!;
    assert.equal((await repo.diffBlobs(deleted.old_blob, null)).hunks[0]?.lines[0]?.kind, 'del');
  });

  it('reports a missing final newline', async () => {
    const f = (await repo.diffFiles(base, await repo.worktreeTree())).find((x) => x.path === 'noeol.txt')!;
    const lines = (await repo.diffBlobs(f.old_blob, f.new_blob)).hunks[0]!.lines;
    assert.ok(lines.filter((l) => l.kind !== 'context').every((l) => l.no_eol === true));
  });

  it('flags binary content when diffing blobs', async () => {
    const f = (await repo.diffFiles(base, await repo.worktreeTree())).find((x) => x.path === 'img.bin')!;
    assert.equal((await repo.diffBlobs(f.old_blob, f.new_blob)).binary, true);
  });

  it('reads blob info and resolves entries by literal path', async () => {
    fx.write('weird/*[x].ts', 'glob-looking name\n');
    fx.write('weird/a.ts', 'other\n');
    const tree = await repo.worktreeTree();
    const entry = await repo.entryAt(tree, 'weird/*[x].ts');
    assert.equal(entry?.type, 'blob');
    const info = await repo.blobInfo(entry!.oid);
    assert.deepEqual([info.lines, info.binary], [1, false]);
    assert.equal(await repo.entryAt(tree, 'weird/nope.ts'), null);
  });

  it('refuses revisions that git would parse as options', async () => {
    await assert.rejects(repo.resolveCommit('--output=/tmp/x'), /invalid revision/);
    await assert.rejects(repo.resolveCommit('HEAD extra'), /invalid revision/);
    await assert.rejects(repo.readBlob('not-a-sha'), /invalid blob id/);
  });
});

describe('Repo history', () => {
  it('finds the default branch, merge base and commit log', async () => {
    const fx = makeFixture();
    try {
      fx.write('a', '1\n');
      const root = fx.commit('root');
      fx.git('switch', '-q', '-c', 'feature');
      fx.write('a', '2\n');
      const c1 = fx.commit('feature one');
      fx.write('a', '3\n');
      const c2 = fx.commit('feature two');
      const repo = await Repo.open(fx.dir);
      assert.equal(await repo.defaultBranch(), 'main');
      assert.equal(await repo.currentBranch(), 'feature');
      assert.equal(await repo.mergeBase('HEAD', 'main'), root);
      const log = await repo.log(root, c2);
      assert.deepEqual(log.map((c) => c.subject), ['feature two', 'feature one']);
      assert.deepEqual(log[0]?.parents, [c1]);
    } finally {
      fx.cleanup();
    }
  });
});

describe('Repo pins across worktrees', () => {
  it('keeps each worktree\'s pins separate, so pruning one cannot release another\'s', async () => {
    const fx = makeFixture();
    const linkedDir = `${fx.dir}-linked`;
    try {
      fx.write('a.txt', '1\n');
      fx.commit('base');
      fx.git('worktree', 'add', '-q', linkedDir);
      const main = await Repo.open(fx.dir);
      const linked = await Repo.open(linkedDir);
      assert.equal(main.worktreeId, 'main');
      assert.match(linked.worktreeId, /^wt-/);
      assert.notEqual(main.stateDir, linked.stateDir);

      fx.write('a.txt', 'main edit\n');
      const mainTree = await main.worktreeTree();
      await main.pin(mainTree);
      writeFileSync(join(linkedDir, 'a.txt'), 'linked edit\n');
      const linkedTree = await linked.worktreeTree();
      await linked.pin(linkedTree);

      assert.deepEqual(await main.pinnedTrees(), [mainTree]);
      assert.deepEqual(await linked.pinnedTrees(), [linkedTree]);
      await main.unpin(mainTree); // what a prune in the main worktree does
      fx.git('gc', '--prune=now', '-q');
      assert.equal(await linked.objectType(linkedTree), 'tree', "the linked worktree's pin survives");
    } finally {
      fx.cleanup();
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});
