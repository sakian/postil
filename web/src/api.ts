import type {
  BaseInfo, CommitsInfo, FileDiff, FileMarkRow, Health, NewThreadInput, ResolvedDiff, ReviewView, Scope, ThreadView,
} from '../../src/core/api-types.ts';

const TOKEN_KEY = 'postil.token';

/**
 * The server hands the token over in the URL fragment, which browsers never send anywhere.
 * Keep it in localStorage, which is scoped to this origin (host and port), then scrub it
 * from the address bar so it does not end up in history or a bookmark.
 */
export function initToken(): string | null {
  const match = /(?:^|[#&])token=([\w-]+)/.exec(location.hash);
  if (match?.[1]) {
    try {
      localStorage.setItem(TOKEN_KEY, match[1]);
    } catch {
      /* storage disabled: the token still works for this page load */
    }
    history.replaceState(null, '', location.pathname + location.search);
    return match[1];
  }
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let token: string | null = null;
export function setToken(t: string | null): void {
  token = t;
}
export function getToken(): string | null {
  return token;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string; details?: unknown } };
  if (!res.ok) throw new ApiError(res.status, payload.error?.code ?? 'error', payload.error?.message ?? res.statusText, payload.error?.details);
  return payload as T;
}

const q = (params: Record<string, string | number | undefined | null>) =>
  new URLSearchParams(Object.entries(params).flatMap(([k, v]) => (v === undefined || v === null ? [] : [[k, String(v)]]))).toString();

export const api = {
  health: () => call<Health>('GET', '/api/health'),
  base: () => call<BaseInfo>('GET', '/api/base'),
  commits: () => call<CommitsInfo>('GET', '/api/commits'),
  resolve: (scope: Scope) => call<ResolvedDiff>('POST', '/api/diff/resolve', { scope }),
  fileDiff: (oldBlob: string | null, newBlob: string | null, opts: { force?: boolean } = {}) =>
    call<FileDiff>('GET', `/api/diff/file?${q({ old: oldBlob, new: newBlob, force: opts.force ? '1' : undefined })}`),
  lines: (oid: string, start: number, end: number) =>
    call<{ lines: string[]; total: number; end: number }>('GET', `/api/blobs/${oid}/lines?${q({ start, end })}`),

  threads: () => call<{ threads: ThreadView[] }>('GET', '/api/threads'),
  createThread: (input: NewThreadInput) => call<ThreadView>('POST', '/api/threads', input),
  reply: (threadId: number, body: string) => call<ThreadView>('POST', `/api/threads/${threadId}/replies`, { body }),
  resolveThread: (id: number) => call<ThreadView>('POST', `/api/threads/${id}/resolve`),
  unresolveThread: (id: number) => call<ThreadView>('POST', `/api/threads/${id}/unresolve`),
  editComment: (id: number, body: string) => call<ThreadView>('PATCH', `/api/comments/${id}`, { body }),
  deleteComment: (id: number) => call<{ thread_deleted: boolean }>('DELETE', `/api/comments/${id}`),

  reviews: () => call<{ reviews: ReviewView[] }>('GET', '/api/reviews'),
  draft: () => call<{ draft: ReviewView | null }>('GET', '/api/reviews/draft'),
  setDraftBody: (body: string) => call<ReviewView>('PUT', '/api/reviews/draft', { body }),
  submit: (body?: string) => call<ReviewView>('POST', '/api/reviews/submit', body === undefined ? {} : { body }),

  fileMarks: () => call<{ marks: FileMarkRow[] }>('GET', '/api/marks/files'),
  setFileMark: (path: string, blob: string, viewed: boolean) => call<{ ok: true }>('PUT', '/api/marks/files', { path, blob, viewed }),

  uiState: <T>(key: string) => call<{ value: T | null }>('GET', `/api/ui-state/${encodeURIComponent(key)}`),
  setUiState: (key: string, value: unknown) => call<{ ok: true }>('PUT', `/api/ui-state/${encodeURIComponent(key)}`, { value }),
};
