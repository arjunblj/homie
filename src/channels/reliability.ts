export interface BackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  minDelayMs?: number | undefined;
  jitterFraction?: number | undefined;
  random?: (() => number) | undefined;
}

export const computeBackoffDelayMs = (attempt: number, opts: BackoffOptions): number => {
  const base = Math.max(0, opts.baseDelayMs);
  const max = Math.max(base, opts.maxDelayMs);
  const min = Math.max(0, opts.minDelayMs ?? 0);
  const jitterFraction = Math.max(0, opts.jitterFraction ?? 0.1);
  const random = opts.random ?? Math.random;

  const exp = Math.min(max, base * 2 ** Math.max(0, attempt));
  const jitter = Math.floor(exp * jitterFraction * random());
  return Math.max(min, exp + jitter);
};

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  minDelayMs?: number | undefined;
  jitterFraction?: number | undefined;
  random?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  shouldRetry: (error: unknown) => boolean;
  computeRetryDelayMs?:
    | ((error: unknown, computedDelayMs: number, attempt: number) => number)
    | undefined;
  onRetry?: ((error: unknown, delayMs: number, attempt: number) => void) | undefined;
}

export const runWithRetries = async <T>(
  action: () => Promise<T>,
  options: RetryOptions,
): Promise<T> => {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts));
  const sleep = options.sleep ?? (async (ms: number) => new Promise((r) => setTimeout(r, ms)));

  let attempt = 0;
  while (true) {
    try {
      return await action();
    } catch (err) {
      const shouldRetry = options.shouldRetry(err);
      const isLast = attempt >= maxAttempts - 1;
      if (!shouldRetry || isLast) throw err;
      const computedDelayMs = computeBackoffDelayMs(attempt, options);
      const delayMs = Math.max(
        0,
        Math.floor(
          options.computeRetryDelayMs?.(err, computedDelayMs, attempt + 1) ?? computedDelayMs,
        ),
      );
      options.onRetry?.(err, delayMs, attempt + 1);
      await sleep(delayMs);
      attempt += 1;
    }
  }
};

interface DedupeEntry {
  seenAtMs: number;
}

export interface ShortLivedDedupeCacheOptions {
  ttlMs: number;
  maxEntries?: number | undefined;
}

export class ShortLivedDedupeCache {
  private readonly entries = new Map<string, DedupeEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  public constructor(options: ShortLivedDedupeCacheOptions) {
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs));
    this.maxEntries = Math.max(10, Math.floor(options.maxEntries ?? 10_000));
  }

  public seen(key: string, nowMs: number = Date.now()): boolean {
    this.evictExpired(nowMs);

    const existing = this.entries.get(key);
    if (existing && nowMs - existing.seenAtMs <= this.ttlMs) {
      return true;
    }

    this.entries.set(key, { seenAtMs: nowMs });
    if (this.entries.size > this.maxEntries) this.evictOldest();
    return false;
  }

  public get size(): number {
    return this.entries.size;
  }

  private evictExpired(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.seenAtMs > this.ttlMs) this.entries.delete(key);
    }
  }

  private evictOldest(): void {
    const oldest = this.entries.keys().next();
    if (!oldest.done) this.entries.delete(oldest.value);
  }
}

export class ReconnectGuard {
  private timer: ReturnType<typeof setTimeout> | undefined;

  public schedule(delayMs: number, run: () => void): boolean {
    if (this.timer) return false;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        run();
      },
      Math.max(0, Math.floor(delayMs)),
    );
    return true;
  }

  public clear(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  public get pending(): boolean {
    return Boolean(this.timer);
  }
}
