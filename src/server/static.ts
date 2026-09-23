import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { Context } from 'hono';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.map': 'application/json',
};

/**
 * The page may only load its own scripts and talk to this server. Markdown from comments is
 * rendered without raw HTML, and this policy is the second line of defence if that ever slips.
 */
export function contentSecurityPolicy(host: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self' ws://${host}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>postil</title>
<body style="font:14px system-ui;margin:2rem;max-width:40rem">
<h1>postil</h1><p>The server is running, but the browser UI has not been built.</p>
<p>Run <code>npm run build</code> in the postil checkout, then reload.</p></body>`;

export function createStatic(webRoot: string) {
  const assetsDir = join(webRoot, 'assets');

  return {
    async index(c: Context): Promise<Response> {
      let html: string;
      try {
        html = await readFile(join(webRoot, 'index.html'), 'utf8');
      } catch {
        html = PLACEHOLDER;
      }
      c.header('content-security-policy', contentSecurityPolicy(c.req.header('host') ?? ''));
      c.header('referrer-policy', 'no-referrer');
      return c.html(html);
    },

    /** Hashed build assets. Anything that normalises outside the assets directory is refused. */
    async asset(c: Context): Promise<Response> {
      const rel = normalize(decodeURIComponent(c.req.path.slice('/assets/'.length)));
      const file = join(assetsDir, rel);
      if (rel.startsWith('..') || !file.startsWith(assetsDir + sep)) return c.notFound();
      let body: Buffer;
      try {
        body = await readFile(file);
      } catch {
        return c.notFound();
      }
      c.header('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
      // File names carry a content hash, so they never change.
      c.header('cache-control', 'public, max-age=31536000, immutable');
      return c.body(new Uint8Array(body));
    },
  };
}
