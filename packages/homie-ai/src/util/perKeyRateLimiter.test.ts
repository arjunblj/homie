import { describe, expect, test } from 'bun:test';

import { PerKeyRateLimiter } from './perKeyRateLimiter.js';

describe('PerKeyRateLimiter', () => {
  test('evicts stale keys based on time even with low call volume', async () => {
    const realNow = Date.now;
    try {
      let t = 1_000_000;
      Date.now = () => t;

      const limiter = new PerKeyRateLimiter<string>({
        capacity: 100,
        refillPerSecond: 100,
        staleAfterMs: 100,
        sweepInterval: 1000,
      });

      await limiter.take('a');
      expect(limiter.size).toBe(1);

      t += 200;
      await limiter.take('b');
      expect(limiter.size).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });

  test('evicts stale keys on sweepInterval threshold', async () => {
    const realNow = Date.now;
    try {
      let t = 1_000_000;
      Date.now = () => t;

      const limiter = new PerKeyRateLimiter<string>({
        capacity: 100,
        refillPerSecond: 100,
        staleAfterMs: 1,
        sweepInterval: 1,
      });

      await limiter.take('a');
      expect(limiter.size).toBe(1);

      t += 10;
      await limiter.take('b');
      expect(limiter.size).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });

  test('refreshes lastAccessMs on reuse', async () => {
    const realNow = Date.now;
    try {
      let t = 1_000_000;
      Date.now = () => t;

      const limiter = new PerKeyRateLimiter<string>({
        capacity: 100,
        refillPerSecond: 100,
        staleAfterMs: 100,
        sweepInterval: 1,
      });

      await limiter.take('a');
      t += 50;
      await limiter.take('a');
      t += 80;
      await limiter.take('b');

      // If lastAccess refresh is working, 'a' should not be evicted yet.
      expect(limiter.size).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });
});

