import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Channel, PostilEvent } from '../src/core/events.ts';
import { Postil } from '../src/core/postil.ts';
import { HttpError } from '../src/core/util.ts';
import { makeFixture, numbered, type Fixture } from './helpers.ts';

function recorder(postil: Postil) {
  const events: Array<{ event: PostilEvent; channels: readonly Channel[] }> = [];
  postil.bus.subscribe((event, channels) => events.push({ event, channels }));
  return {
    events,
    types: () => events.map((e) => e.event.type),
    agent: () => events.filter((e) => e.channels.includes('agent')).map((e) => e.event.type),
    clear: () => { events.length = 0; },
  };
}

async function rejectsWith(p: Promise<unknown> | (() => unknown), code: string): Promise<HttpError> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    assert.ok(e instanceof HttpError, `expected HttpError, got ${e}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected rejection with ${code}`);
}

describe('base selection', () => {
  it('uses HEAD at first start on the default branch', async () => {
    const fx = makeFixture();
    try {
      fx.write('a', '1\n');
      const head = fx.commit('c1');
      const postil = await Postil.open(fx.dir);
      fx.write('a', '2\n');
      fx.commit('c2'); // later commits count as changes under review
      const base = await postil.base();
      assert.deepEqual(base.config, { mode: 'commit', commit: head });
      assert.equal(base.commit, head);
      postil.close();
    } finally {
      fx.cleanup();
    }
  });

  it('follows the merge base on a feature branch, and can be pinned and reset', async () => {
    const fx = makeFixture();
    try {
      fx.write('a', '1\n');
      const root = fx.commit('root');
      fx.git('switch', '-q', '-c', 'feature');
      fx.write('a', '2\n');
      const c1 = fx.commit('feature');
      const postil = await Postil.open(fx.dir);
      let base = await postil.base();
      assert.equal(base.config.mode, 'merge-base');
      assert.equal(base.commit, root);

      base = await postil.setBase(c1);
      assert.deepEqual([base.config.mode, base.commit], ['commit', c1]);
      base = await postil.resetBase();
      assert.equal(base.commit, root);

      // An empty base puts every file in the tree under review.
      base = await postil.setBase(null);
      assert.deepEqual([base.commit, base.tree], [null, await postil.repo.emptyTree()]);
      const all = await postil.resolveScope({ kind: 'all' });
      assert.deepEqual((await postil.files(all.from.tree, all.to.tree)).map((f) => [f.path, f.status]), [['a', 'added']]);
      postil.close();
    } finally {
      fx.cleanup();
    }
  });

  it('measures a stacked branch from the branch it targets, following that branch as it moves', async () => {
    const fx = makeFixture();
    try {
      fx.write('a', '1\n');
      fx.commit('root');
      fx.git('switch', '-q', '-c', 'develop');
      fx.write('b', 'develop\n');
      const dev1 = fx.commit('develop work');
      fx.git('switch', '-q', '-c', 'feature');
      fx.write('c', 'feature\n');
      fx.commit('feature work');
      const postil = await Postil.open(fx.dir);

      let base = await postil.setBaseBranch('develop');
      assert.deepEqual(base.config, { mode: 'merge-base', target: 'develop' });
      assert.equal(base.commit, dev1);
      const all = await postil.resolveScope({ kind: 'all' });
      assert.deepEqual((await postil.files(all.from.tree, all.to.tree)).map((f) => f.path), ['c'], 'only the feature diff');

      // develop moves on and feature merges it in: the base follows, as a pull request's does.
      fx.git('switch', '-q', 'develop');
      fx.write('b', 'develop 2\n');
      const dev2 = fx.commit('more develop work');
      fx.git('switch', '-q', 'feature');
      fx.git('merge', '-q', '--no-edit', 'develop');
      base = await postil.base();
      assert.equal(base.commit, dev2);

      await assert.rejects(postil.setBaseBranch('nope'), /no branch named "nope"/);
      postil.close();
    } finally {
      fx.cleanup();
    }
  });

  it('falls back to the empty tree in a repository with no commits', async () => {
    const fx = makeFixture();
    try {
      fx.write('new.txt', 'hi\n');
      const postil = await Postil.open(fx.dir);
      const scope = await postil.resolveScope({ kind: 'all' });
      assert.equal(scope.from.tree, await postil.repo.emptyTree());
      assert.deepEqual((await postil.files(scope.from.tree, scope.to.tree)).map((f) => f.path), ['new.txt']);
      postil.close();
    } finally {
      fx.cleanup();
    }
  });
});

