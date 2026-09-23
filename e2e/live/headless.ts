/**
 * Live test 1: a headless Claude session with the plugin handles a review that is already
 * waiting. Proves the skill, the MCP tools, and the review round trip with a real model.
 *
 *   node e2e/live/headless.ts
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeDemoRepo } from '../fixture.ts';
import { api, pathWithPostil, postil, reviewAddressed, startHeadless, submitReview, toolCalls, waitFor } from './lib.ts';
import type { ThreadView } from '../../src/core/api-types.ts';

const fx = makeDemoRepo();
const path = pathWithPostil();
try {
  postil(fx.dir, path, 'start', '--port', '0');
  const reviewId = await submitReview(fx.dir, 'Two things before I merge this.', [
    { path: 'src/db.ts', line: 'params: unknown[] = []', text: 'Rename `params` to `bindings` in this function.' },
    { path: 'src/retry.ts', line: 'Math.random()', text: 'Why add random jitter to the delay? One sentence is enough.' },
  ]);
  console.log(`submitted review #${reviewId}; starting Claude`);

  const started = Date.now();
  const session = startHeadless(fx.dir, path, '/postil:review');
  await reviewAddressed(fx.dir, reviewId, 8 * 60_000);
  console.log(`review addressed after ${Math.round((Date.now() - started) / 1000)}s`);
  // Handling done, Claude should go back to listening rather than exit.
  await waitFor('the session to arm its monitor', 60_000, async () =>
    (await api<{ listening: number }>(fx.dir, 'GET', '/api/health')).listening > 0 ? true : null,
  );
  const code = await session.stop();
  console.log(`session still listening afterwards, stopped it (exit ${code})`);
  const calls = toolCalls(session.events);
  console.log('tool calls:', calls.map((c) => c.name.replace('mcp__plugin_postil_postil__', 'postil.')).join(' → '));

  const review = await api<{ status: string; summary: string | null }>(fx.dir, 'GET', `/api/reviews/${reviewId}`);
  const { threads } = await api<{ threads: ThreadView[] }>(fx.dir, 'GET', '/api/threads');
  const db = readFileSync(join(fx.dir, 'src/db.ts'), 'utf8');
  for (const t of threads) console.log(`\nthread ${t.id} ${t.path}:\n${t.comments.map((c) => `  [${c.author}] ${c.body}`).join('\n')}`);
  console.log(`\nreview #${reviewId}: ${review.status}; summary: ${review.summary}`);
  console.log(`src/db.ts now:\n${db}`);

  assert.equal(review.status, 'addressed', 'review completed');
  assert.ok(threads.every((t) => t.comments.at(-1)?.author === 'claude'), 'every thread has a Claude reply last');
  assert.match(db, /bindings/);
  assert.doesNotMatch(db, /\bparams\b/);
  assert.ok(!calls.some((c) => /resolve/i.test(c.name)), 'Claude does not resolve threads');
  assert.ok(calls.some((c) => c.name === 'Monitor'), 'Claude armed the monitor to keep listening');
  console.log('\nLIVE TEST 1 PASSED');
} finally {
  try { postil(fx.dir, path, 'stop'); } catch { /* already stopped */ }
  fx.cleanup();
}
