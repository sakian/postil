import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { formatReview } from '../src/cli/agent-format.ts';
import { startServer, type RunningServer } from '../src/server/server.ts';
import { makeFixture, numbered, type Fixture } from './helpers.ts';

const MAIN = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
const SESSION = '0f3c9a52-7d1e-4a5b-9c2d-1e2f3a4b5c6d';

/** Run the CLI as a separate process, as Claude Code runs hooks. */
function cli(args: string[], opts: { cwd: string; input?: string; env?: Record<string, string> }): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [MAIN, ...args], { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(opts.input ?? '');
  });
}

type ToolText = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const textOf = (r: unknown) => (r as ToolText).content.map((c) => c.text ?? '').join('\n');

describe('MCP server and hooks against a live review server', () => {
  let fx: Fixture;
  let server: RunningServer;
  let mcp: Client;
  let threadId: number;
  let reviewId: number;

  const hook = (event: string, input: Record<string, unknown>) =>
    cli(['hook', event], { cwd: fx.dir, input: JSON.stringify({ cwd: fx.dir, ...input }) });

  before(async () => {
    fx = makeFixture();
    fx.write('src/db.ts', numbered(12));
    fx.commit('base');
    fx.write('src/db.ts', numbered(12, { 6: 'const conn = open();' }));
    server = await startServer({ cwd: fx.dir, port: 0 });
    mcp = new Client({ name: 'test', version: '0' });
    await mcp.connect(new StdioClientTransport({
      command: process.execPath,
      args: [MAIN, 'mcp'],
      cwd: fx.dir,
      env: { ...process.env as Record<string, string>, CLAUDE_PROJECT_DIR: fx.dir, CLAUDE_CODE_SESSION_ID: SESSION },
      stderr: 'pipe',
    }));
  });
  after(async () => {
    await mcp?.close();
    await server?.close();
    fx?.cleanup();
  });

  it('offers the review tools', async () => {
    const { tools } = await mcp.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'apply_suggestion', 'complete_review', 'connect', 'get_review', 'get_thread', 'list_pending', 'open_ui', 'reply',
    ]);
  });

  it('keeps hooks silent in a session that is not listening', async () => {
    const scope = await server.postil.resolveScope({ kind: 'all' });
    const t = await server.postil.createThread({
      from_tree: scope.from.tree, to_tree: scope.to.tree, path: 'src/db.ts', side: 'new', start_line: 6, body: 'Is `conn` ever closed?',
    });
    threadId = t.id;
    reviewId = (await server.postil.submitReview('One question.')).id;
    for (const event of ['stop', 'prompt']) {
      const r = await hook(event, { session_id: SESSION });
      assert.deepEqual([r.code, r.stdout], [0, ''], event);
    }
  });

  it('connect registers the session and returns a monitor URL naming it', async () => {
    const out = textOf(await mcp.callTool({ name: 'connect', arguments: {} }));
    assert.match(out, new RegExp(`ws://127\\.0\\.0\\.1:${server.info.port}/events\\?channel=agent&session=${SESSION}&token=`));
    assert.match(out, new RegExp(`Reviews already waiting: #${reviewId}`));
    assert.equal(server.postil.store.isListener(SESSION), true);
  });

  it('the stop hook now blocks until the waiting review is handled', async () => {
    const r = await hook('stop', { session_id: SESSION, stop_hook_active: false });
    const out = JSON.parse(r.stdout) as { decision: string; reason: string };
    assert.equal(out.decision, 'block');
    assert.match(out.reason, new RegExp(`review #${reviewId}`));
    assert.match(out.reason, /get_review/);
  });

  it('the stop hook honours the loop guard, and never blocks another session', async () => {
    assert.equal((await hook('stop', { session_id: SESSION, stop_hook_active: true })).stdout, '');
    assert.equal((await hook('stop', { session_id: 'someone-else' })).stdout, '');
  });

  it('the prompt hook adds a reminder as context rather than blocking', async () => {
    const out = JSON.parse((await hook('prompt', { session_id: SESSION })).stdout) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`#${reviewId}`));
  });

  it('get_review renders the review for Claude and claims it', async () => {
    const out = textOf(await mcp.callTool({ name: 'get_review', arguments: { review_id: reviewId } }));
    assert.match(out, new RegExp(`# postil review #${reviewId} \\(in progress\\)`));
    assert.match(out, /One question\./);
    assert.match(out, new RegExp(`## Thread ${threadId}: src/db\\.ts, line 6 \\[NEEDS YOUR REPLY\\]`));
    assert.match(out, /const conn = open\(\);/);
    assert.equal(server.postil.store.getReview(reviewId)?.agent_session, SESSION);
  });

  it('the stop hook switches to naming the threads still owed', async () => {
    const out = JSON.parse((await hook('stop', { session_id: SESSION })).stdout) as { reason: string };
    assert.match(out.reason, new RegExp(`thread ${threadId} \\(src/db\\.ts:6\\)`));
  });

  it('complete_review refuses early, then reply and complete close the loop', async () => {
    const early = (await mcp.callTool({ name: 'complete_review', arguments: { review_id: reviewId, summary: 'done' } })) as ToolText;
    assert.equal(early.isError, true);
    assert.match(textOf(early), /without a reply/);

    const replied = await mcp.callTool({ name: 'reply', arguments: { thread_id: threadId, body: 'Now closed in `finally`.' } });
    assert.match(textOf(replied), /Replied to thread/);
    const stillOwed = JSON.parse((await hook('stop', { session_id: SESSION })).stdout) as { reason: string };
    assert.match(stillOwed.reason, /complete_review/);

    const done = await mcp.callTool({ name: 'complete_review', arguments: { review_id: reviewId, summary: 'Closed the connection.' } });
    assert.match(textOf(done), /is complete/);
    assert.equal(server.postil.review(reviewId).status, 'addressed');
    assert.equal((await hook('stop', { session_id: SESSION })).stdout, '', 'nothing owed any more');
  });

  it('get_thread shows published comments only', async () => {
    server.postil.replyAsUser(threadId, 'a draft Claude must not see');
    const out = textOf(await mcp.callTool({ name: 'get_thread', arguments: { thread_id: threadId } }));
    assert.match(out, /Now closed in `finally`/);
    assert.doesNotMatch(out, /must not see/);
  });

  it('the session-start hook points new sessions at the skill, and resumed listeners at re-arming', async () => {
    const fresh = JSON.parse((await hook('session-start', { session_id: 'new-session', source: 'startup' })).stdout) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(fresh.hookSpecificOutput.additionalContext, /postil review skill/);
    const resumed = JSON.parse((await hook('session-start', { session_id: SESSION, source: 'resume' })).stdout) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(resumed.hookSpecificOutput.additionalContext, /re-arm the Monitor/);
  });

  it('hooks answer quickly, since they run on every turn', async () => {
    const r = await hook('stop', { session_id: SESSION });
    assert.ok(r.ms < 1500, `took ${r.ms}ms`);
  });
});

