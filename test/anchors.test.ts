import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { lineMapper, reanchor } from '../src/core/anchors.ts';
import { Repo } from '../src/git/repo.ts';
import { makeFixture, numbered, type Fixture } from './helpers.ts';

/** Zero-context hunks between two versions of a file, from real git. */
describe('re-anchoring through real git diffs', () => {
  let fx: Fixture;
  let repo: Repo;
  const blob = (content: string) => {
    fx.write('f.txt', content);
    return fx.git('hash-object', '-w', 'f.txt').trim();
  };
  const hunks = async (a: string, b: string) => (await repo.diffBlobs(a, b, { context: 0 })).hunks;

  before(async () => {
    fx = makeFixture();
    fx.write('seed', 'x\n');
    fx.commit('base');
    repo = await Repo.open(fx.dir);
  });
  after(() => fx.cleanup());

  it('shifts lines below an insertion and leaves lines above alone', async () => {
    const before = blob(numbered(10));
    const after = blob(numbered(10).replace('line 3\n', 'line 3\nnew a\nnew b\n'));
    const map = lineMapper(await hunks(before, after));
    assert.deepEqual([1, 3, 4, 10].map(map), [1, 3, 6, 12]);
  });

  it('reports changed and deleted lines as unmapped', async () => {
    const before = blob(numbered(10));
    const after = blob(numbered(10, { 5: 'five' }).replace('line 8\n', ''));
    const map = lineMapper(await hunks(before, after));
    assert.deepEqual([4, 5, 6, 8, 9].map(map), [4, null, 6, null, 8]);
  });

  it('calls a range "moved" when only other lines changed', async () => {
    const before = blob(numbered(20));
    const after = blob(`header\n${numbered(20)}`);
    assert.deepEqual(reanchor(await hunks(before, after), 10, 12, 21), { state: 'moved', start: 11, end: 13 });
  });

  it('calls a range "outdated" when its own lines changed, and covers what replaced them', async () => {
    const before = blob(numbered(20));
    const after = blob(numbered(20, { 11: 'eleven', 12: 'twelve\nand more' }));
    assert.deepEqual(reanchor(await hunks(before, after), 10, 12, 21), { state: 'outdated', start: 10, end: 13 });
  });

  it('treats lines inserted inside the range as a change to it', async () => {
    const before = blob(numbered(20));
    const after = blob(numbered(20).replace('line 11\n', 'line 11\ninserted\n'));
    const r = reanchor(await hunks(before, after), 10, 12, 21);
    assert.equal(r.state, 'outdated');
  });

  it('points at the gap when the anchored lines were deleted outright', async () => {
    const before = blob(numbered(20));
    const after = blob(numbered(20).replace('line 10\nline 11\nline 12\n', ''));
    assert.deepEqual(reanchor(await hunks(before, after), 10, 12, 17), { state: 'outdated', start: 9, end: 9 });
  });

  it('reports "gone" when the file is now empty', async () => {
    const before = blob(numbered(5));
    const after = blob('');
    assert.deepEqual(reanchor(await hunks(before, after), 2, 3, 0), { state: 'gone' });
  });
});
