#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ApiError, NotRunningError, PostilClient } from '../core/client.ts';
import { AlreadyRunningError } from '../core/discovery.ts';
import type { BaseInfo, ReviewView } from '../core/postil.ts';
import { VERSION } from '../core/version.ts';


const USAGE = `postil ${VERSION} — local code review for Claude Code diffs

Usage: postil [-C <dir>] <command> [options]

Commands:
  start [--port <n>]       Start the review server in the background (or report the running one)
  stop                     Stop the background server
  wait [--timeout <s>]     Block until the server is running, then print one line (default 1800s)
  serve [--port <n>]       Run the review server in the foreground
  status                   Show the running server, base, and reviews
  open                     Open the review UI in your browser
  url [--agent]            Print the browser URL, or Claude's event feed URL
  base [<rev> | --reset]   Show the base that "all changes" is measured from, or change it
  archive                  Archive resolved conversations and finished reviews, and release their snapshots
  link [--dir <d>] [--force]
                           Put \`postil\` on your PATH (default ~/.local/bin) for the Claude Code plugin
  mcp                      Run the MCP server the Claude Code plugin uses (stdio)
  hook <event>             Handle a Claude Code hook event (session-start, prompt, stop)
  help                     Show this help

Options:
  -C <dir>                 Run as if started in <dir>
  -v, --version            Print the version
`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      C: { type: 'string', short: 'C' },
      port: { type: 'string' },
      agent: { type: 'boolean' },
      reset: { type: 'boolean' },
      dir: { type: 'string' },
      timeout: { type: 'string' },
      force: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const cwd = resolve(values.C ?? process.cwd());
  const [command = 'help', ...rest] = positionals;

  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  if (values.help || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (command) {
    case 'serve':
      return serve(cwd, parsePort(values.port));
    case 'start': {
      const { startDaemon } = await import('./daemon.ts');
      const { client, started } = await startDaemon(cwd, parsePort(values.port));
      console.log(`postil ${started ? 'started' : 'is already running'} for ${client.info.root}`);
      console.log(`  UI: ${client.uiUrl}`);
      return 0;
    }
    case 'stop': {
      const { stopDaemon } = await import('./daemon.ts');
      console.log((await stopDaemon(cwd)) ? 'postil stopped' : 'postil is not running here');
      return 0;
    }
    case 'wait': {
      // For Claude's Monitor after the server went away: one line when it is back, then exit.
      const seconds = values.timeout === undefined ? 1800 : Number(values.timeout);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError(`invalid timeout: ${values.timeout}`);
      const deadline = Date.now() + seconds * 1000;
      for (;;) {
        try {
          const client = await PostilClient.connect(cwd, { probeTimeoutMs: 800 });
          console.log(`postil server is running again for ${client.info.root}: call the postil connect tool and re-arm the monitor`);
          return 0;
        } catch (e) {
          if (!(e instanceof NotRunningError)) throw e;
        }
        if (Date.now() >= deadline) {
          console.log(`postil server did not come back within ${seconds}s; stop listening and tell the user`);
          return 1;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    case 'link': {
      const { linkBinary } = await import('./daemon.ts');
      const { path, onPath } = await linkBinary(values.dir, values.force ?? false);
      console.log(`linked ${path}`);
      if (!onPath) console.log(`note: ${path.replace(/\/postil$/, '')} is not on your PATH; add it so Claude Code can find postil`);
      return 0;
    }
    case 'mcp':
      await (await import('./mcp.ts')).runMcpServer();
      return 0;
    case 'hook':
      return (await import('./hooks.ts')).runHook(rest[0] ?? '');
    case 'status':
      return status(cwd);
    case 'open':
      return openUi(cwd);
    case 'url': {
      const client = await PostilClient.connect(cwd, { session: process.env.CLAUDE_CODE_SESSION_ID });
      console.log(values.agent ? client.agentEventsUrl : client.uiUrl);
      return 0;
    }
    case 'base':
      return base(cwd, rest[0], values.reset ?? false);
    case 'archive': {
      const client = await PostilClient.connect(cwd);
      const r = await client.request<{ threads: number; reviews: number; unpinned: number }>('POST', '/api/archive');
      console.log(`archived ${r.threads} conversation(s) and ${r.reviews} review(s); released ${r.unpinned} snapshot(s)`);
      return 0;
    }
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

function parsePort(arg: string | undefined): number | undefined {
  if (arg === undefined) return undefined;
  const port = Number(arg);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`invalid port: ${arg}`);
  return port;
}

async function serve(cwd: string, port: number | undefined): Promise<number> {
  const { startServer } = await import('../server/server.ts');
  const server = await startServer({ cwd, ...(port !== undefined && { port }) });
  console.log(`postil ${VERSION} serving ${server.info.root}`);
  console.log(`  UI:     ${server.uiUrl}`);
  console.log(`  Claude: ${server.agentEventsUrl}`);
  console.log('Press Ctrl+C to stop.');

  await new Promise<void>((done) => {
    const stop = (signal: string) => {
      console.log(`\npostil: ${signal} received, shutting down`);
      server.close().then(done, (e: unknown) => {
        console.error('postil: shutdown failed:', e);
        done();
      });
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });
  return 0;
}

async function openUi(cwd: string): Promise<number> {
  const client = await PostilClient.connect(cwd);
  const url = client.uiUrl;
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  const opened = await new Promise<boolean>((done) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.once('error', () => done(false));
    child.once('spawn', () => {
      child.unref();
      done(true);
    });
  });
  if (!opened) console.log(`Could not launch a browser. Open this URL:\n${url}`);
  return 0;
}

function describeReview(r: ReviewView): string {
  const threads = `${r.thread_ids.length} thread${r.thread_ids.length === 1 ? '' : 's'}`;
  return `#${r.id} ${r.status.replace('_', ' ')} (${threads})`;
}

async function status(cwd: string): Promise<number> {
  const client = await PostilClient.connect(cwd);
  const [health, base, { reviews }, { draft }] = await Promise.all([
    client.request<{ listening: number }>('GET', '/api/health'),
    client.request<BaseInfo>('GET', '/api/base'),
    client.request<{ reviews: ReviewView[] }>('GET', '/api/reviews'),
    client.request<{ draft: ReviewView | null }>('GET', '/api/reviews/draft'),
  ]);
  const active = reviews.filter((r) => r.status === 'submitted' || r.status === 'in_progress');
  console.log(`postil ${client.info.version} serving ${client.info.root} (pid ${client.info.pid})`);
  console.log(`  UI:       ${client.uiUrl}`);
  console.log(`  base:     ${base.label}${base.warning ? ` (warning: ${base.warning})` : ''}`);
  console.log(`  Claude:   ${health.listening ? `listening (${health.listening} session${health.listening === 1 ? '' : 's'})` : 'not listening; run /postil:review in Claude Code'}`);
  console.log(`  waiting:  ${active.length ? active.map(describeReview).join(', ') : 'none'}`);
  console.log(`  draft:    ${draft ? `${draft.comment_count} comment(s), not submitted` : 'none'}`);
  return 0;
}

async function base(cwd: string, rev: string | undefined, reset: boolean): Promise<number> {
  if (rev && reset) throw new UsageError('give a revision or --reset, not both');
  let info: BaseInfo;
  try {
    const client = await PostilClient.connect(cwd);
    info = reset
      ? await client.request<BaseInfo>('POST', '/api/base/reset')
      : rev
        ? await client.request<BaseInfo>('PUT', '/api/base', { rev })
        : await client.request<BaseInfo>('GET', '/api/base');
  } catch (e) {
    if (!(e instanceof NotRunningError)) throw e;
    const { Postil } = await import('../core/postil.ts');
    const postil = await Postil.open(cwd);
    try {
      info = reset ? await postil.resetBase() : rev ? await postil.setBase(rev) : await postil.base();
    } finally {
      postil.close();
    }
  }
  console.log(`base: ${info.label}${info.warning ? ` (warning: ${info.warning})` : ''}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof UsageError) {
      console.error(`postil: ${e.message}\n`);
      process.stderr.write(USAGE);
      process.exit(2);
    }
    if (e instanceof NotRunningError || e instanceof AlreadyRunningError || e instanceof ApiError) {
      console.error(`postil: ${e.message}`);
      process.exit(1);
    }
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      console.error(`postil: ${e.message}\n`);
      process.stderr.write(USAGE);
      process.exit(2);
    }
    console.error('postil:', e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