describe('scopes', () => {
  let fx: Fixture;
  let postil: Postil;
  let c1: string;
  let c2: string;
  before(async () => {
    fx = makeFixture();
    fx.write('a.txt', 'a0\n');
    c1 = fx.commit('first');
    postil = await Postil.open(fx.dir);
    fx.write('a.txt', 'a1\n');
    fx.write('b.txt', 'b\n');
    c2 = fx.commit('second');
    fx.write('c.txt', 'uncommitted\n');
  });
  after(() => { postil.close(); fx.cleanup(); });

  const paths = async (s: Awaited<ReturnType<Postil['resolveScope']>>) =>
    (await postil.files(s.from.tree, s.to.tree)).map((f) => f.path);

  it('all: base to working tree', async () => {
    const s = await postil.resolveScope({ kind: 'all' });
    assert.equal(s.to.live, true);
    assert.deepEqual(await paths(s), ['a.txt', 'b.txt', 'c.txt']);
  });

  it('uncommitted: HEAD to working tree', async () => {
    assert.deepEqual(await paths(await postil.resolveScope({ kind: 'uncommitted' })), ['c.txt']);
  });

  it('commits: an inclusive range, including the root commit and the working tree', async () => {
    assert.deepEqual(await paths(await postil.resolveScope({ kind: 'commits', from: c2, to: c2 })), ['a.txt', 'b.txt']);
    assert.deepEqual(await paths(await postil.resolveScope({ kind: 'commits', from: c1, to: c1 })), ['a.txt']);
    assert.deepEqual(await paths(await postil.resolveScope({ kind: 'commits', from: c2, to: 'worktree' })), ['a.txt', 'b.txt', 'c.txt']);
  });

  it('since_review: fails before any review, then diffs from the submit snapshot', async () => {
    await rejectsWith(postil.resolveScope({ kind: 'since_review' }), 'no_review');
    const all = await postil.resolveScope({ kind: 'all' });
    await postil.createThread({ from_tree: all.from.tree, to_tree: all.to.tree, path: 'c.txt', side: 'new', start_line: 1, body: 'why?' });
    await postil.submitReview();
    fx.write('d.txt', 'after review\n');
    assert.deepEqual(await paths(await postil.resolveScope({ kind: 'since_review' })), ['d.txt']);
  });

  it('lists commits since the base and notices uncommitted work', async () => {
    const info = await postil.commits();
    assert.deepEqual(info.commits.map((c) => c.subject), ['second']);
    assert.equal(info.uncommitted, true);
  });
});

describe('the review loop', () => {
  let fx: Fixture;
  let postil: Postil;
  let rec: ReturnType<typeof recorder>;
  before(async () => {
    fx = makeFixture();
    fx.write('src/retry.ts', numbered(40));
    fx.write('src/db.ts', numbered(10));
    fx.commit('base');
    postil = await Postil.open(fx.dir);
    rec = recorder(postil);
    // Claude's work, under review.
    fx.write('src/retry.ts', numbered(40, { 12: 'for (;;) retry();', 13: '// no backoff' }));
    fx.write('src/db.ts', numbered(10, { 5: 'const conn = open();' }));
  });
  after(() => { postil.close(); fx.cleanup(); });

  let retryThread: number;
  let dbThread: number;
  let reviewId: number;

  it('keeps comments as private drafts until submit', async () => {
    const scope = await postil.resolveScope({ kind: 'all' });
    const t1 = await postil.createThread({
      from_tree: scope.from.tree, to_tree: scope.to.tree, path: 'src/retry.ts', side: 'new', start_line: 12, end_line: 13,
      body: 'This retry loop has no backoff.',
    });
    const t2 = await postil.createThread({
      from_tree: scope.from.tree, to_tree: scope.to.tree, path: 'src/db.ts', side: 'new', start_line: 5,
      body: 'Is `conn` ever closed?',
    });
    retryThread = t1.id;
    dbThread = t2.id;
    assert.equal(t1.anchor_text, 'for (;;) retry();\n// no backoff');
    assert.deepEqual([t1.published, t1.awaiting, t1.comments[0]?.draft], [false, null, true]);
    assert.equal(postil.draft()?.comment_count, 2);
    assert.deepEqual(postil.pendingReviews(), []);
    assert.deepEqual(rec.agent(), [], 'drafts never reach Claude');
  });

  it('submits the draft as one review and rings only the doorbell on the agent channel', async () => {
    rec.clear();
    const review = await postil.submitReview('First pass.');
    reviewId = review.id;
    assert.equal(review.status, 'submitted');
    assert.ok(review.submit_tree);
    assert.ok((await postil.repo.pinnedTrees()).includes(review.submit_tree!), 'submit snapshot is pinned');
    assert.equal(postil.draft(), null);
    assert.deepEqual(rec.agent(), ['review.submitted']);
    const doorbell = rec.events.find((e) => e.event.type === 'review.submitted')!.event;
    assert.equal(doorbell.thread_count, 2);
    assert.equal(postil.thread(retryThread).awaiting, 'claude');
  });

  it('gives Claude the review, marks it in progress, and lists what needs a reply', async () => {
    const review = await postil.reviewForAgent(reviewId);
    assert.equal(review.status, 'in_progress');
    assert.equal(review.body, 'First pass.');
    assert.deepEqual(review.threads.map((t) => [t.id, t.awaiting_reply, t.anchor.state]), [
      [dbThread, true, 'current'],
      [retryThread, true, 'current'],
    ]);
    assert.ok(rec.types().includes('review.started'));
  });

  it('refuses to complete while threads are unanswered', async () => {
    const err = await rejectsWith(postil.completeReview(reviewId, 'done'), 'unanswered_threads');
    assert.deepEqual((err.details as { thread_ids: number[] }).thread_ids.sort(), [retryThread, dbThread].sort());
  });

  it('publishes Claude replies immediately and tracks file changes', async () => {
    fx.write('src/retry.ts', numbered(40, { 12: 'await backoff(attempt);' }));
    rec.clear();
    const t = await postil.agentReply(retryThread, 'Added exponential backoff with jitter.');
    assert.equal(t.awaiting, 'user');
    assert.ok(rec.types().includes('thread.replied'));
    assert.ok(rec.types().includes('worktree.changed'), 'the UI hears about Claude\'s edit');
    assert.deepEqual(rec.agent(), [], 'Claude is not woken by its own reply');

    const review = await postil.reviewForAgent(reviewId);
    const retry = review.threads.find((x) => x.id === retryThread)!;
    assert.deepEqual([retry.awaiting_reply, retry.anchor.state], [false, 'outdated']);
    assert.equal(retry.anchor.current_text, 'await backoff(attempt);\nline 13');
    await rejectsWith(postil.completeReview(reviewId, 'done'), 'unanswered_threads');
  });

  it('completes once every thread has a reply, with a pinned completion snapshot', async () => {
    await postil.agentReply(dbThread, 'It is closed in `shutdown()`; should it close sooner?', true);
    assert.equal(postil.thread(dbThread).needs_decision, true);
    const done = await postil.completeReview(reviewId, 'Backoff added; asked about conn lifetime.');
    assert.equal(done.status, 'addressed');
    assert.ok((await postil.repo.pinnedTrees()).includes(done.complete_tree!));
    await rejectsWith(postil.completeReview(reviewId, 'again'), 'already_complete');
  });

  it('runs a second round on the same thread and demands a fresh reply', async () => {
    postil.replyAsUser(dbThread, 'Close it right after the query.');
    postil.resolveThread(retryThread);
    const second = await postil.submitReview();
    const thread = postil.thread(dbThread);
    assert.equal(thread.needs_decision, false, 'the user\'s reply is the decision');
    assert.equal(thread.awaiting, 'claude');

    const review = await postil.reviewForAgent(second.id);
    assert.deepEqual(review.threads.map((t) => t.id), [dbThread], 'only threads touched in this review');
    assert.deepEqual(review.threads[0]!.comments.map((c) => [c.author, c.in_this_review]), [
      ['user', false], ['claude', false], ['user', true],
    ]);
    // Claude's round-one reply does not count for round two.
    await rejectsWith(postil.completeReview(second.id, 'x'), 'unanswered_threads');
    await postil.agentReply(dbThread, 'Now closed in a finally block.');
    assert.equal((await postil.completeReview(second.id, 'Closed the connection.')).status, 'addressed');
  });

  it('reopens a resolved thread when the user replies to it', async () => {
    assert.equal(postil.thread(retryThread).status, 'resolved');
    await rejectsWith(postil.agentReply(retryThread, 'x'), 'thread_resolved');
    postil.replyAsUser(retryThread, 'Actually, cap the attempts too.');
    await postil.submitReview();
    assert.deepEqual([postil.thread(retryThread).status, postil.thread(retryThread).awaiting], ['open', 'claude']);
  });

  it('keeps anchored diffs alive through gc after the working tree moves on', async () => {
    const t = postil.thread(retryThread);
    fx.write('src/retry.ts', 'rewritten entirely\n');
    await postil.liveTree();
    fx.git('gc', '--prune=now', '-q');
    assert.equal(await postil.repo.objectType(t.to_tree), 'tree');
    assert.equal(await postil.repo.objectType(t.blob), 'blob');
  });
});

