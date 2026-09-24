import { strict as assert } from 'node:assert';
import { writeFileSync, statSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { NotRunningError, PostilClient } from '../src/core/client.ts';
import { AlreadyRunningError } from '../src/core/discovery.ts';
import { startServer, type RunningServer } from '../src/server/server.ts';
import { makeFixture, numbered, type Fixture } from './helpers.ts';

interface Feed {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  next(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

function openFeed(url: string, headers: Record<string, string> = {}): Promise<Feed> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const frames: Array<Record<string, unknown>> = [];
    const waiters: Array<{ type: string; resolve: (f: Record<string, unknown>) => void }> = [];
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      frames.push(frame);
      for (const w of waiters.filter((x) => x.type === frame.type)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(frame);
      }
    });
    ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
    ws.once('error', reject);
    ws.once('open', () =>
      resolve({
        ws,
        frames,
        next(type, timeoutMs = 3000) {
          const seen = frames.find((f) => f.type === type && !(f as { _taken?: boolean })._taken);
          if (seen) {
            (seen as { _taken?: boolean })._taken = true;
            return Promise.resolve(seen);
          }
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`no ${type} frame within ${timeoutMs}ms`)), timeoutMs);
            waiters.push({ type, resolve: (f) => { clearTimeout(timer); (f as { _taken?: boolean })._taken = true; res(f); } });
          });
        },
        close: () => ws.close(),
      }),
    );
  });
}

