import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, readlink, realpath, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotRunningError, PostilClient } from '../core/client.ts';
import { pidAlive, probe } from '../core/discovery.ts';
import { Repo } from '../git/repo.ts';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));

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
  const target = resolve(dir, 'postil');
  await mkdir(dir, { recursive: true });
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

function onPath(dir: string): boolean {
  const want = resolve(dir);
  return (process.env.PATH ?? '').split(delimiter).some((p) => p && resolve(p) === want);
}