describe('drafts, anchors and validation', () => {
  let fx: Fixture;
  let postil: Postil;
  let from: string;
  let to: string;
  beforeEach(async () => {
    fx = makeFixture();
    fx.write('keep.txt', numbered(5));
    fx.write('gone.txt', 'old\n');
    fx.commit('base');
    postil = await Postil.open(fx.dir);
    fx.write('keep.txt', numbered(5, { 3: 'three' }));
    fx.remove('gone.txt');
    fx.write('added.txt', 'new\n');
    const s = await postil.resolveScope({ kind: 'all' });
    from = s.from.tree;
    to = s.to.tree;
  });
  const cleanup = () => { postil.close(); fx.cleanup(); };

  it('rejects anchors outside the file or on a side where the file does not exist', async () => {
    try {
      await rejectsWith(postil.createThread({ from_tree: from, to_tree: to, path: 'keep.txt', side: 'new', start_line: 4, end_line: 9, body: 'x' }), 'invalid_range');
      await rejectsWith(postil.createThread({ from_tree: from, to_tree: to, path: 'added.txt', side: 'old', start_line: 1, body: 'x' }), 'no_such_file');
      await rejectsWith(postil.createThread({ from_tree: from, to_tree: to, path: 'gone.txt', side: 'new', start_line: 1, body: 'x' }), 'no_such_file');
      await rejectsWith(postil.createThread({ from_tree: from, to_tree: to, path: 'keep.txt', side: 'new', start_line: 1, body: '   ' }), 'empty_body');
      const onDeleted = await postil.createThread({ from_tree: from, to_tree: to, path: 'gone.txt', side: 'old', start_line: 1, body: 'why delete?' });
      assert.equal(onDeleted.anchor_text, 'old');
      const fileLevel = await postil.createThread({ from_tree: from, to_tree: to, path: 'keep.txt', side: 'new', body: 'whole file' });
      assert.deepEqual([fileLevel.start_line, fileLevel.anchor_text], [null, '']);
    } finally {
      cleanup();
    }
  });

  it('edits and deletes drafts, removing a thread with its last comment, and freezes published ones', async () => {
    try {
      const t = await postil.createThread({ from_tree: from, to_tree: to, path: 'keep.txt', side: 'new', start_line: 3, body: 'typo' });
      const commentId = t.comments[0]!.id;
      assert.equal(postil.editDraft(commentId, 'typo: three').comments[0]?.body, 'typo: three');
      assert.deepEqual(postil.deleteDraft(commentId), { thread_deleted: true });
      await rejectsWith(() => postil.thread(t.id), 'unknown_thread');

      const t2 = await postil.createThread({ from_tree: from, to_tree: to, path: 'keep.txt', side: 'new', start_line: 3, body: 'x' });
      await rejectsWith(() => postil.resolveThread(t2.id), 'unpublished_thread');
      await postil.submitReview();
      await rejectsWith(() => postil.editDraft(t2.comments[0]!.id, 'y'), 'not_a_draft');
      await rejectsWith(postil.agentReply(t2.id + 999, 'x'), 'unknown_thread');
    } finally {
      cleanup();
    }
  });

  it('refuses an empty submit but accepts a review with only a body', async () => {
    try {
      await rejectsWith(postil.submitReview(), 'empty_review');
      await rejectsWith(postil.submitReview('   '), 'empty_review');
      const r = await postil.submitReview('Overall looks fine; see the tests.');
      assert.deepEqual([r.status, r.comment_count], ['submitted', 0]);
      assert.deepEqual(postil.unansweredThreads(r.id), []);
    } finally {
      cleanup();
    }
  });

  it('treats a reply as Claude picking the review up', async () => {
    try {
      const t = await postil.createThread({ from_tree: from, to_tree: to, path: 'keep.txt', side: 'new', start_line: 3, body: 'x' });
      const r = await postil.submitReview();
      await postil.agentReply(t.id, 'on it');
      assert.equal(postil.review(r.id).status, 'in_progress');
    } finally {
      cleanup();
    }
  });

  it('will not let Claude reply to a thread the user has not submitted', async () => {
    try {
      const t = await postil.createThread({ from_tree: from, to_tree: to, path: 'keep.txt', side: 'new', start_line: 3, body: 'draft only' });
      await rejectsWith(postil.agentReply(t.id, 'sneaky'), 'unpublished_thread');
    } finally {
      cleanup();
    }
  });
});

