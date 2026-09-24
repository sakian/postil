/** Serialises async work. Used around the private index file, which git locks exclusively. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** Least-recently-used cache bounded by total byte size. */
export class ByteLru<K> {
  private readonly map = new Map<K, Buffer>();
  private bytes = 0;
  private readonly capacity: number;
  private readonly maxEntry: number;

  constructor(capacity: number, maxEntry: number) {
    this.capacity = capacity;
    this.maxEntry = maxEntry;
  }

  get(key: K): Buffer | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: Buffer): void {
    if (value.length > this.maxEntry) return;
    const existing = this.map.get(key);
    if (existing) {
      this.bytes -= existing.length;
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.bytes += value.length;
    for (const [k, v] of this.map) {
      if (this.bytes <= this.capacity) break;
      this.map.delete(k);
      this.bytes -= v.length;
    }
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** An error whose message is safe to show to API clients, with an HTTP status. */
export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422;

export class HttpError extends Error {
  readonly status: HttpStatus;
  readonly code: string;
  /** Structured data for the client, such as the threads that block an operation. */
  readonly details: unknown;

  constructor(status: HttpStatus, message: string, code = 'error', details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
