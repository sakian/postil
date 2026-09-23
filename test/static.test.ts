import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startServer, type RunningServer } from '../src/server/server.ts';
import { makeFixture, type Fixture } from './helpers.ts';

function rawGet(port: number, path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('serving the UI', () => {
  let fx: Fixture;
  let web: string;
  let server: RunningServer;
  before(async () => {
    fx = makeFixture();
    fx.write('a', '1\n');
    fx.commit('base');
    web = mkdtempSync(join(tmpdir(), 'postil-web-'));
    mkdirSync(join(web, 'assets'));
    writeFileSync(join(web, 'index.html'), '<!doctype html><div id="root"></div><script src="/assets/app-abc123.js"></script>');
    writeFileSync(join(web, 'assets', 'app-abc123.js'), 'console.log(1)');
    writeFileSync(join(web, 'secret.txt'), 'outside assets');
    server = await startServer({ cwd: fx.dir, port: 0, webRoot: web });
  });
  after(async () => {
    await server.close();
    fx.cleanup();
    rmSync(web, { recursive: true, force: true });
  });

  it('serves index.html without a token, under a strict content security policy', async () => {
    const res = await rawGet(server.info.port, '/');
    assert.equal(res.status, 200);
    assert.match(res.body, /id="root"/);
    const csp = String(res.headers['content-security-policy']);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, new RegExp(`connect-src 'self' ws://127\\.0\\.0\\.1:${server.info.port}`));
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('serves hashed assets with a long cache lifetime', async () => {
    const res = await rawGet(server.info.port, '/assets/app-abc123.js');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /text\/javascript/);
    assert.match(String(res.headers['cache-control']), /immutable/);
  });

  it('refuses paths that escape the assets directory', async () => {
    for (const path of ['/assets/../secret.txt', '/assets/%2e%2e/secret.txt', '/assets/..%2fsecret.txt', '/assets/missing.js']) {
      const res = await rawGet(server.info.port, path);
      assert.notEqual(res.status, 200, path);
      assert.doesNotMatch(res.body, /outside assets/, path);
    }
  });

  it('puts the token in the URL fragment, which browsers never send to a server', () => {
    assert.match(server.uiUrl, /\/#token=[\w-]+$/);
  });
});

describe('serving before the UI is built', () => {
  it('explains how to build it', async () => {
    const fx = makeFixture();
    fx.write('a', '1\n');
    fx.commit('base');
    const server = await startServer({ cwd: fx.dir, port: 0, webRoot: join(fx.dir, 'no-such-dir') });
    try {
      const res = await rawGet(server.info.port, '/');
      assert.equal(res.status, 200);
      assert.match(res.body, /npm run build/);
    } finally {
      await server.close();
      fx.cleanup();
    }
  });
});

describe('raw blob previews', () => {
  it('serves an image with its type, a sandboxing policy, and the token in the query', async () => {
    const fx = makeFixture();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    fx.write('logo.png', png);
    fx.commit('base');
    const server = await startServer({ cwd: fx.dir, port: 0, webRoot: join(fx.dir, 'none') });
    try {
      const oid = fx.git('rev-parse', 'HEAD:logo.png').trim();
      const unauth = await fetch(`${server.info.url}/api/blobs/${oid}/raw?path=logo.png`);
      assert.equal(unauth.status, 401);
      const res = await fetch(`${server.info.url}/api/blobs/${oid}/raw?path=logo.png&token=${server.info.token}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/png');
      assert.match(res.headers.get('content-security-policy') ?? '', /^sandbox/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
      const svg = await fetch(`${server.info.url}/api/blobs/${oid}/raw?path=x.svg&token=${server.info.token}`);
      assert.match(svg.headers.get('content-security-policy') ?? '', /sandbox/, 'SVGs are sandboxed too');
    } finally {
      await server.close();
      fx.cleanup();
    }
  });
});
