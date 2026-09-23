import { randomBytes } from 'node:crypto';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * How clients find a running server. Everything lives in the repository's postil state
 * directory with owner-only permissions: the token is the only thing standing between
 * the API and any other local process or web page.
 */
export interface ServerInfo {
  pid: number;
  port: number;
  url: string;
  token: string;
  root: string;
  version: string;
  started_at: string;
}

const files = (stateDir: string) => ({
  token: join(stateDir, 'token'),
  info: join(stateDir, 'server.json'),
  lock: join(stateDir, 'server.lock'),
  port: join(stateDir, 'last-port'),
});

async function writePrivate(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, path);
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** The API token persists across restarts, so an open browser tab can reconnect. */
export async function loadOrCreateToken(stateDir: string): Promise<string> {
  const existing = (await readOptional(files(stateDir).token))?.trim();
  if (existing) return existing;
  const token = randomBytes(32).toString('base64url');
  await writePrivate(files(stateDir).token, token);
  return token;
}

export async function lastPort(stateDir: string): Promise<number | null> {
  const port = Number((await readOptional(files(stateDir).port))?.trim());
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

export async function rememberPort(stateDir: string, port: number): Promise<void> {
  await writePrivate(files(stateDir).port, String(port));
}

export async function writeServerInfo(stateDir: string, info: ServerInfo): Promise<void> {
  await writePrivate(files(stateDir).info, JSON.stringify(info, null, 2));
}

export async function readServerInfo(stateDir: string): Promise<ServerInfo | null> {
  const text = await readOptional(files(stateDir).info);
  if (!text) return null;
  try {
    return JSON.parse(text) as ServerInfo;
  } catch {
    return null;
  }
}

export async function removeServerInfo(stateDir: string): Promise<void> {
  await rm(files(stateDir).info, { force: true });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class AlreadyRunningError extends Error {
  readonly pid: number;
  constructor(pid: number) {
    super(`a postil server (pid ${pid}) is already running for this repository`);
    this.name = 'AlreadyRunningError';
    this.pid = pid;
  }
}

/** Lock files this process holds, to tell our own live lock from a stale one that reused our pid. */
const heldLocks = new Set<string>();

/**
 * One server per repository. The lock is created exclusively, so two simultaneous starts
 * cannot both win. A lock left by a crashed server is detected by its dead pid and taken over.
 * A lock carrying our own pid is live only if this process actually holds it; otherwise it
 * was left by a crashed process whose pid we inherited, which happens routinely in containers.
 */
export async function acquireLock(stateDir: string): Promise<() => Promise<void>> {
  const path = files(stateDir).lock;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      heldLocks.add(path);
      return async () => {
        if (!heldLocks.delete(path)) return;
        const owner = Number((await readOptional(path))?.trim());
        if (owner === process.pid) await rm(path, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const owner = Number((await readOptional(path))?.trim());
      const live = owner === process.pid ? heldLocks.has(path) : Number.isInteger(owner) && owner > 0 && pidAlive(owner);
      if (live) throw new AlreadyRunningError(owner);
      await rm(path, { force: true });
    }
  }
  throw new Error(`could not acquire ${path}`);
}

/** True when the server described by `info` answers as the server for `root`. */
export async function probe(info: ServerInfo, root: string, timeoutMs = 1000): Promise<boolean> {
  try {
    const res = await fetch(`${info.url}/api/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { root?: string };
    return body.root === root;
  } catch {
    return false;
  }
}
