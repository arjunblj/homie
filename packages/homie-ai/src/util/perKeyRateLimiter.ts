import type { TokenBucketOptions } from './tokenBucket.js';
import { TokenBucket } from './tokenBucket.js';

interface BucketEntry {
  bucket: TokenBucket;
  lastAccessMs: number;
}

export interface PerKeyRateLimiterOptions extends TokenBucketOptions {
  staleAfterMs?: number | undefined;
  sweepInterval?: number | undefined;
}

export class PerKeyRateLimiter<K> {
  private readonly entries = new Map<K, BucketEntry>();
  private readonly bucketOpts: TokenBucketOptions;
  private readonly staleAfterMs: number;
  private readonly sweepInterval: number;
  private callsSinceSweep = 0;
  private lastSweepAtMs = 0;

  public constructor(options: PerKeyRateLimiterOptions) {
    this.bucketOpts = { capacity: options.capacity, refillPerSecond: options.refillPerSecond };
    this.staleAfterMs = options.staleAfterMs ?? 600_000;
    this.sweepInterval = options.sweepInterval ?? 50;
    this.lastSweepAtMs = Date.now();
  }

  public async take(key: K, cost = 1): Promise<void> {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { bucket: new TokenBucket(this.bucketOpts), lastAccessMs: now };
      this.entries.set(key, entry);
    }
    entry.lastAccessMs = now;

    this.callsSinceSweep += 1;
    if (
      this.callsSinceSweep >= this.sweepInterval ||
      (this.staleAfterMs > 0 && now - this.lastSweepAtMs >= this.staleAfterMs)
    ) {
      this.sweep(now);
    }

    await entry.bucket.take(cost);
  }

  public get size(): number {
    return this.entries.size;
  }

  private sweep(nowMs: number): void {
    this.callsSinceSweep = 0;
    this.lastSweepAtMs = nowMs;
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.lastAccessMs > this.staleAfterMs) this.entries.delete(key);
    }
  }
}
