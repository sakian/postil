#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ApiError, NotRunningError, PostilClient } from '../core/client.ts';
import { AlreadyRunningError } from '../core/discovery.ts';
import type { BaseInfo, ReviewView } from '../core/postil.ts';
import { Postil } from '../core/postil.ts';
import { VERSION } from '../core/version.ts';
import { startServer } from '../server/server.ts';

const USAGE = `postil ${VERSION} — local code review for Claude Code diffs

Usage: postil [-C <dir>] <command> [options]

Commands:
  serve [--port <n>]       Run the review server for this repository (foreground)
  status                   Show the running server, base, and reviews
  url [--agent]            Print the browser URL, or Claude's event feed URL
  base [<rev> | --reset]   Show the base that "all changes" is measured from, or change it
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
      return serve(cwd, values.port);
    case 'status':
      return status(cwd);
    case 'url': {
      const client = await PostilClient.connect(cwd);
      console.log(values.agent ? client.agentEventsUrl : client.uiUrl);
      return 0;
    }
    case 'base':
      return base(cwd, rest[0], values.reset ?? false);
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

async function serve(cwd: string, portArg: string | undefined): Promise<number> {
  let port: number | undefined;
  if (portArg !== undefined) {
    port = Number(portArg);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`invalid port: ${portArg}`);
  }
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

function describeReview(r: ReviewView): string {
  const threads = `${r.thread_ids.length} thread${r.thread_ids.length === 1 ? '' : 's'}`;
  return `#${r.id} ${r.status.replace('_', ' ')} (${threads})`;
}

async function status(cwd: string): Promise<number> {
  const client = await PostilClient.connect(cwd);
  const [base, { reviews }, { draft }] = await Promise.all([
    client.request<BaseInfo>('GET', '/api/base'),
    client.request<{ reviews: ReviewView[] }>('GET', '/api/reviews'),
    client.request<{ draft: ReviewView | null }>('GET', '/api/reviews/draft'),
  ]);
  const active = reviews.filter((r) => r.status === 'submitted' || r.status === 'in_progress');
  console.log(`postil ${client.info.version} serving ${client.info.root} (pid ${client.info.pid})`);
  console.log(`  UI:       ${client.uiUrl}`);
  console.log(`  base:     ${base.label}${base.warning ? ` (warning: ${base.warning})` : ''}`);
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
