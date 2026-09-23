import { strict as assert } from 'node:assert';
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
    assert.deepEqual(review.threads.map((t) => [t.id, t.awaiting_reply, t.file_changed_since_comment]), [
      [dbThread, true, false],
      [retryThread, true, false],
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
    assert.deepEqual([retry.awaiting_reply, retry.file_changed_since_comment], [false, true]);
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
