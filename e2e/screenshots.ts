/**
 * Regenerates the README screenshots in docs/screenshots/, in light and dark themes.
 *
 *   npm run build && node e2e/screenshots.ts
 *
 * Builds a small demo repository, submits a review through the API, answers it as a listening
 * Claude session would, and captures the UI. Needs Playwright's Chromium, as the browser tests do.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import WebSocket from 'ws';
import { startServer } from '../src/server/server.ts';

const OUT = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
const SESSION = 'readme-demo';

const configBase = `export const config = {
  port: Number(process.env.PORT ?? 8080),
  baseUrl: process.env.BASE_URL ?? 'http://localhost:8080',
};
`;
const configNew = `export const config = {
  port: Number(process.env.PORT ?? 8080),
  baseUrl: process.env.BASE_URL ?? 'http://localhost:8080',
  /** New links each client may create per minute. */
  rateLimit: { capacity: 30, refillPerMinute: 30 },
};
`;

const serverBase = `import { createServer } from 'node:http';
import { config } from './config.ts';
import { resolve, shorten } from './links.ts';

export const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/links') {
    const { url } = JSON.parse(await body(req));
    const code = shorten(url);
    res.writeHead(201, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ code, link: \`\${config.baseUrl}/\${code}\` }));
  }
  const target = req.method === 'GET' ? resolve(req.url!.slice(1)) : undefined;
  if (!target) return res.writeHead(404).end();
  res.writeHead(302, { location: target }).end();
});

async function body(req: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
`;
const serverNew = serverBase
  .replace("import { resolve, shorten } from './links.ts';\n", "import { resolve, shorten } from './links.ts';\nimport { RateLimiter } from './rate-limit.ts';\n\nconst limiter = new RateLimiter(config.rateLimit);\n")
  .replace(
    "  if (req.method === 'POST' && req.url === '/links') {\n",
    "  if (req.method === 'POST' && req.url === '/links') {\n    const wait = limiter.take(req.socket.remoteAddress ?? 'unknown');\n    if (wait > 0) {\n      res.setHeader('Retry-After', wait / 1000);\n      return res.writeHead(429).end();\n    }\n",
  );

const rateLimit = `export interface RateLimitOptions {
  /** Most requests a client can make in a burst. */
  capacity: number;
  /** Tokens returned to each bucket per minute. */
  refillPerMinute: number;
}

interface Bucket {
  tokens: number;
  updated: number;
}

/** A token bucket per client. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly opts: RateLimitOptions, private readonly now = Date.now) {}

  /** Takes a token for \`client\`. Returns 0 when allowed, or the milliseconds until one is free. */
  take(client: string): number {
    const now = this.now();
    const bucket = this.buckets.get(client) ?? { tokens: this.opts.capacity, updated: now };
    const refill = ((now - bucket.updated) / 60_000) * this.opts.refillPerMinute;
    bucket.tokens = Math.min(this.opts.capacity, bucket.tokens + refill);
    bucket.updated = now;
    this.buckets.set(client, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return ((1 - bucket.tokens) / this.opts.refillPerMinute) * 60_000;
  }
}
`;

const rateLimitTest = `import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { RateLimiter } from '../src/rate-limit.ts';

it('allows a burst up to capacity, then asks the client to wait', () => {
  let now = 0;
  const limiter = new RateLimiter({ capacity: 2, refillPerMinute: 60 }, () => now);
  assert.equal(limiter.take('a'), 0);
  assert.equal(limiter.take('a'), 0);
  assert.equal(limiter.take('a'), 1000);
  now += 1000;
  assert.equal(limiter.take('a'), 0);
});

it('refills a quiet client to capacity and no further', () => {
  let now = 0;
  const limiter = new RateLimiter({ capacity: 2, refillPerMinute: 60 }, () => now);
  limiter.take('a');
  now += 60 * 60_000;
  assert.equal(limiter.take('a'), 0);
  assert.equal(limiter.take('a'), 0);
  assert.ok(limiter.take('a') > 0);
});
`;

const links = `const links = new Map<string, string>();

export function shorten(url: string): string {
  const code = Math.random().toString(36).slice(2, 8);
  links.set(code, new URL(url).href);
  return code;
}

export const resolve = (code: string): string | undefined => links.get(code);
`;

function makeRepo(): { dir: string; cleanup: () => void } {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'postil-shots-')));
  const dir = join(parent, 'shortlinks');
  mkdirSync(dir);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com',
    GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com',
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' });
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  git('init', '-q', '-b', 'main');
  write('README.md', '# shortlinks\n\nA tiny URL shortener.\n');
  write('src/config.ts', configBase);
  write('src/links.ts', links);
  write('src/server.ts', serverBase);
  git('add', '-A');
  git('commit', '-q', '-m', 'Initial version');
  git('switch', '-q', '-c', 'rate-limit');
  write('README.md', '# shortlinks\n\nA tiny URL shortener.\n\nEach client can create 30 links a minute. Past that, `POST /links` answers 429 with a\n`Retry-After` header.\n');
  write('src/config.ts', configNew);
  write('src/server.ts', serverNew);
  write('src/rate-limit.ts', rateLimit);
  write('test/rate-limit.test.ts', rateLimitTest);
  return { dir, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

const repo = makeRepo();
const server = await startServer({ cwd: repo.dir, port: 0, pollMs: 200 });
const api = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown, session?: string): Promise<T> => {
  const res = await fetch(`${server.info.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${server.info.token}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(session && { 'x-postil-session': session }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as T;
  if (!res.ok) throw new Error(`${method} ${path} failed: ${JSON.stringify(json)}`);
  return json;
};

// A listening Claude session: registered, with its doorbell socket open.
await api('POST', '/api/agent/listen', {}, SESSION);
const doorbell = new WebSocket(`ws://127.0.0.1:${server.info.port}/events?channel=agent&session=${SESSION}&token=${server.info.token}`, {
  headers: { origin: server.info.url },
});
await new Promise((resolve, reject) => doorbell.once('open', resolve).once('error', reject));

