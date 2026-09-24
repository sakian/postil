import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { CLI_ENTRY } from '../core/build-info.ts';
import { NotRunningError, PostilClient } from '../core/client.ts';
import { pidAlive, probe } from '../core/discovery.ts';
import { Repo } from '../git/repo.ts';

const MAIN = CLI_ENTRY;

async function tryConnect(cwd: string): Promise<PostilClient | null> {
  try {
    return await PostilClient.connect(cwd);
  } catch (e) {
    if (e instanceof NotRunningError) return null;
    throw e;
  }
}

/**
 * Start the server in the background, or report the one already running. Its output goes to
 * the repository's postil state directory, so nothing appears in the working tree.
 */
export async function startDaemon(cwd: string, port?: number): Promise<{ client: PostilClient; started: boolean; log: string }> {
  const repo = await Repo.open(cwd);
  const log = join(repo.stateDir, 'server.log');
  const running = await tryConnect(cwd);
  if (running) return { client: running, started: false, log };

  await mkdir(repo.stateDir, { recursive: true });
  const out = await open(log, 'a', 0o600);
  const child = spawn(process.execPath, [MAIN, 'serve', ...(port !== undefined ? ['--port', String(port)] : [])], {
    cwd: repo.root,
    detached: true,
    stdio: ['ignore', out.fd, out.fd],
  });
  child.unref();
  await out.close();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const client = await tryConnect(cwd);
    if (client) return { client, started: true, log };
    if (child.exitCode !== null) break;
  }
  const tail = (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').slice(-8).join('\n');
  throw new Error(`the server did not start. Last lines of ${log}:\n${tail}`);
}

export async function stopDaemon(cwd: string): Promise<boolean> {
  const client = await tryConnect(cwd);
  if (!client) return false;
  process.kill(client.info.pid, 'SIGTERM');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (!pidAlive(client.info.pid) || !(await probe(client.info, client.info.root, 300))) return true;
  }
  throw new Error(`server (pid ${client.info.pid}) did not stop within 10s`);
}

/**
 * Put `postil` on PATH as a symlink to this checkout, so the Claude Code plugin can run it.
 * A symlink rather than a copy keeps it current with the checkout, and Node follows it to a
 * real path outside node_modules, where it is allowed to run TypeScript directly.
 */
export async function linkBinary(dir = join(homedir(), '.local', 'bin'), force = false): Promise<{ path: string; onPath: boolean }> {
  await mkdir(dir, { recursive: true });
  if (process.platform === 'win32') return linkShims(dir, force);
  const target = resolve(dir, 'postil');
  const existing = await lstat(target).catch(() => null);
  if (existing) {
    const current = existing.isSymbolicLink() ? resolve(dir, await readlink(target)) : null;
    if (current && (await realpath(current).catch(() => current)) === (await realpath(MAIN))) {
      return { path: target, onPath: onPath(dir) };
    }
    if (!force) throw new Error(`${target} already exists; pass --force to replace it`);
    const { rm } = await import('node:fs/promises');
    await rm(target);
  }
  await symlink(MAIN, target);
  return { path: target, onPath: onPath(dir) };
}

/**
 * Windows needs admin rights or developer mode for symlinks, and would not run a symlinked .ts
 * file anyway, so it gets two small launchers instead: postil.cmd for cmd and PowerShell, and an
 * extensionless sh script for Git Bash. Both run the checkout through node, so they stay current.
 */
async function linkShims(dir: string, force: boolean): Promise<{ path: string; onPath: boolean }> {
  const shims: [string, string][] = [
    [resolve(dir, 'postil.cmd'), `@node "${MAIN}" %*\r\n`],
    [resolve(dir, 'postil'), `#!/bin/sh\nexec node "${MAIN.replace(/\\/g, '/')}" "$@"\n`],
  ];
  const current = await Promise.all(shims.map(([path]) => readFile(path, 'utf8').catch(() => null)));
  const clobbers = shims.filter(([, content], i) => current[i] !== null && current[i] !== content);
  if (clobbers.length && !force) throw new Error(`${clobbers[0]![0]} already exists; pass --force to replace it`);
  for (const [path, content] of shims) await writeFile(path, content, { mode: 0o755 });
  return { path: shims[0]![0], onPath: onPath(dir) };
}

function onPath(dir: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  const want = norm(dir);
  return (process.env.PATH ?? '').split(delimiter).some((p) => p && norm(p) === want);
}

/** Open a URL in the user's browser. Resolves false when no browser could be launched. */
export function openBrowser(url: string): Promise<boolean> {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  return new Promise<boolean>((done) => {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
    child.once('error', () => done(false));
    child.once('spawn', () => {
      child.unref();
      done(true);
    });
  });
}

/** The command a Monitor runs to be told when the server is back, with no reliance on PATH. */
export function waitCommand(repoRoot: string): string {
  if (process.platform === 'win32') {
    // Claude may run this in Git Bash or PowerShell. A leading quoted path is only a string in
    // PowerShell, and single quotes mean nothing to cmd, so use bare node and double quotes.
    const q = (s: string) => `"${s.replace(/\\/g, '/')}"`;
    return `node ${q(MAIN)} -C ${q(repoRoot)} wait`;
  }
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `${q(process.execPath)} ${q(MAIN)} -C ${q(repoRoot)} wait`;
}
