import { describe, expect, test } from 'bun:test';
import { withMockedDateNow } from '../testing/mockTime.js';
import { PerKeyRateLimiter } from './perKeyRateLimiter.js';

describe('PerKeyRateLimiter', () => {
  test('evicts stale keys based on time even with low call volume', async () => {
    await withMockedDateNow(1_000_000, async (t) => {
      const limiter = new PerKeyRateLimiter<string>({
        capacity: 100,
        refillPerSecond: 100,
        staleAfterMs: 100,
        sweepInterval: 1000,
      });

      await limiter.take('a');
      expect(limiter.size).toBe(1);

      t.advance(200);
      await limiter.take('b');
      expect(limiter.size).toBe(1);
    });
  });

  test('evicts stale keys on sweepInterval threshold', async () => {
    await withMockedDateNow(1_000_000, async (t) => {
      const limiter = new PerKeyRateLimiter<string>({
        capacity: 100,
        refillPerSecond: 100,
        staleAfterMs: 1,
        sweepInterval: 1,
      });

      await limiter.take('a');
      expect(limiter.size).toBe(1);

      t.advance(10);
      await limiter.take('b');
      expect(limiter.size).toBe(1);
    });
  });

  test('refreshes lastAccessMs on reuse', async () => {
    await withMockedDateNow(1_000_000, async (t) => {
      const limiter = new PerKeyRateLimiter<string>({
        capacity: 100,
        refillPerSecond: 100,
        staleAfterMs: 100,
        sweepInterval: 1,
      });

      await limiter.take('a');
      t.advance(50);
      await limiter.take('a');
      t.advance(80);
      await limiter.take('b');

      // If lastAccess refresh is working, 'a' should not be evicted yet.
      expect(limiter.size).toBe(2);
    });
  });
});
