import type {
  AnchoredSectionMark, AppliedSuggestion, SectionMarkRow, Side, BaseInfo, BranchesInfo, CommitsInfo, FinishOptions, Preferences, FileDiff, FileMarkRow, Health, NewThreadInput, ResolvedDiff, ReviewView, Scope, ThreadView,
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

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method,
    ...(signal && { signal }),
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  // An error response may have no JSON body; a successful one that cannot be read (cut off, or
  // cancelled mid-download) is a failure, never an empty result.
  let payload: { error?: { code: string; message: string; details?: unknown } };
  try {
    payload = (await res.json()) as typeof payload;
  } catch (e) {
    if (res.ok) throw e;
    payload = {};
  }
  if (!res.ok) throw new ApiError(res.status, payload.error?.code ?? 'error', payload.error?.message ?? res.statusText, payload.error?.details);
  return payload as T;
}

const q = (params: Record<string, string | number | undefined | null>) =>
  new URLSearchParams(Object.entries(params).flatMap(([k, v]) => (v === undefined || v === null ? [] : [[k, String(v)]]))).toString();

export const api = {
  health: () => call<Health>('GET', '/api/health'),
  base: () => call<BaseInfo>('GET', '/api/base'),
  commits: () => call<CommitsInfo>('GET', '/api/commits'),
  branches: () => call<BranchesInfo>('GET', '/api/branches'),
  /** Follow the merge base with a branch, or null to go back to the default base. */
  setBaseBranch: (branch: string | null) =>
    branch === null ? call<BaseInfo>('POST', '/api/base/reset') : call<BaseInfo>('PUT', '/api/base', { branch }),
  resolve: (scope: Scope) => call<ResolvedDiff>('POST', '/api/diff/resolve', { scope }),
  fileDiff: (oldBlob: string | null, newBlob: string | null, opts: { force?: boolean; signal?: AbortSignal } = {}) =>
    call<FileDiff>('GET', `/api/diff/file?${q({ old: oldBlob, new: newBlob, force: opts.force ? '1' : undefined })}`, undefined, opts.signal),
  /** A URL for an <img>: images cannot send headers, so the token rides in the query. */
  rawUrl: (oid: string, path: string) => `/api/blobs/${oid}/raw?${q({ path, token })}`,
  lines: (oid: string, start: number, end: number) =>
    call<{ lines: string[]; total: number; end: number }>('GET', `/api/blobs/${oid}/lines?${q({ start, end })}`),

  /** Threads, anchored to the given diff when its trees are passed. */
  threads: (trees?: { from: string; to: string }) =>
    call<{ threads: ThreadView[] }>('GET', `/api/threads${trees ? `?${q({ from: trees.from, to: trees.to })}` : ''}`),
  applySuggestion: (commentId: number) => call<AppliedSuggestion>('POST', `/api/comments/${commentId}/apply`),
  createThread: (input: NewThreadInput) => call<ThreadView>('POST', '/api/threads', input),
  reply: (threadId: number, body: string) => call<ThreadView>('POST', `/api/threads/${threadId}/replies`, { body }),
  resolveThread: (id: number) => call<ThreadView>('POST', `/api/threads/${id}/resolve`),
  unresolveThread: (id: number) => call<ThreadView>('POST', `/api/threads/${id}/unresolve`),
  editComment: (id: number, body: string) => call<ThreadView>('PATCH', `/api/comments/${id}`, { body }),
  deleteComment: (id: number) => call<{ thread_deleted: boolean }>('DELETE', `/api/comments/${id}`),

  reviews: () => call<{ reviews: ReviewView[] }>('GET', '/api/reviews'),
  archive: () => call<{ threads: number; reviews: number; unpinned: number }>('POST', '/api/archive'),
  finishSession: (opts: FinishOptions) => call<{ threads: number; reviews: number; unpinned: number }>('POST', '/api/session/finish', opts),
  preferences: () => call<Preferences>('GET', '/api/preferences'),
  setPreferences: (change: Partial<Preferences>) => call<Preferences>('PUT', '/api/preferences', change),
  reset: () => call<{ threads: number; reviews: number; drafts: number; unpinned: number }>('POST', '/api/reset'),
  archivedThreads: () => call<{ threads: ThreadView[] }>('GET', '/api/archive/threads'),
  draft: () => call<{ draft: ReviewView | null }>('GET', '/api/reviews/draft'),
  setDraftBody: (body: string) => call<ReviewView>('PUT', '/api/reviews/draft', { body }),
  submit: (body?: string) => call<ReviewView>('POST', '/api/reviews/submit', body === undefined ? {} : { body }),

  fileMarks: () => call<{ marks: FileMarkRow[] }>('GET', '/api/marks/files'),
  setFileMark: (path: string, blob: string, viewed: boolean) => call<{ ok: true }>('PUT', '/api/marks/files', { path, blob, viewed }),

  sectionMarks: (trees: { from: string; to: string }) =>
    call<{ marks: AnchoredSectionMark[] }>('GET', `/api/marks/sections?${q({ from: trees.from, to: trees.to })}`),
  addSectionMark: (m: { path: string; from_blob: string | null; to_blob: string | null; side: Side; start_line: number; end_line: number }) =>
    call<SectionMarkRow>('POST', '/api/marks/sections', m),
  removeSectionMark: (id: number) => call<{ ok: true }>('DELETE', `/api/marks/sections/${id}`),

  uiState: <T>(key: string) => call<{ value: T | null }>('GET', `/api/ui-state/${encodeURIComponent(key)}`),
  setUiState: (key: string, value: unknown) => call<{ ok: true }>('PUT', `/api/ui-state/${encodeURIComponent(key)}`, { value }),
};