describe('diff content, marks and ui state', () => {
  let fx: Fixture;
  let postil: Postil;
  before(async () => {
    fx = makeFixture();
    fx.write('big.txt', numbered(10));
    fx.write('f.txt', numbered(8));
    fx.commit('base');
    postil = await Postil.open(fx.dir);
    fx.write('f.txt', numbered(8, { 4: 'four' }));
    fx.write('big.txt', 'x'.repeat(5 * 1024 * 1024));
  });
  after(() => { postil.close(); fx.cleanup(); });

  it('returns hunks with total line counts, and declines oversized blobs unless forced', async () => {
    const s = await postil.resolveScope({ kind: 'all' });
    const files = await postil.files(s.from.tree, s.to.tree);
    const f = files.find((x) => x.path === 'f.txt')!;
    const diff = await postil.fileDiff(f.old_blob, f.new_blob, { context: 1 });
    assert.deepEqual([diff.old_lines, diff.new_lines, diff.hunks.length, diff.too_large], [8, 8, 1, false]);

    const big = files.find((x) => x.path === 'big.txt')!;
    assert.equal((await postil.fileDiff(big.old_blob, big.new_blob)).too_large, true);
    assert.equal((await postil.fileDiff(big.old_blob, big.new_blob, { force: true })).too_large, false);
  });

  it('serves line ranges for expanding context, clamped to the file', async () => {
    const s = await postil.resolveScope({ kind: 'all' });
    const f = (await postil.files(s.from.tree, s.to.tree)).find((x) => x.path === 'f.txt')!;
    const r = await postil.lines(f.new_blob!, 3, 5);
    assert.deepEqual(r.lines, ['line 3', 'four', 'line 5']);
    assert.deepEqual((await postil.lines(f.new_blob!, 7, 100)).lines, ['line 7', 'line 8']);
    assert.deepEqual((await postil.lines(f.new_blob!, 50, 60)).lines, []);
    await rejectsWith(postil.lines(f.new_blob!, 0, 2), 'invalid_range');
  });

  it('stores viewed files and done sections, deduplicated', async () => {
    const s = await postil.resolveScope({ kind: 'all' });
    const f = (await postil.files(s.from.tree, s.to.tree)).find((x) => x.path === 'f.txt')!;
    postil.setFileMark('f.txt', f.new_blob!, true);
    postil.setFileMark('f.txt', f.new_blob!, true);
    assert.equal(postil.fileMarks().length, 1);
    postil.setFileMark('f.txt', f.new_blob!, false);
    assert.equal(postil.fileMarks().length, 0);

    const input = { path: 'f.txt', from_blob: f.old_blob, to_blob: f.new_blob, side: 'new' as const, start_line: 3, end_line: 5 };
    const m1 = await postil.addSectionMark(input);
    const m2 = await postil.addSectionMark(input);
    assert.equal(m1.id, m2.id);
    assert.match(m1.content_hash, /^[0-9a-f]{64}$/);
    await rejectsWith(postil.addSectionMark({ ...input, end_line: 99 }), 'invalid_range');
    postil.removeSectionMark(m1.id);
    await rejectsWith(() => postil.removeSectionMark(m1.id), 'unknown_mark');
  });

  it('round-trips ui state with key and size limits', () => {
    postil.setUiState('view.mode', { split: true, expanded: { 'a.ts': [[10, 20]] } });
    assert.deepEqual(postil.uiState('view.mode'), { split: true, expanded: { 'a.ts': [[10, 20]] } });
    assert.equal(postil.uiState('missing'), null);
    assert.throws(() => postil.setUiState('bad key!', 1), /ui state keys/);
    assert.throws(() => postil.setUiState('huge', 'x'.repeat(300 * 1024)), /limited/);
    assert.deepEqual(postil.uiStateKeys(), ['view.mode']);
  });
});

