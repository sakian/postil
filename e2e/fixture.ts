import { makeFixture, type Fixture } from '../test/helpers.ts';

const retryBase = `import { sleep } from './time.ts';

export interface RetryOptions {
  attempts: number;
  onError?: (err: unknown, attempt: number) => void;
}

/**
 * Run \`fn\` until it succeeds or the attempts run out.
 */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      opts.onError?.(err, attempt);
      await sleep(100);
    }
  }
  throw lastError;
}

${Array.from({ length: 30 }, (_, i) => `export const LIMIT_${i + 1} = ${(i + 1) * 10};`).join('\n')}

export function describe(opts: RetryOptions): string {
  return \`retry up to \${opts.attempts} times\`;
}
`;

const retryNew = retryBase
  .replace('  attempts: number;\n', '  attempts: number;\n  /** Base delay in milliseconds; doubles after each failure. */\n  baseDelayMs?: number;\n')
  .replace('      await sleep(100);\n', '      const delay = (opts.baseDelayMs ?? 100) * 2 ** (attempt - 1);\n      await sleep(delay + Math.random() * delay);\n')
  .replace('  return `retry up to ${opts.attempts} times`;', '  const base = opts.baseDelayMs ?? 100;\n  return `retry up to ${opts.attempts} times with ${base}ms exponential backoff`;');

const dbBase = `import { open, type Connection } from './driver.ts';

export async function query(sql: string): Promise<unknown[]> {
  const conn: Connection = await open(process.env.DATABASE_URL!);
  return conn.all(sql);
}
`;
const dbNew = `import { open, type Connection } from './driver.ts';

export async function query(sql: string, params: unknown[] = []): Promise<unknown[]> {
  const conn: Connection = await open(process.env.DATABASE_URL!);
  try {
    return await conn.all(sql, params);
  } finally {
    await conn.close();
  }
}
`;

/** A small repository with Claude-style changes of every kind, for UI tests and demos. */
export function makeDemoRepo(): Fixture {
  const fx = makeFixture();
  fx.write('src/retry.ts', retryBase);
  fx.write('src/db.ts', dbBase);
  fx.write('src/legacy/cache.ts', 'export const cache = new Map();\n');
  fx.write('src/util/strings.ts', 'export const trim = (s: string) => s.trim();\nexport const upper = (s: string) => s.toUpperCase();\n');
  fx.write('README.md', '# demo\n');
  fx.commit('base');

  fx.write('src/retry.ts', retryNew);
  fx.write('src/db.ts', dbNew);
  fx.remove('src/legacy/cache.ts');
  fx.remove('src/util/strings.ts');
  fx.write('src/text/strings.ts', 'export const trim = (s: string) => s.trim();\nexport const upper = (s: string) => s.toUpperCase();\nexport const lower = (s: string) => s.toLowerCase();\n');
  fx.write('src/time.ts', 'export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));\n');
  fx.write('README.md', '# demo\n\nRetries now back off exponentially.\n');
  return fx;
}
