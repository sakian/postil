import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { build } from 'esbuild';
import { makeFixture, numbered, type Fixture } from './helpers.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Build the plugin bundle into a temporary directory, as scripts/build-plugin.ts does. */
async function buildBundle(dir: string): Promise<string> {
  const outfile = join(dir, 'postil.mjs');
  const script = readFileSync(join(ROOT, 'scripts/build-plugin.ts'), 'utf8');
  const banner = /js: "(import \{ createRequire[^"]+)"/.exec(script)![1]!.replace(/\\n/g, '\n');
  await build({
    entryPoints: [join(ROOT, 'src/cli/main.ts')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node24',
    define: { __POSTIL_BUNDLE__: 'true', __POSTIL_VERSION__: '"9.9.9-test"' }, external: ['bufferutil', 'utf-8-validate'],
    banner: { js: banner }, logLevel: 'silent',
  });
  return outfile;
}

function run(bundle: string, args: string[], opts: { cwd: string; input?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, ...args], { cwd: opts.cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(opts.input ?? '');
  });
}

describe('the self-contained plugin bundle', { timeout: 60_000 }, () => {
  let dir: string;
  let bundle: string;
  let fx: Fixture;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'postil-bundle-'));
    bundle = await buildBundle(dir);
    fx = makeFixture();
    fx.write('f.txt', numbered(5));
    fx.commit('base');
    fx.write('f.txt', numbered(5, { 2: 'two' }));
  });
  after(async () => {
    await run(bundle, ['stop'], { cwd: fx.dir });
    fx.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs with plain node, knowing its own version', async () => {
    const r = await run(bundle, ['--version'], { cwd: dir });
    assert.deepEqual([r.code, r.stdout.trim()], [0, '9.9.9-test']);
  });

  it('serves the MCP tools, and connect starts a server from the bundle itself', async () => {
    const mcp = new Client({ name: 'test', version: '0' });
    try {
      await mcp.connect(new StdioClientTransport({
        command: process.execPath, args: [bundle, 'mcp'], cwd: fx.dir,
        env: { ...process.env as Record<string, string>, CLAUDE_PROJECT_DIR: fx.dir, CLAUDE_CODE_SESSION_ID: 'bundle-test-session' },
        stderr: 'pipe',
      }));
      assert.equal((await mcp.listTools()).tools.length, 8);
      const out = (await mcp.callTool({ name: 'connect', arguments: {} })) as { content: Array<{ text: string }> };
      assert.match(out.content[0]!.text, /ws:\/\/127\.0\.0\.1:\d+\/events/);
      const status = await run(bundle, ['status'], { cwd: fx.dir });
      assert.match(status.stdout, /postil 9\.9\.9-test serving/, 'the running server is the bundle');
    } finally {
      await mcp.close();
    }
  });

  it('answers hooks', async () => {
    const r = await run(bundle, ['hook', 'stop'], { cwd: fx.dir, input: JSON.stringify({ cwd: fx.dir, session_id: 'bundle-test-session' }) });
    assert.equal(r.code, 0);
  });
});