describe('agent sessions', () => {
  let fx: Fixture;
  let postil: Postil;
  let from: string;
  let to: string;
  const A = 'aaaaaaaa-1111-2222-3333-444444444444';
  const B = 'bbbbbbbb-1111-2222-3333-444444444444';

  beforeEach(async () => {
    fx = makeFixture();
    fx.write('f.txt', numbered(5));
    fx.commit('base');
    postil = await Postil.open(fx.dir);
    fx.write('f.txt', numbered(5, { 2: 'two' }));
    const s = await postil.resolveScope({ kind: 'all' });
    from = s.from.tree;
    to = s.to.tree;
  });
  const cleanup = () => { postil.close(); fx.cleanup(); };
  const submitOne = async () => {
    const t = await postil.createThread({ from_tree: from, to_tree: to, path: 'f.txt', side: 'new', start_line: 2, body: 'why?' });
    return { thread: t.id, review: (await postil.submitReview()).id };
  };

  it('stays silent for sessions that never asked to listen', async () => {
    try {
      await submitOne();
      assert.deepEqual(postil.hookStatus(A), { listener: false, in_progress: [], waiting: [] });
    } finally {
      cleanup();
    }
  });

  it('tells a listening session what is waiting, then what it still owes', async () => {
    try {
      assert.deepEqual(postil.listen(A), { pending: [] });
      const { thread, review } = await submitOne();
      assert.deepEqual(postil.hookStatus(A).waiting, [review]);

      await postil.reviewForAgent(review, A);
      let status = postil.hookStatus(A);
      assert.deepEqual(status.waiting, []);
      assert.deepEqual(status.in_progress, [{ review_id: review, unanswered: [{ thread_id: thread, path: 'f.txt', start_line: 2, end_line: 2 }] }]);

      await postil.agentReply(thread, 'because', false, A);
      status = postil.hookStatus(A);
      assert.deepEqual(status.in_progress, [{ review_id: review, unanswered: [] }], 'still owes complete_review');
      await postil.completeReview(review, 'done');
      assert.deepEqual(postil.hookStatus(A), { listener: true, in_progress: [], waiting: [] });
    } finally {
      cleanup();
    }
  });

  it('keeps a review with the live session that claimed it', async () => {
    try {
      const { review } = await submitOne();
      postil.agentConnected(A);
      await postil.reviewForAgent(review, A);
      await rejectsWith(postil.reviewForAgent(review, B), 'claimed_elsewhere');
      postil.listen(B);
      assert.deepEqual(postil.hookStatus(B).waiting, [], "another live session's review is not waiting");
    } finally {
      cleanup();
    }
  });

  it('lets another session take over once the claimer stops listening', async () => {
    try {
      const { review } = await submitOne();
      postil.agentConnected(A);
      await postil.reviewForAgent(review, A);
      postil.agentDisconnected(A);
      postil.listen(B);
      assert.deepEqual(postil.hookStatus(B).waiting, [review], 'orphaned review is waiting again');
      await postil.reviewForAgent(review, B);
      assert.equal(postil.store.getReview(review)?.agent_session, B);
    } finally {
      cleanup();
    }
  });

  it('rejects malformed session ids', async () => {
    try {
      await rejectsWith(() => postil.listen('../../etc'), 'invalid_session');
    } finally {
      cleanup();
    }
  });
});

describe('anchoring threads to a later diff', () => {
  it('reports current, moved, outdated, renamed and gone threads', async () => {
    const fx = makeFixture();
    try {
      fx.write('stable.txt', numbered(20));
      fx.write('shift.txt', numbered(20));
      fx.write('edit.txt', numbered(20));
      fx.write('rename-me.txt', numbered(20));
      fx.write('delete-me.txt', numbered(20));
      fx.commit('base');
      const postil = await Postil.open(fx.dir);
      for (const f of ['stable', 'shift', 'edit', 'rename-me', 'delete-me']) {
        fx.write(`${f}.txt`, numbered(20, { 1: `${f} changed` }));
      }
      const s1 = await postil.resolveScope({ kind: 'all' });
      const ids: Record<string, number> = {};
      for (const f of ['stable', 'shift', 'edit', 'rename-me', 'delete-me']) {
        ids[f] = (await postil.createThread({ from_tree: s1.from.tree, to_tree: s1.to.tree, path: `${f}.txt`, side: 'new', start_line: 10, end_line: 11, body: f })).id;
      }

      // Claude's next round of edits.
      fx.write('shift.txt', `inserted\n${numbered(20, { 1: 'shift changed' })}`);
      fx.write('edit.txt', numbered(20, { 1: 'edit changed', 11: 'eleven' }));
      fx.git('mv', 'rename-me.txt', 'renamed.txt');
      fx.remove('delete-me.txt');

      const s2 = await postil.resolveScope({ kind: 'all' });
      const threads = await postil.threadsIn({ from_tree: s2.from.tree, to_tree: s2.to.tree });
      const anchor = (f: string) => threads.find((t) => t.id === ids[f])!.anchor!;

      assert.deepEqual(anchor('stable'), { state: 'current', path: 'stable.txt', start_line: 10, end_line: 11 });
      assert.deepEqual(anchor('shift'), { state: 'moved', path: 'shift.txt', start_line: 11, end_line: 12 });
      assert.deepEqual(anchor('edit'), { state: 'outdated', path: 'edit.txt', start_line: 10, end_line: 11, current_text: 'line 10\neleven' });
      assert.deepEqual(anchor('rename-me'), { state: 'current', path: 'renamed.txt', start_line: 10, end_line: 11 });
      assert.deepEqual(anchor('delete-me'), { state: 'gone', path: 'delete-me.txt', start_line: null, end_line: null });
      postil.close();
    } finally {
      fx.cleanup();
    }
  });
});

