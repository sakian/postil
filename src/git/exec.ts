import { spawn } from 'node:child_process';

export class GitError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number | null, stderr: string) {
    super(`git ${args.join(' ')} failed (exit ${exitCode}): ${stderr.trim()}`);
    this.name = 'GitError';
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface GitRunOptions {
  /** Extra environment, applied on top of the sanitised base environment. */
  env?: Record<string, string>;
  /** Data written to stdin. */
  input?: string | Buffer;
  /** Exit codes treated as success, in addition to 0. */
  okCodes?: readonly number[];
  /** Abort if stdout exceeds this many bytes. */
  maxBytes?: number;
}

/**
 * Variables that would redirect git away from the repository we pass as cwd.
 * They can be inherited when postil runs inside a git hook or a Claude Code hook,
 * and would silently make every command operate on the wrong index or repo.
 */
const REDIRECTING_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX',
];

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !REDIRECTING_VARS.includes(k)) env[k] = v;
  }
  return {
    ...env,
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    // Never take optional locks on the user's real index (e.g. from status refreshes).
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  };
}

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * At most this many git processes run at once. Anchoring every thread in a large review, or many
 * diff requests at once, would otherwise start hundreds and exhaust process or file limits.
 */
const MAX_CONCURRENT_GIT = 16;
let running = 0;
const queued: Array<() => void> = [];

function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT_GIT) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queued.push(resolve));
}

/** A finished process hands its slot straight to the next waiter, so the limit is never exceeded. */
function release(): void {
  const next = queued.shift();
  if (next) next();
  else running--;
}

/** Current load, for tests. */
export function gitLoad(): { running: number; queued: number; limit: number } {
  return { running, queued: queued.length, limit: MAX_CONCURRENT_GIT };
}

export async function git(cwd: string, args: readonly string[], opts: GitRunOptions = {}): Promise<Buffer> {
  await acquire();
  try {
    return await runGit(cwd, args, opts);
  } finally {
    release();
  }
}

/** git processes still running, so a shutdown can wait for them. */
const inFlight = new Set<Promise<unknown>>();

/**
 * Resolves once no git process started here is still running, or after `timeoutMs`. On Windows a
 * directory cannot be deleted while a process has it as its working directory.
 */
export async function gitIdle(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (inFlight.size > 0 && Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...inFlight]), new Promise((r) => { timer = setTimeout(r, deadline - Date.now()); })]);
    clearTimeout(timer);
  }
}

function runGit(cwd: string, args: readonly string[], opts: GitRunOptions): Promise<Buffer> {
  const run = spawnGit(cwd, args, opts);
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run)).catch(() => undefined);
  return run;
}

function spawnGit(cwd: string, args: readonly string[], opts: GitRunOptions): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...baseEnv(), ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // The server has no console on Windows, so without this every git call flashes a window.
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let aborted = false;

    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxBytes) {
        aborted = true;
        child.kill('SIGKILL');
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const stderr = Buffer.concat(err).toString('utf8');
      if (aborted) {
        reject(new GitError(args, code, `output exceeded ${maxBytes} bytes`));
      } else if (code === 0 || (code !== null && opts.okCodes?.includes(code))) {
        resolve(Buffer.concat(out));
      } else {
        reject(new GitError(args, code, stderr));
      }
    });

    child.stdin.on('error', () => { /* child exited before reading stdin; close handler reports it */ });
    child.stdin.end(opts.input ?? '');
  });
}

export async function gitText(cwd: string, args: readonly string[], opts: GitRunOptions = {}): Promise<string> {
  return (await git(cwd, args, opts)).toString('utf8');
}

/** Run git and return trimmed stdout, or null when it exits with one of `okCodes`' non-zero codes and prints nothing. */
export async function gitLine(cwd: string, args: readonly string[], opts: GitRunOptions = {}): Promise<string | null> {
  const text = (await gitText(cwd, args, opts)).trim();
  return text === '' ? null : text;
}
