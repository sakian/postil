import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z, ZodError } from 'zod';
import type { Postil } from '../core/postil.ts';
import { HttpError } from '../core/util.ts';
import { VERSION } from '../core/version.ts';
import { GitError } from '../git/exec.ts';
import { createStatic } from './static.ts';

export interface AppOptions {
  token: string;
  /** Directory holding the built UI (index.html and assets/). */
  webRoot: string;
  /** Host header values this server answers to. Anything else is a DNS-rebinding attempt. */
  allowedHosts: () => readonly string[];
}

export function tokenMatches(candidate: string | null | undefined, token: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearer(header: string | undefined): string | null {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------- request schemas

const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'expected a full object id');
const side = z.enum(['old', 'new']);
const line = z.number().int().min(1);
const id = z.coerce.number().int().min(1);

const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('uncommitted') }),
  z.object({ kind: z.literal('since_review'), review_id: z.number().int().min(1).optional() }),
  z.object({ kind: z.literal('commits'), from: z.string().min(1), to: z.string().min(1) }),
  z.object({ kind: z.literal('trees'), from: oid, to: oid }),
]);

const schemas = {
  setBase: z.object({ rev: z.string().min(1).nullable() }),
  resolve: z.object({ scope: scopeSchema }),
  files: z.object({ from: oid, to: oid }),
  fileDiff: z.object({
    old: oid.optional(),
    new: oid.optional(),
    context: z.coerce.number().int().min(0).max(1000).optional(),
    ignore_ws: z.enum(['0', '1']).optional(),
    force: z.enum(['0', '1']).optional(),
  }),
  lines: z.object({ start: z.coerce.number().int(), end: z.coerce.number().int() }),
  threadFilter: z.object({
    status: z.enum(['open', 'resolved']).optional(),
    path: z.string().optional(),
    from: oid.optional(),
    to: oid.optional(),
  }),
  newThread: z.object({
    from_tree: oid, to_tree: oid, path: z.string().min(1), side,
    start_line: line.nullable().optional(), end_line: line.nullable().optional(), body: z.string(),
  }),
  body: z.object({ body: z.string() }),
  optionalBody: z.object({ body: z.string().optional() }),
  agentReply: z.object({ body: z.string(), needs_decision: z.boolean().optional() }),
  complete: z.object({ summary: z.string() }),
  fileMark: z.object({ path: z.string().min(1), blob: oid, viewed: z.boolean() }),
  sectionMark: z.object({
    path: z.string().min(1), from_blob: oid.nullable(), to_blob: oid.nullable(), side, start_line: line, end_line: line,
  }),
  sectionFilter: z.object({ path: z.string().optional(), from: oid.optional(), to: oid.optional() }),
};

async function json<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'request body must be JSON', 'invalid_json');
  }
  return schema.parse(raw);
}

function query<T extends z.ZodType>(c: Context, schema: T): z.infer<T> {
  return schema.parse(c.req.query());
}

/** The Claude Code session making an agent call, from the MCP proxy's header. */
function session(c: Context): string | undefined {
  return c.req.header('x-postil-session') || undefined;
}

function param(c: Context, name: string): number {
  return id.parse(c.req.param(name));
}

const MAX_RAW_BYTES = 20 * 1024 * 1024;

/** Types served for previews. Anything else is served as an opaque download type. */
const RAW_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
};

// ---------------------------------------------------------------------------- app