describe('without a review server', () => {
  it('hooks exit quietly, inside and outside a repository', async () => {
    const fx = makeFixture();
    const outside = mkdtempSync(join(tmpdir(), 'postil-norepo-'));
    try {
      for (const cwd of [fx.dir, outside]) {
        const r = await cli(['hook', 'stop'], { cwd, input: JSON.stringify({ cwd, session_id: SESSION }) });
        assert.deepEqual([r.code, r.stdout], [0, ''], cwd);
      }
      const garbage = await cli(['hook', 'stop'], { cwd: fx.dir, input: 'not json' });
      assert.deepEqual([garbage.code, garbage.stdout], [0, '']);
    } finally {
      fx.cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('connect starts the server, but will not restart one that has stopped', async () => {
    const fx = makeFixture();
    fx.write('a', '1\n');
    fx.commit('base');
    const mcp = new Client({ name: 'test', version: '0' });
    try {
      await mcp.connect(new StdioClientTransport({
        command: process.execPath, args: [MAIN, 'mcp'], cwd: fx.dir,
        env: { ...process.env as Record<string, string>, CLAUDE_PROJECT_DIR: fx.dir, CLAUDE_CODE_SESSION_ID: SESSION }, stderr: 'pipe',
      }));
      const reconnect = (await mcp.callTool({ name: 'connect', arguments: { start: false } })) as ToolText;
      assert.equal(reconnect.isError, true);
      assert.match(textOf(reconnect), /arm the Monitor tool with command: .*main\.ts.* wait/);
      assert.match((await cli(['status'], { cwd: fx.dir })).stderr, /no postil server/, 'start=false started nothing');

      const started = textOf(await mcp.callTool({ name: 'connect', arguments: {} }));
      assert.match(started, /ws:\/\/127\.0\.0\.1:\d+\/events\?channel=agent&session=/);
      assert.match((await cli(['status'], { cwd: fx.dir })).stdout, /serving/);
    } finally {
      await mcp.close();
      await cli(['stop'], { cwd: fx.dir });
      fx.cleanup();
    }
  });
});

describe('CLI lifecycle', () => {
  it('starts in the background, reports the running server, and stops', async () => {
    const fx = makeFixture();
    fx.write('a', '1\n');
    fx.commit('base');
    try {
      const first = await cli(['start', '--port', '0'], { cwd: fx.dir });
      assert.equal(first.code, 0, first.stderr);
      assert.match(first.stdout, /postil started/);
      const again = await cli(['start'], { cwd: fx.dir });
      assert.match(again.stdout, /already running/);
      const status = await cli(['status'], { cwd: fx.dir });
      assert.match(status.stdout, /waiting: {2}none/);
      assert.match((await cli(['stop'], { cwd: fx.dir })).stdout, /postil stopped/);
      assert.match((await cli(['stop'], { cwd: fx.dir })).stdout, /not running/);
    } finally {
      await cli(['stop'], { cwd: fx.dir });
      fx.cleanup();
    }
  });

  it('wait blocks until a server appears, then prints one line and exits', async () => {
    const fx = makeFixture();
    fx.write('a', '1\n');
    fx.commit('base');
    try {
      const timedOut = await cli(['wait', '--timeout', '1'], { cwd: fx.dir });
      assert.equal(timedOut.code, 1);
      assert.match(timedOut.stdout, /did not come back/);

      const waiting = cli(['wait', '--timeout', '20'], { cwd: fx.dir });
      await new Promise((r) => setTimeout(r, 1500));
      await cli(['start', '--port', '0'], { cwd: fx.dir });
      const back = await waiting;
      assert.equal(back.code, 0);
      assert.equal(back.stdout.trim().split('\n').length, 1, 'exactly one event for the Monitor');
      assert.match(back.stdout, /running again/);
    } finally {
      await cli(['stop'], { cwd: fx.dir });
      fx.cleanup();
    }
  });

  it('links the binary onto a directory, idempotently, without clobbering other files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postil-bin-'));
    try {
      const r = await cli(['link', '--dir', dir], { cwd: dir });
      assert.equal(r.code, 0, r.stderr);
      if (process.platform === 'win32') {
        assert.match(readFileSync(join(dir, 'postil.cmd'), 'utf8'), /^@node ".+main\.ts" %\*/);
        assert.match(readFileSync(join(dir, 'postil'), 'utf8'), /^#!\/bin\/sh\nexec node ".+\/main\.ts" "\$@"/);
      } else {
        assert.ok(lstatSync(join(dir, 'postil')).isSymbolicLink());
        assert.equal(readlinkSync(join(dir, 'postil')), MAIN);
      }
      assert.equal((await cli(['link', '--dir', dir], { cwd: dir })).code, 0, 'relinking is a no-op');
      assert.ok(existsSync(join(dir, 'postil')));
      if (process.platform === 'win32') {
        const shim = spawnSync(join(dir, 'postil.cmd'), ['--version'], { encoding: 'utf8', shell: true });
        assert.equal(shim.status, 0, shim.stderr);
        writeFileSync(join(dir, 'postil'), 'someone else\n');
        assert.equal((await cli(['link', '--dir', dir], { cwd: dir })).code, 1, 'does not clobber another file');
      } else {
        const version = await cli(['--version'], { cwd: dir, env: { PATH: `${dir}:${process.env.PATH}` } });
        assert.equal(version.code, 0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('review formatting and CLI options', () => {
  it('explains apply_suggestion whenever a comment has a suggestion, whatever its fence', () => {
    const out = formatReview({
      id: 1, status: 'in_progress', body: '', submitted_at: null,
      threads: [{
        id: 2, path: 'a.ts', side: 'new', start_line: 1, end_line: 1, anchor_text: 'x', status: 'open',
        needs_decision: false, awaiting_reply: true, anchor: { state: 'current', path: 'a.ts', start_line: 1, end_line: 1 },
        comments: [{ id: 3, author: 'user', body: '~~~suggestion\ny\n~~~', created_at: '', in_this_review: true, suggestion: true, applied: false }],
      }],
    });
    assert.match(out, /Apply it with apply_suggestion if you agree/);
  });

  it('rejects options that do not apply to the command, and conflicting base choices', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'postil-cli-'));
    try {
      for (const args of [['base', 'main', '--empty'], ['base', '--empty', '--reset'], ['start', '--empty'], ['status', '--port', '5']]) {
        const r = await cli(args, { cwd: dir });
        assert.equal(r.code, 2, args.join(' '));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('review formatting', () => {
  it('fences anchored code so backticks inside it cannot escape', () => {
    const out = formatReview({
      id: 1, status: 'in_progress', body: '', submitted_at: null,
      threads: [{
        id: 2, path: 'a.md', side: 'new', start_line: 1, end_line: 1, anchor_text: 'x ```` y', status: 'open',
        needs_decision: false, awaiting_reply: true, anchor: { state: 'current', path: 'a.md', start_line: 1, end_line: 1 },
        comments: [{ id: 3, author: 'user', body: 'hm', created_at: '', in_this_review: true, suggestion: false, applied: false }],
      }],
    });
    assert.match(out, /`````\nx ```` y\n`````/);
  });
});

describe('several repositories at once', () => {
  it('runs one server per repository, and routes the CLI, MCP tools and hooks by directory', async () => {
    const a = makeFixture();
    const b = makeFixture();
    for (const fx of [a, b]) {
      fx.write('f.txt', numbered(5));
      fx.commit('base');
      fx.write('f.txt', numbered(5, { 2: 'two' }));
    }
    const sa = await startServer({ cwd: a.dir, port: 0 });
    const sb = await startServer({ cwd: b.dir, port: 0 });
    const mcpA = new Client({ name: 'test', version: '0' });
    try {
      assert.notEqual(sa.info.port, sb.info.port);
      assert.ok((await cli(['status'], { cwd: join(b.dir) })).stdout.includes(`serving ${b.dir} `));

      await mcpA.connect(new StdioClientTransport({
        command: process.execPath, args: [MAIN, 'mcp'], cwd: a.dir,
        env: { ...process.env as Record<string, string>, CLAUDE_PROJECT_DIR: a.dir, CLAUDE_CODE_SESSION_ID: SESSION },
        stderr: 'pipe',
      }));
      const out = textOf(await mcpA.callTool({ name: 'connect', arguments: {} }));
      assert.match(out, new RegExp(`127\\.0\\.0\\.1:${sa.info.port}/`), "a session in repository A talks to A's server");
      assert.equal(sa.postil.store.isListener(SESSION), true);
      assert.equal(sb.postil.store.isListener(SESSION), false);

      // A review waiting in B does not block the session listening in A.
      const scope = await sb.postil.resolveScope({ kind: 'all' });
      await sb.postil.createThread({ from_tree: scope.from.tree, to_tree: scope.to.tree, path: 'f.txt', side: 'new', start_line: 2, body: 'b' });
      await sb.postil.submitReview();
      const hookB = await cli(['hook', 'stop'], { cwd: b.dir, input: JSON.stringify({ cwd: b.dir, session_id: SESSION }) });
      assert.equal(hookB.stdout, '');
    } finally {
      await mcpA.close();
      await sa.close();
      await sb.close();
      a.cleanup();
      b.cleanup();
    }
  });
});