describe('applying suggestions', () => {
  let fx: Fixture;
  let postil: Postil;
  const suggest = async (path: string, start: number, end: number, replacement: string) => {
    const s = await postil.resolveScope({ kind: 'all' });
    const t = await postil.createThread({
      from_tree: s.from.tree, to_tree: s.to.tree, path, side: 'new', start_line: start, end_line: end,
      body: `How about:\n\`\`\`suggestion\n${replacement}\n\`\`\``,
    });
    return t.comments[0]!.id;
  };
  beforeEach(async () => {
    fx = makeFixture();
    fx.write('a.ts', numbered(10));
    fx.write('crlf.txt', 'one\r\ntwo\r\nthree\r\n');
    fx.commit('base');
    postil = await Postil.open(fx.dir);
    fx.write('a.ts', numbered(10, { 5: 'five' }));
    fx.write('crlf.txt', 'one\r\nTWO\r\nthree\r\n');
  });
  const cleanup = () => { postil.close(); fx.cleanup(); };
  const read = (p: string) => readFileSync(join(fx.dir, p), 'utf8');

  it('replaces the anchored lines and records that it was applied', async () => {
    try {
      const id = await suggest('a.ts', 5, 6, 'FIVE\nSIX\nSIX AND A HALF');
      const r = await postil.applySuggestion(id);
      assert.deepEqual([r.path, r.start_line, r.end_line], ['a.ts', 5, 7]);
      assert.equal(read('a.ts'), numbered(10, { 5: 'FIVE', 6: 'SIX\nSIX AND A HALF' }));
      assert.ok(postil.store.getComment(id)?.applied_at);
      await rejectsWith(postil.applySuggestion(id), 'already_applied');
    } finally {
      cleanup();
    }
  });

  it('follows lines that moved, but refuses when they changed', async () => {
    try {
      const moved = await suggest('a.ts', 8, 8, 'EIGHT');
      const changed = await suggest('a.ts', 5, 5, 'FIVE');
      fx.write('a.ts', `// header\n${numbered(10, { 5: 'five, edited by Claude' })}`);
      await rejectsWith(postil.applySuggestion(changed), 'suggestion_outdated');
      await postil.applySuggestion(moved);
      assert.match(read('a.ts'), /^line 7\nEIGHT\nline 9$/m);
    } finally {
      cleanup();
    }
  });

  it('keeps CRLF line endings and supports deleting lines', async () => {
    try {
      const id = await suggest('crlf.txt', 2, 2, '');
      // An empty suggestion block deletes the lines.
      postil.store.db.prepare('UPDATE comment SET body = :b WHERE id = :id').run({ b: '```suggestion\n```', id });
      await postil.applySuggestion(id);
      assert.equal(read('crlf.txt'), 'one\r\nthree\r\n');
    } finally {
      cleanup();
    }
  });

  it('rejects comments without exactly one suggestion', async () => {
    try {
      const s = await postil.resolveScope({ kind: 'all' });
      const plain = await postil.createThread({ from_tree: s.from.tree, to_tree: s.to.tree, path: 'a.ts', side: 'new', start_line: 1, body: 'just a remark' });
      await rejectsWith(postil.applySuggestion(plain.comments[0]!.id), 'no_suggestion');
      const two = await postil.createThread({
        from_tree: s.from.tree, to_tree: s.to.tree, path: 'a.ts', side: 'new', start_line: 2,
        body: '```suggestion\nx\n```\nor\n```suggestion\ny\n```',
      });
      await rejectsWith(postil.applySuggestion(two.comments[0]!.id), 'ambiguous_suggestion');
    } finally {
      cleanup();
    }
  });

  it('lists files changed since the last review for "updated" badges', async () => {
    try {
      assert.equal(await postil.sinceReview((await postil.resolveScope({ kind: 'all' })).to.tree), null);
      await suggest('a.ts', 1, 1, 'x');
      await postil.submitReview();
      fx.write('crlf.txt', 'changed after review\n');
      const since = await postil.sinceReview((await postil.resolveScope({ kind: 'all' })).to.tree);
      assert.deepEqual(since?.changed, ['crlf.txt']);
    } finally {
      cleanup();
    }
  });
});

describe('section marks across edits', () => {
  it('keep holding when other parts of the file change, and lapse when their own lines do', async () => {
    const fx = makeFixture();
    try {
      fx.write('big.txt', numbered(60));
      fx.commit('base');
      const postil = await Postil.open(fx.dir);
      fx.write('big.txt', numbered(60, { 10: 'ten', 40: 'forty' }));
      const s1 = await postil.resolveScope({ kind: 'all' });
      const f = (await postil.files(s1.from.tree, s1.to.tree))[0]!;
      const early = await postil.addSectionMark({ path: 'big.txt', from_blob: f.old_blob, to_blob: f.new_blob, side: 'new', start_line: 7, end_line: 13 });
      const late = await postil.addSectionMark({ path: 'big.txt', from_blob: f.old_blob, to_blob: f.new_blob, side: 'new', start_line: 37, end_line: 43 });

      // Claude inserts a header and rewrites the second section.
      fx.write('big.txt', `// header\n${numbered(60, { 10: 'ten', 40: 'FORTY, rewritten' })}`);
      const s2 = await postil.resolveScope({ kind: 'all' });
      const marks = await postil.sectionMarksIn({ from_tree: s2.from.tree, to_tree: s2.to.tree });
      const state = (id: number) => marks.find((m) => m.id === id)!.anchor;
      assert.deepEqual([state(early.id).state, state(early.id).start_line], ['moved', 8]);
      assert.equal(state(late.id).state, 'outdated');
      postil.close();
    } finally {
      fx.cleanup();
    }
  });
});

