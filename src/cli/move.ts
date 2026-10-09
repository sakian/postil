import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { exportSession, type ExportResult } from '../core/transfer.ts';

/**
 * `postil move host[:path]`: export, copy the file over SSH, and import it in the clone there, so
 * moving to another computer is one command. The other computer needs `postil` linked
 * (`postil link`) and a POSIX shell.
 */

export interface MoveOptions {
  claudeSession?: string | null;
  /** Passed to the import there. */
  worktree?: boolean;
  force?: boolean;
  /** Let ssh ask for passwords and host keys. Off when nobody is at a terminal, as for the MCP tool. */
  interactive: boolean;
  /** Where the other computer's output goes; inherited from this process when absent. */
  output?: (chunk: string) => void;
}

export interface MoveResult {
  host: string;
  path: string;
  exported: ExportResult;
}

/** The clone's path on the other computer: as given, or the same place relative to the home directory. */
export function remotePath(spec: string | undefined, localRoot: string): string {
  if (spec) return spec;
  const rel = relative(homedir(), localRoot);
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return `~/${rel.split(sep).join('/')}`;
  return localRoot.split(sep).join('/');
}

export function parseTarget(target: string, localRoot: string): { host: string; path: string } {
  const colon = target.indexOf(':');
  const host = colon === -1 ? target : target.slice(0, colon);
  if (!/^[\w.@%+-]+$/.test(host) || host.startsWith('-')) throw new Error(`not an SSH host: ${JSON.stringify(host)}`);
  return { host, path: remotePath(colon === -1 ? undefined : target.slice(colon + 1) || undefined, localRoot) };
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const homePath = (p: string) => (p === '~' ? '"$HOME"' : p.startsWith('~/') ? `"$HOME"/${q(p.slice(2))}` : q(p));

/** The script the other computer runs. ~/.local/bin is where `postil link` puts postil. */
export function importScript(path: string, file: string, opts: { worktree?: boolean; force?: boolean }): string {
  const args = [...(opts.worktree === false ? ['--no-worktree'] : []), ...(opts.force ? ['--force'] : [])];
  return [
    'set -e',
    'PATH="$HOME/.local/bin:$PATH"',
    'command -v postil >/dev/null || { echo "postil is not installed here: run postil link in its checkout" >&2; exit 127; }',
    `cd ${homePath(path)}`,
    `postil import --no-resume ${args.join(' ')} "$HOME"/${q(file)}`,
    `rm -f "$HOME"/${q(file)}`,
    '',
  ].join('\n');
}

function run(cmd: string, args: string[], opts: { input?: string; output?: (chunk: string) => void }): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: [opts.input === undefined ? 'inherit' : 'pipe', opts.output ? 'pipe' : 'inherit', opts.output ? 'pipe' : 'inherit'],
      windowsHide: true,
    });
    child.once('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' ? new Error(`${cmd} was not found; postil move needs OpenSSH`) : e));
    if (opts.output) {
      child.stdout?.on('data', (c: Buffer) => opts.output!(c.toString()));
      child.stderr?.on('data', (c: Buffer) => opts.output!(c.toString()));
    }
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

export async function moveSession(cwd: string, target: string, opts: MoveOptions): Promise<MoveResult> {
  const exported = await exportSession(cwd, {
    file: join(tmpdir(), `postil-move-${process.pid}-${Date.now()}.bundle`),
    ...(opts.claudeSession !== undefined && { claudeSession: opts.claudeSession }),
  });
  try {
    const { host, path } = parseTarget(target, exported.manifest.root);
    const ssh = opts.interactive ? [] : ['-o', 'BatchMode=yes'];
    const name = basename(exported.file);
    const out = opts.output ? { output: opts.output } : {};
    if ((await run('scp', ['-q', ...ssh, exported.file, `${host}:${name}`], out)) !== 0) {
      throw new Error(`could not copy the session to ${host}`);
    }
    const code = await run('ssh', [...ssh, host, 'sh', '-s'], { ...out, input: importScript(path, name, opts) });
    if (code !== 0) throw new Error(`the import on ${host} failed (exit ${code}); the file is left there as ~/${name}`);
    return { host, path, exported };
  } finally {
    await rm(exported.file, { force: true });
  }
}
