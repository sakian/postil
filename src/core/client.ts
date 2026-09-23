import { Repo } from '../git/repo.ts';
import { probe, readServerInfo, type ServerInfo } from './discovery.ts';

export class NotRunningError extends Error {
  readonly root: string;
  constructor(root: string) {
    super(`no postil server is running for ${root}; start one with \`postil serve\``);
    this.name = 'NotRunningError';
    this.root = root;
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** HTTP client for the server that owns a repository. Used by the CLI, and later by the MCP proxy and hooks. */
export class PostilClient {
  readonly info: ServerInfo;

  private constructor(info: ServerInfo) {
    this.info = info;
  }

  static async connect(cwd: string): Promise<PostilClient> {
    const repo = await Repo.open(cwd);
    const info = await readServerInfo(repo.stateDir);
    if (!info || !(await probe(info, repo.root))) throw new NotRunningError(repo.root);
    return new PostilClient(info);
  }

  get uiUrl(): string {
    return `${this.info.url}/#token=${this.info.token}`;
  }

  get agentEventsUrl(): string {
    return `ws://127.0.0.1:${this.info.port}/events?channel=agent&token=${this.info.token}`;
  }

  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.info.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.info.token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string; details?: unknown } };
    if (!res.ok) {
      throw new ApiError(res.status, payload.error?.code ?? 'error', payload.error?.message ?? res.statusText, payload.error?.details);
    }
    return payload as T;
  }
}