describe('archiving and pruning', () => {
  it('archives resolved threads and finished reviews, and releases only what nothing live needs', async () => {
    const fx = makeFixture();
    try {
      fx.write('f.txt', numbered(10));
      fx.commit('base');
      const postil = await Postil.open(fx.dir);
      fx.write('f.txt', numbered(10, { 2: 'two' }));
      let s = await postil.resolveScope({ kind: 'all' });
      const done = await postil.createThread({ from_tree: s.from.tree, to_tree: s.to.tree, path: 'f.txt', side: 'new', start_line: 2, body: 'a' });
      const r1 = await postil.submitReview();
      fx.write('f.txt', numbered(10, { 2: 'TWO' })); // Claude's fix: the completion snapshot is a new tree
      await postil.agentReply(done.id, 'fixed');
      const completed = await postil.completeReview(r1.id, 'ok');
      postil.resolveThread(done.id);

      fx.write('f.txt', numbered(10, { 2: 'TWO', 8: 'eight' }));
      s = await postil.resolveScope({ kind: 'all' });
      const open = await postil.createThread({ from_tree: s.from.tree, to_tree: s.to.tree, path: 'f.txt', side: 'new', start_line: 8, body: 'b' });
      const f = (await postil.files(s.from.tree, s.to.tree))[0]!;
      await postil.addSectionMark({ path: 'f.txt', from_blob: f.old_blob, to_blob: f.new_blob, side: 'new', start_line: 1, end_line: 3 });
      const before = await postil.repo.pinnedTrees();

      const r = await postil.archiveResolved();
      assert.deepEqual([r.threads, r.reviews], [1, 1]);
      assert.deepEqual(postil.threads().map((t) => t.id), [open.id], 'archived threads leave the normal view');
      assert.deepEqual(postil.archivedThreads().map((t) => t.id), [done.id]);
      assert.equal(postil.reviews().some((x) => x.id === r1.id), false);

      const after = await postil.repo.pinnedTrees();
      assert.equal(after.includes(completed.complete_tree!), false, 'the archived review\'s completion snapshot is released');
      assert.ok(after.length < before.length);
      for (const needed of [open.from_tree, open.to_tree, r1.submit_tree!]) assert.ok(after.includes(needed), 'live and latest-review trees stay pinned');
      assert.deepEqual(await postil.repo.pinnedBlobs(), [f.new_blob], 'the section mark keeps its blob');

      fx.git('gc', '--prune=now', '-q');
      const s2 = await postil.resolveScope({ kind: 'all' });
      assert.equal((await postil.threadsIn({ from_tree: s2.from.tree, to_tree: s2.to.tree }))[0]?.anchor?.state, 'current');
      postil.close();
    } finally {
      fx.cleanup();
    }
  });
});

