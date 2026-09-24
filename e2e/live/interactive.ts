/**
 * Live test 2: the real thing. An interactive Claude Code session, idle at its prompt, is woken
 * by reviews submitted from outside it: two rounds on the same thread, then a server restart
 * that the session must recover from on its own, then a third round.
 *
 *   node e2e/live/interactive.ts
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { makeDemoRepo } from '../fixture.ts';
import type { ReviewView, ThreadView } from '../../src/core/api-types.ts';
import { ALLOWED_TOOLS, api, childEnv, userPath, PLUGIN, postil, reviewAddressed, submitReview, waitFor } from './lib.ts';

const TMUX = 'postil-live-test';
const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8' });
const pane = () => tmux('capture-pane', '-p', '-t', TMUX, '-S', '-60');
const type = (text: string) => {
  tmux('send-keys', '-t', TMUX, '-l', text);
  tmux('send-keys', '-t', TMUX, 'Enter');
};
const listening = async (dir: string) => (await api<{ listening: number }>(dir, 'GET', '/api/health')).listening;
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const fx = makeDemoRepo();
const path = userPath();
const env = childEnv(path);
try {
  postil(fx.dir, 'start', '--port', '0');
  // PATH goes into the command itself: tmux starts it through a shell whose startup files reset PATH.
  const cmd = ['env', `PATH=${path}`, 'claude', '--plugin-dir', PLUGIN, '--permission-mode', 'acceptEdits', '--allowedTools', ALLOWED_TOOLS.join(',')]
    .map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  tmux('new-session', '-d', '-s', TMUX, '-x', '220', '-y', '60', '-c', fx.dir,
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), cmd);
  log('interactive claude started in tmux');

  // A new directory asks whether to trust it. The default answer is "No, exit", so choose "Yes" explicitly.
  let trusted = false;
  await waitFor('the session to be ready', 90_000, async () => {
    const screen = pane();
    if (!trusted && /Yes, I trust this folder/.test(screen)) {
      tmux('send-keys', '-t', TMUX, 'Down');
      tmux('send-keys', '-t', TMUX, 'Enter');
      trusted = true;
      return null;
    }
    return /\? for shortcuts|accept edits on|auto mode/i.test(screen) ? true : null;
  });
  type('/postil:review');
  log('sent /postil:review');
  await waitFor('Claude to start listening', 180_000, async () => ((await listening(fx.dir)) > 0 ? true : null));
  log('Claude is listening; letting the session go idle');
  await new Promise((r) => setTimeout(r, 20_000));

  // ---------------------------------------------------------------- round 1, from idle
  const r1 = await submitReview(fx.dir, 'First pass.', [
    { path: 'src/db.ts', line: 'params: unknown[] = []', text: 'Rename `params` to `bindings`.' },
    { path: 'src/retry.ts', line: 'Math.random()', text: 'Cap the delay at 5 seconds.' },
  ]);
  log(`submitted review #${r1} while the session was idle`);
  let t0 = Date.now();
  await reviewAddressed(fx.dir, r1, 5 * 60_000);
  log(`review #${r1} addressed ${Math.round((Date.now() - t0) / 1000)}s later, with nobody typing`);

  // ---------------------------------------------------------------- round 2, same thread
  let { threads } = await api<{ threads: ThreadView[] }>(fx.dir, 'GET', '/api/threads');
  const dbThread = threads.find((t) => t.path === 'src/db.ts')!;
  const retryThread = threads.find((t) => t.path === 'src/retry.ts')!;
  await api(fx.dir, 'POST', `/api/threads/${retryThread.id}/resolve`);
  await api(fx.dir, 'POST', `/api/threads/${dbThread.id}/replies`, { body: 'Thanks. Also add a one-line JSDoc comment to `query`.' });
  const r2 = (await api<ReviewView>(fx.dir, 'POST', '/api/reviews/submit', {})).id;
  log(`submitted follow-up review #${r2} on the same thread`);
  t0 = Date.now();
  await reviewAddressed(fx.dir, r2, 5 * 60_000);
  log(`review #${r2} addressed ${Math.round((Date.now() - t0) / 1000)}s later`);

  // ---------------------------------------------------------------- server restart
  postil(fx.dir, 'stop');
  log('stopped the server; the monitor closes');
  await new Promise((r) => setTimeout(r, 3_000));
  postil(fx.dir, 'start');
  log('restarted the server');
  t0 = Date.now();
  await waitFor('Claude to reconnect by itself', 5 * 60_000, async () => ((await listening(fx.dir)) > 0 ? true : null));
  log(`Claude re-armed its monitor ${Math.round((Date.now() - t0) / 1000)}s after the restart`);
  await new Promise((r) => setTimeout(r, 10_000));

  // ---------------------------------------------------------------- round 3, after the restart
  const r3 = await submitReview(fx.dir, 'Last one.', [{ path: 'README.md', line: 'Retries now', text: 'Mention the 5 second cap here too.' }]);
  log(`submitted review #${r3} after the restart`);
  t0 = Date.now();
  await reviewAddressed(fx.dir, r3, 5 * 60_000);
  log(`review #${r3} addressed ${Math.round((Date.now() - t0) / 1000)}s later`);

  ({ threads } = await api<{ threads: ThreadView[] }>(fx.dir, 'GET', '/api/threads'));
  for (const t of threads) console.log(`\nthread ${t.id} ${t.path} [${t.status}]\n${t.comments.map((c) => `  [${c.author}] ${c.body}`).join('\n')}`);
  const files = execFileSync('git', ['diff', '--stat'], { cwd: fx.dir, encoding: 'utf8' });
  console.log(`\n${files}`);
  console.log(`--- last screen of the Claude session ---\n${pane().split('\n').filter((l) => l.trim()).slice(-25).join('\n')}`);

  const db = threads.find((t) => t.id === dbThread.id)!;
  assert.equal(db.comments.filter((c) => c.author === 'claude').length, 2, 'Claude answered both rounds on the db thread');
  assert.equal(threads.find((t) => t.id === retryThread.id)!.status, 'resolved', 'Claude left the resolved thread alone');
  console.log('\nLIVE TEST 2 PASSED');
} catch (e) {
  try {
    console.log(`--- Claude session screen at failure ---\n${pane()}`);
  } catch { /* the session is gone */ }
  throw e;
} finally {
  try { tmux('kill-session', '-t', TMUX); } catch { /* not running */ }
  try { postil(fx.dir, 'stop'); } catch { /* not running */ }
  fx.cleanup();
}