const scope = await api<{ from: { tree: string }; to: { tree: string } }>('POST', '/api/diff/resolve', { scope: { kind: 'all' } });
const thread = (path: string, start: number, end: number, body: string) =>
  api<{ id: string }>('POST', '/api/threads', { from_tree: scope.from.tree, to_tree: scope.to.tree, path, side: 'new', start_line: start, end_line: end, body });

const refill = await thread('src/rate-limit.ts', 23, 24,
  'A client that goes quiet for an hour gets its bucket back. Is it capped at `capacity`, or can it bank a huge burst?');
const retryAfter = await thread('src/server.ts', 12, 12,
  'This can send a fractional `Retry-After`, which clients may reject:\n```suggestion\n      res.setHeader(\'Retry-After\', Math.ceil(wait / 1000));\n```');
const limit = await thread('src/config.ts', 5, 5, 'Is 30 a minute enough for the bulk import script?');
await api('POST', '/api/reviews/submit', { body: 'Looks good overall. A few questions on the limiter.' });

// Claude handles the review.
const review = await api<{ id: number }>('GET', '/api/agent/reviews/1', undefined, SESSION);
await api('POST', `/api/agent/threads/${refill.id}/reply`, {
  body: 'Capped: `Math.min(capacity, …)` limits the refill to one full bucket. I added a test for a client that is quiet for an hour.',
}, SESSION);
const comments = (await api<{ comments: { id: string }[] }>('GET', `/api/threads/${retryAfter.id}`)).comments;
await api('POST', `/api/agent/comments/${comments[0]!.id}/apply`, undefined, SESSION);
await api('POST', `/api/agent/threads/${retryAfter.id}/reply`, { body: 'Applied, so `Retry-After` is now whole seconds.' }, SESSION);
await api('POST', `/api/agent/threads/${limit.id}/reply`, {
  body: 'The import script creates about 200 links a run, so it would be throttled. Raise the limit, or give the script its own higher limit?',
  needs_decision: true,
}, SESSION);
await api('POST', `/api/agent/reviews/${review.id}/complete`, { summary: 'Answered the refill question, applied the Retry-After fix, and asked about the import script.' }, SESSION);

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const theme of ['light', 'dark'] as const) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: theme });
    await page.goto(server.uiUrl);
    await page.locator('section.file').first().waitFor();
    if (theme === 'light') {
      // Marks are kept by the server, so both themes show these files viewed.
      for (const path of ['README.md', 'test/rate-limit.test.ts']) await fileSection(page, path).getByRole('checkbox', { name: 'Viewed' }).check();
    }
    await layout(page, 'Unified');
    await showFile(page, 'src/server.ts', 'whole seconds');
    await page.screenshot({ path: join(OUT, `review-${theme}.png`) });

    await layout(page, 'Split');
    await showFile(page, 'src/config.ts', 'import script');
    await page.screenshot({ path: join(OUT, `split-${theme}.png`) });
    await page.close();
  }
} finally {
  await browser.close();
  doorbell.close();
  await server.close();
  repo.cleanup();
}
console.log(`Screenshots written to ${OUT}`);

async function layout(page: Page, name: 'Unified' | 'Split'): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click();
}

/** Scrolls a file's header to the top of the diff pane, once the given reply has rendered. */
async function showFile(page: Page, path: string, text: string): Promise<void> {
  const file = fileSection(page, path);
  await file.locator('.thread', { hasText: text }).waitFor();
  await file.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(500); // let highlighting and layout settle
}

function fileSection(page: Page, path: string) {
  return page.locator(`[id="file-${encodeURIComponent(path).replace(/%/g, '_')}"]`);
}