function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('server', () => {
  let fx: Fixture;
  let server: RunningServer;
  let api: <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => Promise<{ status: number; json: T }>;

  before(async () => {
    fx = makeFixture();
    fx.write('src/app.ts', numbered(20));
    fx.commit('base');
    fx.write('src/app.ts', numbered(20, { 7: 'const secret = "hunter2";' }));
    server = await startServer({ cwd: fx.dir, port: 0, pollMs: 50 });
    api = async (method, path, body) => {
      const res = await fetch(`${server.info.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${server.info.token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
        ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      });
      return { status: res.status, json: (await res.json()) as never };
    };
  });
  after(async () => {
    await server.close();
    fx.cleanup();
  });

  describe('security boundary', () => {
    it('requires the token on the API, by header or query', async () => {
      const url = `${server.info.url}/api/health`;
      assert.equal((await fetch(url)).status, 401);
      assert.equal((await fetch(url, { headers: { authorization: 'Bearer wrong' } })).status, 401);
      assert.equal((await fetch(url, { headers: { authorization: `Bearer ${server.info.token}` } })).status, 200);
      assert.equal((await fetch(`${url}?token=${server.info.token}`)).status, 200);
    });

    it('rejects foreign Host headers, which is how DNS rebinding arrives', async () => {
      const auth = { authorization: `Bearer ${server.info.token}` };
      assert.equal(await rawGet(server.info.port, '/api/health', { ...auth, host: 'evil.example:80' }), 403);
      assert.equal(await rawGet(server.info.port, '/api/health', { ...auth, host: `localhost:${server.info.port}` }), 200);
    });

    it('guards the event feed with the token and a same-origin check', async () => {
      const base = `ws://127.0.0.1:${server.info.port}/events`;
      await assert.rejects(openFeed(`${base}?token=wrong`), /401/);
      await assert.rejects(openFeed(`${base}?token=${server.info.token}`, { origin: 'https://evil.example' }), /403/);
      await assert.rejects(openFeed(`${base}?token=${server.info.token}&channel=admin`), /400/);
      const ok = await openFeed(`${base}?token=${server.info.token}`, { origin: server.info.url });
      assert.equal((await ok.next('hello')).channel, 'ui');
      ok.close();
    });

    it('writes discovery files readable only by the owner', { skip: process.platform === 'win32' && 'Windows has no POSIX modes; files take their ACL from the directory' }, () => {
      const stateDir = server.postil.repo.stateDir;
      for (const name of ['server.json', 'token']) {
        assert.equal(statSync(join(stateDir, name)).mode & 0o777, 0o600, name);
      }
    });
  });

  describe('validation and errors', () => {
    it('reports malformed requests as structured 400s', async () => {
      const notJson = await api<{ error: { code: string } }>('POST', '/api/threads', '{nope');
      assert.deepEqual([notJson.status, notJson.json.error.code], [400, 'invalid_json']);
      const invalid = await api<{ error: { code: string } }>('POST', '/api/threads', { path: 'x' });
      assert.deepEqual([invalid.status, invalid.json.error.code], [400, 'invalid_request']);
      const missing = await api<{ error: { code: string } }>('GET', '/api/threads/9999');
      assert.deepEqual([missing.status, missing.json.error.code], [404, 'unknown_thread']);
      const route = await api<{ error: { code: string } }>('GET', '/api/nope');
      assert.equal(route.status, 404);
    });
  });

  describe('the review loop over HTTP and WebSocket', () => {
    let ui: Feed;
    let agent: Feed;
    let reviewId: number;
    let threadId: number;

    before(async () => {
      ui = await openFeed(`ws://127.0.0.1:${server.info.port}/events?token=${server.info.token}`);
      agent = await openFeed(server.agentEventsUrl);
      assert.deepEqual((await agent.next('hello')).pending_reviews, []);
    });
    after(() => { ui.close(); agent.close(); });

    it('resolves a scope and returns its files in one call', async () => {
      const { status, json } = await api<{ from: { tree: string }; to: { tree: string; live: boolean }; files: Array<{ path: string; new_blob: string }> }>(
        'POST', '/api/diff/resolve', { scope: { kind: 'all' } },
      );
      assert.equal(status, 200);
      assert.equal(json.to.live, true);
      assert.deepEqual(json.files.map((f) => f.path), ['src/app.ts']);

      const file = await api<{ hunks: unknown[]; new_lines: number }>('GET', `/api/diff/file?new=${json.files[0]!.new_blob}&context=2`);
      assert.equal(file.json.new_lines, 20);

      const created = await api<{ id: number; published: boolean }>('POST', '/api/threads', {
        from_tree: json.from.tree, to_tree: json.to.tree, path: 'src/app.ts', side: 'new', start_line: 7, body: 'Hardcoded secret.',
      });
      assert.equal(created.status, 201);
      threadId = created.json.id;
      await ui.next('draft.changed');
    });

    it('delivers the doorbell to Claude only on submit', async () => {
      const submitted = await api<{ id: number }>('POST', '/api/reviews/submit', { body: 'Please fix.' });
      reviewId = submitted.json.id;
      const bell = await agent.next('review.submitted');
      assert.equal(bell.review_id, reviewId);
      assert.equal(bell.thread_count, 1);
      assert.match(String(bell.hint), /get_review/);
      await ui.next('review.submitted');
    });

    it('lets Claude fetch, reply and complete, while the UI follows along', async () => {
      const review = await api<{ status: string; threads: Array<{ id: number; awaiting_reply: boolean }> }>('GET', `/api/agent/reviews/${reviewId}`);
      assert.equal(review.json.status, 'in_progress');
      await ui.next('review.started');

      const blocked = await api<{ error: { code: string; details: { thread_ids: number[] } } }>(
        'POST', `/api/agent/reviews/${reviewId}/complete`, { summary: 'done' },
      );
      assert.deepEqual([blocked.status, blocked.json.error.code, blocked.json.error.details.thread_ids], [409, 'unanswered_threads', [threadId]]);
      assert.deepEqual((await api<{ threads: unknown[] }>('GET', `/api/agent/reviews/${reviewId}/unanswered`)).json.threads.length, 1);

      fx.write('src/app.ts', numbered(20, { 7: 'const secret = process.env.SECRET;' }));
      const reply = await api('POST', `/api/agent/threads/${threadId}/reply`, { body: 'Read from the environment now.' });
      assert.equal(reply.status, 201);
      await ui.next('thread.replied');

      const done = await api<{ status: string }>('POST', `/api/agent/reviews/${reviewId}/complete`, { summary: 'Moved the secret to env.' });
      assert.equal(done.json.status, 'addressed');
      await ui.next('review.completed');
    });

    it('never sends Claude anything but the doorbell', () => {
      assert.deepEqual(agent.frames.map((f) => f.type), ['hello', 'review.submitted']);
    });

    it('tells a re-armed monitor about reviews it missed while disconnected', async () => {
      agent.close();
      const scope = await api<{ from: { tree: string }; to: { tree: string } }>('POST', '/api/diff/resolve', { scope: { kind: 'all' } });
      await api('POST', '/api/threads', {
        from_tree: scope.json.from.tree, to_tree: scope.json.to.tree, path: 'src/app.ts', side: 'new', start_line: 1, body: 'Missed?',
      });
      const missed = await api<{ id: number }>('POST', '/api/reviews/submit', {});
      const rearmed = await openFeed(server.agentEventsUrl);
      const hello = await rearmed.next('hello');
      assert.deepEqual(hello.pending_reviews, [missed.json.id]);
      assert.match(String(hello.hint), new RegExp(`#${missed.json.id}`));
      rearmed.close();
    });

    it('announces working tree changes to the browser while one is connected', async () => {
      fx.write('src/new-file.ts', 'export {};\n');
      const change = await ui.next('worktree.changed');
      assert.match(String(change.tree), /^[0-9a-f]{40}$/);
    });
  });

  describe('discovery', () => {
    it('lets clients find the server from inside the repository', async () => {
      const client = await PostilClient.connect(join(fx.dir, 'src'));
      assert.equal(client.info.port, server.info.port);
      const health = await client.request<{ root: string }>('GET', '/api/health');
      assert.equal(health.root, fx.dir);
    });

    it('refuses a second server for the same repository', async () => {
      await assert.rejects(startServer({ cwd: fx.dir, port: 0 }), AlreadyRunningError);
    });
  });
});

