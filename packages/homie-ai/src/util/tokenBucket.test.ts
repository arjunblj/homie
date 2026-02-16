import { describe, expect, test } from 'bun:test';

import { TokenBucket } from './tokenBucket.js';

describe('TokenBucket', () => {
  test('take(0) returns immediately', async () => {
    const b = new TokenBucket({ capacity: 1, refillPerSecond: 1000 });
    const before = Date.now();
    await b.take(0);
    expect(Date.now() - before).toBeLessThan(50);
  });

  test('take(cost) refills and consumes tokens', async () => {
    const b = new TokenBucket({ capacity: 1, refillPerSecond: 1000 });
    // Force a refill path without waiting.
    (b as unknown as { tokens: number; lastRefillMs: number }).tokens = 0;
    (b as unknown as { tokens: number; lastRefillMs: number }).lastRefillMs = Date.now() - 1000;

    const before = Date.now();
    await b.take(1);
    expect(Date.now() - before).toBeLessThan(50);
  });

  test('take(cost) waits when bucket is empty', async () => {
    const b = new TokenBucket({ capacity: 1, refillPerSecond: 1000 });
    // Force the "wait" path: no immediate refill possible.
    (b as unknown as { tokens: number; lastRefillMs: number }).tokens = 0;
    (b as unknown as { tokens: number; lastRefillMs: number }).lastRefillMs = Date.now();

    const before = Date.now();
    await b.take(1);
    expect(Date.now() - before).toBeLessThan(250);
  });
});