describe('hardening', () => {
  let fx: Fixture;
  let postil: Postil;
  beforeEach(async () => {
    fx = makeFixture();
    fx.write('f.txt', numbered(10));
    fx.write('src/naïve café/π.ts', numbered(5));
    fx.write('latin1.txt', Buffer.from('caf\xe9\nline two\n', 'latin1'));
    fx.commit('base');
    postil = await Postil.open(fx.dir);
  });
  const cleanup = () => { postil.close(); fx.cleanup(); };

  it('waits for a file being written to settle before snapshotting', async () => {
    try {
      fx.write('f.txt', 'half written');
      const pending = postil.snapshot('test');
      setTimeout(() => fx.write('f.txt', numbered(10, { 3: 'finished' })), 60);
      const tree = await pending;
      const entry = await postil.repo.entryAt(tree, 'f.txt');
      assert.match((await postil.repo.readBlob(entry!.oid)).toString(), /finished/);
    } finally {
      cleanup();
    }
  });

  it('anchors a comment to the view the user saw, even if Claude has since changed the file', async () => {
    try {
      fx.write('f.txt', numbered(10, { 4: 'four' }));
      const seen = await postil.resolveScope({ kind: 'all' });
      fx.write('f.txt', `// Claude was quicker\n${numbered(10, { 4: 'four' })}`); // lands before the comment is saved
      const t = await postil.createThread({ from_tree: seen.from.tree, to_tree: seen.to.tree, path: 'f.txt', side: 'new', start_line: 4, body: 'hm' });
      assert.equal(t.anchor_text, 'four');
      const now = await postil.resolveScope({ kind: 'all' });
      const [anchored] = await postil.threadsIn({ from_tree: now.from.tree, to_tree: now.to.tree });
      assert.deepEqual([anchored?.anchor?.state, anchored?.anchor?.start_line], ['moved', 5]);
    } finally {
      cleanup();
    }
  });

  it('skips reading blobs when both sides are the same content', async () => {
    try {
      const phantom = 'a'.repeat(40); // does not exist: reading it would fail
      const d = await postil.fileDiff(phantom, phantom);
      assert.deepEqual([d.too_large, d.hunks.length], [false, 0]);
    } finally {
      cleanup();
    }
  });

  it('withholds diffs with extremely long lines unless forced', async () => {
    try {
      fx.write('f.txt', `${'x'.repeat(30_000)}\n`);
      const s = await postil.resolveScope({ kind: 'all' });
      const f = (await postil.files(s.from.tree, s.to.tree)).find((x) => x.path === 'f.txt')!;
      const d = await postil.fileDiff(f.old_blob, f.new_blob);
      assert.deepEqual([d.too_large, d.too_large_reason], [true, 'long_lines']);
      assert.ok((await postil.fileDiff(f.old_blob, f.new_blob, { force: true })).hunks.length > 0);
    } finally {
      cleanup();
    }
  });

  it('refuses to apply a suggestion to a file that is not UTF-8, leaving it untouched', async () => {
    try {
      fx.write('latin1.txt', Buffer.from('caf\xe9\nline 2\n', 'latin1'));
      const s = await postil.resolveScope({ kind: 'all' });
      const t = await postil.createThread({
        from_tree: s.from.tree, to_tree: s.to.tree, path: 'latin1.txt', side: 'new', start_line: 2,
        body: '```suggestion\nline two\n```',
      });
      await rejectsWith(postil.applySuggestion(t.comments[0]!.id), 'not_utf8');
      assert.deepEqual(readFileSync(join(fx.dir, 'latin1.txt')), Buffer.from('caf\xe9\nline 2\n', 'latin1'));
    } finally {
      cleanup();
    }
  });

  it('handles paths with spaces and non-ASCII characters end to end', async () => {
    try {
      const path = 'src/naïve café/π.ts';
      fx.write(path, numbered(5, { 2: 'deux' }));
      const s = await postil.resolveScope({ kind: 'all' });
      const f = (await postil.files(s.from.tree, s.to.tree)).find((x) => x.path === path);
      assert.ok(f, 'listed with its real name');
      const t = await postil.createThread({ from_tree: s.from.tree, to_tree: s.to.tree, path, side: 'new', start_line: 2, body: '```suggestion\ntwo\n```' });
      await postil.applySuggestion(t.comments[0]!.id);
      assert.match(readFileSync(join(fx.dir, path), 'utf8'), /^line 1\ntwo\nline 3/);
    } finally {
      cleanup();
    }
  });
});

describe('review fixes', () => {
  it('does not archive a resolved thread holding an unsent reply, and un-archives a reopened one', async () => {
    const fx = makeFixture();
    try {
      fx.write('f.txt', numbered(5));
      fx.commit('base');
      const postil = await Postil.open(fx.dir);
      fx.write('f.txt', numbered(5, { 2: 'two' }));
      const s = await postil.resolveScope({ kind: 'all' });
      const t = await postil.createThread({ from_tree: s.from.tree, to_tree: s.to.tree, path: 'f.txt', side: 'new', start_line: 2, body: 'a' });
      const other = await postil.createThread({ from_tree: s.from.tree, to_tree: s.to.tree, path: 'f.txt', side: 'new', start_line: 3, body: 'b' });
      await postil.submitReview();
      postil.resolveThread(t.id);
      postil.resolveThread(other.id);
      postil.replyAsUser(t.id, 'one more thing'); // unsent

      const r = await postil.archiveResolved();
      assert.equal(r.threads, 1, 'only the thread with nothing pending is archived');
      assert.deepEqual(postil.archivedThreads().map((x) => x.id), [other.id]);

      await postil.submitReview();
      assert.equal(postil.thread(t.id).status, 'open');
      assert.ok(postil.threads().some((x) => x.id === t.id), 'the reopened thread is visible');

      // Reopening an archived thread by hand brings it back too, with its snapshots pinned again.
      await postil.unresolveThread(other.id);
      assert.ok(postil.threads().some((x) => x.id === other.id));
      assert.equal(postil.archivedThreads().length, 0);
      const pinned = await postil.repo.pinnedTrees();
      assert.ok(pinned.includes(other.from_tree) && pinned.includes(other.to_tree));
      postil.close();
    } finally {
      fx.cleanup();
    }
  });

  it('pins a chosen base commit, and degrades with a warning if it disappears anyway', async () => {
    const fx = makeFixture();
    try {
      fx.write('a', '1\n');
      fx.commit('root');
      fx.git('switch', '-q', '-c', 'topic');
      fx.write('a', '2\n');
      const topic = fx.commit('topic work');
      fx.git('switch', '-q', 'main');
      const postil = await Postil.open(fx.dir);
      await postil.setBase('topic');
      fx.git('branch', '-q', '-D', 'topic');
      fx.git('reflog', 'expire', '--expire=now', '--all');
      fx.git('gc', '--prune=now', '-q');
      assert.equal((await postil.base()).commit, topic, 'the pin kept it alive through gc');

      // A base stored by an older postil, unpinned and then lost:
      postil.store.setSetting('base', JSON.stringify({ mode: 'commit', commit: 'f'.repeat(40) }));
      const base = await postil.base();
      assert.equal(base.commit, null);
      assert.match(base.warning ?? '', /no longer exists/);
      await postil.resolveScope({ kind: 'all' }); // views keep working
      postil.close();
    } finally {
      fx.cleanup();
    }
  });
});