export function createApp(postil: Postil, opts: AppOptions): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!opts.allowedHosts().includes(host)) {
      return c.json({ error: { code: 'bad_host', message: 'unrecognised Host header' } }, 403);
    }
    await next();
    if (!c.res.headers.has('cache-control')) c.header('cache-control', 'no-store');
    c.header('x-content-type-options', 'nosniff');
  });

  app.use('/api/*', async (c, next) => {
    const presented = bearer(c.req.header('authorization')) ?? c.req.query('token');
    if (!tokenMatches(presented, opts.token)) {
      return c.json({ error: { code: 'unauthorized', message: 'missing or invalid token' } }, 401);
    }
    await next();
  });

  app.use('/api/*', bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json({ error: { code: 'body_too_large', message: 'request body exceeds 1 MiB' } }, 413),
  }));

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
    }
    if (err instanceof ZodError) {
      return c.json({ error: { code: 'invalid_request', message: 'request failed validation', details: err.issues } }, 400);
    }
    if (err instanceof GitError) {
      return c.json({ error: { code: 'git_error', message: err.stderr.trim() || err.message } }, 422);
    }
    console.error('postil: unhandled error', err);
    return c.json({ error: { code: 'internal', message: 'internal server error' } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: `no route for ${c.req.method} ${c.req.path}` } }, 404));

  const files = createStatic(opts.webRoot);
  app.get('/', (c) => files.index(c));
  app.get('/assets/*', (c) => files.asset(c));

  // -------------------------------------------------------------- meta & base
  app.get('/api/health', (c) =>
    c.json({ ok: true, service: 'postil', version: VERSION, root: postil.repo.root, pid: process.pid, listening: postil.listeningCount() }),
  );
  app.get('/api/base', async (c) => c.json(await postil.base()));
  app.put('/api/base', async (c) => c.json(await postil.setBase((await json(c, schemas.setBase)).rev)));
  app.post('/api/base/reset', async (c) => c.json(await postil.resetBase()));
  app.get('/api/commits', async (c) => c.json(await postil.commits()));

  // -------------------------------------------------------------- diffs
  app.post('/api/diff/resolve', async (c) => {
    const resolved = await postil.resolveScope((await json(c, schemas.resolve)).scope);
    const [files, sinceReview] = await Promise.all([postil.files(resolved.from.tree, resolved.to.tree), postil.sinceReview(resolved.to.tree)]);
    return c.json({ ...resolved, files, since_review: sinceReview });
  });
  app.get('/api/diff/files', async (c) => {
    const q = query(c, schemas.files);
    return c.json({ files: await postil.files(q.from, q.to) });
  });
  app.get('/api/diff/file', async (c) => {
    const q = query(c, schemas.fileDiff);
    if (!q.old && !q.new) throw new HttpError(400, 'give at least one of old and new', 'invalid_request');
    return c.json(
      await postil.fileDiff(q.old ?? null, q.new ?? null, {
        ...(q.context !== undefined && { context: q.context }),
        ignoreWhitespace: q.ignore_ws === '1',
        force: q.force === '1',
      }),
    );
  });
  app.get('/api/blobs/:oid/raw', async (c) => {
    const blob = oid.parse(c.req.param('oid'));
    if ((await postil.repo.blobSize(blob)) > MAX_RAW_BYTES) throw new HttpError(413, 'blob too large to preview', 'too_large');
    const ext = (c.req.query('path') ?? '').split('.').pop()?.toLowerCase() ?? '';
    const body = await postil.repo.readBlob(blob);
    c.header('content-type', RAW_TYPES[ext] ?? 'application/octet-stream');
    // Opened directly, an SVG could run script on this origin; the sandbox stops that.
    c.header('content-security-policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    c.header('cache-control', 'private, max-age=31536000, immutable'); // blob ids are content addresses
    return c.body(new Uint8Array(body));
  });
  app.get('/api/blobs/:oid/lines', async (c) => {
    const q = query(c, schemas.lines);
    return c.json(await postil.lines(oid.parse(c.req.param('oid')), q.start, q.end));
  });

  // -------------------------------------------------------------- threads & comments
  app.get('/api/threads', async (c) => {
    const { from, to, ...filter } = query(c, schemas.threadFilter);
    if ((from === undefined) !== (to === undefined)) throw new HttpError(400, 'give both from and to, or neither', 'invalid_request');
    const threads = from && to ? await postil.threadsIn({ from_tree: from, to_tree: to }, filter) : postil.threads(filter);
    return c.json({ threads });
  });
  app.get('/api/threads/:id', (c) => c.json(postil.thread(param(c, 'id'))));
  app.post('/api/threads', async (c) => c.json(await postil.createThread(await json(c, schemas.newThread)), 201));
  app.post('/api/threads/:id/replies', async (c) => c.json(postil.replyAsUser(param(c, 'id'), (await json(c, schemas.body)).body), 201));
  app.post('/api/threads/:id/resolve', (c) => c.json(postil.resolveThread(param(c, 'id'))));
  app.post('/api/threads/:id/unresolve', async (c) => c.json(await postil.unresolveThread(param(c, 'id'))));
  app.patch('/api/comments/:id', async (c) => c.json(postil.editDraft(param(c, 'id'), (await json(c, schemas.body)).body)));
  app.delete('/api/comments/:id', (c) => c.json(postil.deleteDraft(param(c, 'id'))));
  app.post('/api/comments/:id/apply', async (c) => c.json(await postil.applySuggestion(param(c, 'id'))));

  // -------------------------------------------------------------- reviews
  app.get('/api/reviews', (c) => c.json({ reviews: postil.reviews() }));
  app.post('/api/archive', async (c) => c.json(await postil.archiveResolved()));
  app.get('/api/archive/threads', (c) => c.json({ threads: postil.archivedThreads() }));
  app.post('/api/prune', async (c) => c.json(await postil.prune()));
  app.get('/api/reviews/draft', (c) => c.json({ draft: postil.draft() }));
  app.put('/api/reviews/draft', async (c) => c.json(postil.setDraftBody((await json(c, schemas.body)).body)));
  app.post('/api/reviews/submit', async (c) => c.json(await postil.submitReview((await json(c, schemas.optionalBody)).body), 201));
  app.get('/api/reviews/:id', (c) => c.json(postil.review(param(c, 'id'))));

  // -------------------------------------------------------------- marks
  app.get('/api/marks/files', (c) => c.json({ marks: postil.fileMarks() }));
  app.put('/api/marks/files', async (c) => {
    const b = await json(c, schemas.fileMark);
    postil.setFileMark(b.path, b.blob, b.viewed);
    return c.json({ ok: true });
  });
  app.get('/api/marks/sections', async (c) => {
    const q = query(c, schemas.sectionFilter);
    if (q.from && q.to) return c.json({ marks: await postil.sectionMarksIn({ from_tree: q.from, to_tree: q.to }) });
    return c.json({ marks: postil.sectionMarks(q.path) });
  });
  app.post('/api/marks/sections', async (c) => c.json(await postil.addSectionMark(await json(c, schemas.sectionMark)), 201));
  app.delete('/api/marks/sections/:id', (c) => {
    postil.removeSectionMark(param(c, 'id'));
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------- ui state
  app.get('/api/ui-state', (c) => c.json({ keys: postil.uiStateKeys() }));
  app.get('/api/ui-state/:key', (c) => c.json({ value: postil.uiState(c.req.param('key')) }));
  app.put('/api/ui-state/:key', async (c) => {
    postil.setUiState(c.req.param('key'), (await json(c, z.object({ value: z.unknown() }))).value);
    return c.json({ ok: true });
  });
  app.delete('/api/ui-state/:key', (c) => {
    postil.deleteUiState(c.req.param('key'));
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------- agent (Claude)
  app.get('/api/agent/pending', (c) => c.json({ reviews: postil.pendingReviews() }));
  app.post('/api/agent/listen', (c) => {
    const s = session(c);
    if (!s) throw new HttpError(400, 'the x-postil-session header is required', 'missing_session');
    return c.json(postil.listen(s));
  });
  app.get('/api/agent/hook-status', (c) => c.json(postil.hookStatus(z.string().min(1).parse(c.req.query('session')))));
  app.get('/api/agent/reviews/:id', async (c) => c.json(await postil.reviewForAgent(param(c, 'id'), session(c))));
  app.get('/api/agent/reviews/:id/unanswered', (c) => {
    const threads = postil.unansweredThreads(param(c, 'id'));
    return c.json({ threads: threads.map((t) => ({ id: t.id, path: t.path, start_line: t.start_line, end_line: t.end_line })) });
  });
  app.post('/api/agent/threads/:id/reply', async (c) => {
    const b = await json(c, schemas.agentReply);
    return c.json(await postil.agentReply(param(c, 'id'), b.body, b.needs_decision ?? false, session(c)), 201);
  });
  app.post('/api/agent/comments/:id/apply', async (c) => c.json(await postil.applySuggestion(param(c, 'id'))));
  app.post('/api/agent/reviews/:id/complete', async (c) =>
    c.json(await postil.completeReview(param(c, 'id'), (await json(c, schemas.complete)).summary)),
  );

  return app;
}