describe('server lifecycle', () => {
  it('cleans up on close, so clients see it as stopped', async () => {
    const fx = makeFixture();
    try {
      fx.write('a', '1\n');
      fx.commit('base');
      const server = await startServer({ cwd: fx.dir, port: 0 });
      const stateDir = server.postil.repo.stateDir;
      await server.close();
      assert.equal(existsSync(join(stateDir, 'server.json')), false);
      assert.equal(existsSync(join(stateDir, 'server.lock')), false);
      await assert.rejects(PostilClient.connect(fx.dir), NotRunningError);
    } finally {
      fx.cleanup();
    }
  });

  it('takes over a lock left behind by a crashed server', async () => {
    const fx = makeFixture();
    try {
      fx.write('a', '1\n');
      fx.commit('base');
      const first = await startServer({ cwd: fx.dir, port: 0 });
      const stateDir = first.postil.repo.stateDir;
      await first.close();
      writeFileSync(join(stateDir, 'server.lock'), '999999999'); // a pid that cannot exist
      const second = await startServer({ cwd: fx.dir, port: 0 });
      assert.ok(second.info.port > 0);
      await second.close();

      // A crashed process whose pid we now have: our pid, but not a lock we hold.
      writeFileSync(join(stateDir, 'server.lock'), String(process.pid));
      const third = await startServer({ cwd: fx.dir, port: 0 });
      assert.ok(third.info.port > 0);
      await third.close();
    } finally {
      fx.cleanup();
    }
  });

  it('reuses its previous port, and keeps the token, across restarts', async () => {
    const fx = makeFixture();
    try {
      fx.write('a', '1\n');
      fx.commit('base');
      const first = await startServer({ cwd: fx.dir });
      const { port, token } = first.info;
      await first.close();
      const second = await startServer({ cwd: fx.dir });
      assert.deepEqual([second.info.port, second.info.token], [port, token]);
      await second.close();
    } finally {
      fx.cleanup();
    }
  });
});
