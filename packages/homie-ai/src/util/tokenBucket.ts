export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  public constructor(private readonly options: TokenBucketOptions) {
    this.tokens = options.capacity;
    this.lastRefillMs = Date.now();
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
      const now = Date.now();
      this.refill(now);
      if (this.tokens >= cost) {
        this.tokens -= cost;
        return;
      }
      const missing = cost - this.tokens;
      const waitMs = Math.ceil((missing / this.options.refillPerSecond) * 1000);
      await new Promise((r) => setTimeout(r, Math.min(250, Math.max(1, waitMs))));
    }
  }
}
