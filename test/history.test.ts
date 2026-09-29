import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { History, normalizeRemote } from '../src/core/history.ts';
import { Postil } from '../src/core/postil.ts';
import { HttpError } from '../src/core/util.ts';
import { makeFixture } from './helpers.ts';

describe('normalizeRemote', () => {
  it('gives one identity for every way of cloning a repository', () => {
    for (const url of [
      'git@github.com:Owner/Repo.git',
      'https://github.com/Owner/Repo.git',
      'https://user:secret@GitHub.com/Owner/Repo/',
      'ssh://git@github.com/Owner/Repo',
      'ssh://git@github.com:22/Owner/Repo.git',
    ]) assert.equal(normalizeRemote(url), 'github.com/Owner/Repo', url);
  });

  it('leaves local paths alone', () => {
    assert.equal(normalizeRemote('/srv/git/repo.git'), '/srv/git/repo');
    assert.equal(normalizeRemote('C:\\git\\repo'), 'C:/git/repo');
  });
});

describe('History', () => {
  it('finds the latest entry per repository and branch, skipping lines it cannot read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postil-history-'));
    try {
      const history = new History(join(dir, 'nested', 'history.jsonl'));
      assert.equal(await history.latest('r', 'main'), null, 'no file yet');
      await history.append({ repo: 'r', branch: 'main', tree: 'b'.repeat(40), head: null, finished_at: '2026-02-01T00:00:00Z' });
      await history.append({ repo: 'r', branch: 'main', tree: 'a'.repeat(40), head: null, finished_at: '2026-01-01T00:00:00Z' });
      await history.append({ repo: 'r', branch: 'dev', tree: 'c'.repeat(40), head: null, finished_at: '2026-03-01T00:00:00Z' });
      await history.append({ repo: 'other', branch: 'main', tree: 'd'.repeat(40), head: null, finished_at: '2026-04-01T00:00:00Z' });
      writeFileSync(history.file, `${readFileSync(history.file, 'utf8')}{"v":1,"repo":"r","bra\n`);
      assert.equal((await history.latest('r', 'main'))?.tree, 'b'.repeat(40), 'ordered by time, not by line');
      assert.equal((await history.latest('r', 'dev'))?.tree, 'c'.repeat(40));
      assert.equal(await history.latest('r', null), null);
      assert.equal((await history.entries('r')).length, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('finishing a session', () => {
  it('records the reviewed tree, starts the next session fresh, and diffs since it from another clone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postil-history-'));
    const history = new History(join(dir, 'history.jsonl'));
    const a = makeFixture();
    const b = makeFixture();
    try {
      a.write('f.txt', '1\n');
      a.commit('base');
      a.git('remote', 'add', 'origin', 'git@github.com:Owner/Repo.git');
      const postil = await Postil.open(a.dir, undefined, history);
      await assert.rejects(postil.resolveScope({ kind: 'last_session' }), (e) => e instanceof HttpError && e.code === 'no_history');

      a.write('f.txt', '2\n');
      const reviewed = await postil.liveTree();
      const all = await postil.resolveScope({ kind: 'all' });
      const file = (await postil.files(all.from.tree, all.to.tree))[0]!;
      postil.setFileMark('f.txt', file.new_blob!, true);
      postil.setUiState('scope', { kind: 'uncommitted' });

      await postil.finishSession();
      const [entry] = await history.entries('github.com/Owner/Repo');
      assert.equal(entry?.tree, reviewed);
      assert.equal(entry?.branch, 'main');
      assert.deepEqual(postil.fileMarks(), [], 'nothing is viewed in the next session');
      assert.equal(postil.uiState('scope'), null, 'the next session opens on all changes');

      a.write('g.txt', 'new\n');
      const since = await postil.resolveScope({ kind: 'last_session' });
      assert.equal(since.from.tree, reviewed);
      assert.deepEqual((await postil.files(since.from.tree, since.to.tree)).map((f) => f.path), ['g.txt']);
      await postil.prune();
      assert.ok((await postil.repo.pinnedTrees()).includes(reviewed), 'the reviewed tree outlives pruning');

      a.git('switch', '-q', '-c', 'other');
      assert.equal(await postil.lastSession(), null, 'history is per branch');
      postil.close();

      // Another clone of the same repository, cloned over HTTPS, on another computer.
      b.write('f.txt', '1\n');
      b.commit('base');
      b.git('remote', 'add', 'origin', 'https://github.com/Owner/Repo');
      const other = await Postil.open(b.dir, undefined, history);
      assert.equal((await other.lastSession())?.available, false, 'the reviewed content is not here yet');
      await assert.rejects(other.resolveScope({ kind: 'last_session' }), (e) => e instanceof HttpError && e.code === 'history_unavailable');
      b.write('f.txt', '2\n');
      b.commit('the same content, as if fetched');
      assert.equal((await other.resolveScope({ kind: 'last_session' })).from.tree, reviewed);
      other.close();
    } finally {
      a.cleanup();
      b.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
