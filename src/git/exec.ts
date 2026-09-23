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

export function git(cwd: string, args: readonly string[], opts: GitRunOptions = {}): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...baseEnv(), ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
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
