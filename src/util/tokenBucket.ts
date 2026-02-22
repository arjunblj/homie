export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
}

export interface TokenBucketDeps {
  /** Time source (defaults to Date.now). */
  readonly now?: (() => number) | undefined;
  /** Sleep primitive (defaults to setTimeout-based). */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Upper bound per-sleep to avoid long waits (default 250ms). */
  readonly maxSleepMs?: number | undefined;
}

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxSleepMs: number;

  public constructor(
    private readonly options: TokenBucketOptions,
    deps: TokenBucketDeps = {},
  ) {
    this.tokens = options.capacity;
    this.now = deps.now ?? (() => Date.now());
    this.sleep =
      deps.sleep ??
      ((ms) =>
        new Promise((r) => {
          setTimeout(r, ms);
        }));
    this.maxSleepMs = deps.maxSleepMs ?? 250;
    this.lastRefillMs = this.now();
  }

  private refill(nowMs: number): void {
    const elapsedSeconds = Math.max(0, (nowMs - this.lastRefillMs) / 1000);
    const refill = elapsedSeconds * this.options.refillPerSecond;
    if (refill <= 0) return;
    this.tokens = Math.min(this.options.capacity, this.tokens + refill);
    this.lastRefillMs = nowMs;
  }

  public async take(cost: number): Promise<void> {
    if (cost <= 0) return;
    for (;;) {
      const now = this.now();
      this.refill(now);
      if (this.tokens >= cost) {
        this.tokens -= cost;
        return;
      }
      const missing = cost - this.tokens;
      const waitMs = Math.ceil((missing / this.options.refillPerSecond) * 1000);
      await this.sleep(Math.min(this.maxSleepMs, Math.max(1, waitMs)));
    }
  }
}
