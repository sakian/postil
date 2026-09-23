/**
 * Helpers for the live tests, which run a real Claude Code session with the postil plugin.
 * They cost money and depend on the model, so they are run by hand, not by `npm test`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedDiff, ReviewView, ThreadView } from '../../src/core/api-types.ts';
import { PostilClient } from '../../src/core/client.ts';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PLUGIN = join(ROOT, 'plugin');

/** A PATH with `postil` on it, without touching the user's own bin directories. Removed at exit. */
export function pathWithPostil(): string {
  const bin = mkdtempSync(join(tmpdir(), 'postil-live-bin-'));
  symlinkSync(join(ROOT, 'src/cli/main.ts'), join(bin, 'postil'));
  process.on('exit', () => rmSync(bin, { recursive: true, force: true }));
  return `${bin}:${process.env.PATH}`;
}

/** Environment for a child Claude session: ours minus anything that ties it to this session. */
export function childEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE' && k !== 'CLAUDE_PID') env[k] = v;
  }
  return { ...env, PATH: path };
}

export function postil(cwd: string, path: string, ...args: string[]): string {
  return execFileSync('postil', args, { cwd, env: { ...process.env, PATH: path }, encoding: 'utf8' });
}

export async function api<T>(cwd: string, method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  return (await PostilClient.connect(cwd)).request<T>(method, route, body);
}

/** Submit a review with comments on new-side lines, found by their text. */
export async function submitReview(cwd: string, body: string, comments: Array<{ path: string; line: string; text: string }>): Promise<number> {
  const diff = await api<ResolvedDiff>(cwd, 'POST', '/api/diff/resolve', { scope: { kind: 'all' } });
  for (const c of comments) {
    const content = execFileSync('cat', [join(cwd, c.path)], { encoding: 'utf8' }).split('\n');
    const index = content.findIndex((l) => l.includes(c.line));
    if (index < 0) throw new Error(`no line containing ${JSON.stringify(c.line)} in ${c.path}`);
    await api<ThreadView>(cwd, 'POST', '/api/threads', {
      from_tree: diff.from.tree, to_tree: diff.to.tree, path: c.path, side: 'new', start_line: index + 1, body: c.text,
    });
  }
  return (await api<ReviewView>(cwd, 'POST', '/api/reviews/submit', { body })).id;
}

export async function waitFor<T>(what: string, timeoutMs: number, check: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await check().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
}

/** Resolves once the review is addressed. */
export function reviewAddressed(cwd: string, id: number, timeoutMs: number): Promise<ReviewView> {
  return waitFor(`review #${id} to be addressed`, timeoutMs, async () => {
    const r = await api<ReviewView>(cwd, 'GET', `/api/reviews/${id}`);
    return r.status === 'addressed' ? r : null;
  });
}

/** Tools the session may use without asking, so a headless run never stalls on a prompt. */
export const ALLOWED_TOOLS = [
  'mcp__plugin_postil_postil__connect', 'mcp__plugin_postil_postil__list_pending', 'mcp__plugin_postil_postil__get_review',
  'mcp__plugin_postil_postil__get_thread', 'mcp__plugin_postil_postil__reply', 'mcp__plugin_postil_postil__complete_review',
  'mcp__plugin_postil_postil__apply_suggestion',
  'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Monitor', 'Skill', 'Bash(postil:*)', 'Bash(postil wait)', 'Bash(git diff:*)', 'Bash(git status:*)',
];

export interface Session {
  events: Array<Record<string, unknown>>;
  /** Stop the session. A listening session never exits on its own: its armed monitor keeps it alive. */
  stop(): Promise<number>;
  exited: Promise<number>;
}

export function startHeadless(cwd: string, path: string, prompt: string, extra: string[] = []): Session {
  const child = spawn(
    'claude',
    ['-p', prompt, '--plugin-dir', PLUGIN, '--output-format', 'stream-json', '--verbose', '--include-hook-events',
      '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--allowedTools', ALLOWED_TOOLS.join(','),
      '--max-budget-usd', '3', '--no-session-persistence', ...extra],
    { cwd, env: childEnv(path), stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const events: Array<Record<string, unknown>> = [];
  let buf = '';
  child.stdout.on('data', (c: Buffer) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch { /* not JSON */ }
    }
  });
  const exited = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)));
  return {
    events,
    exited,
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM');
      return exited;
    },
  };
}

/** Tool calls in a stream-json transcript, in order. */
export function toolCalls(events: Array<Record<string, unknown>>): Array<{ name: string; input: Record<string, unknown> }> {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    const content = ((e.message as { content?: unknown[] })?.content ?? []) as Array<Record<string, unknown>>;
    for (const c of content) if (c.type === 'tool_use') calls.push({ name: String(c.name), input: (c.input ?? {}) as Record<string, unknown> });
  }
  return calls;
}
