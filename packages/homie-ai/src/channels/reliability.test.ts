import { describe, expect, test } from 'bun:test';

import {
  computeBackoffDelayMs,
  ReconnectGuard,
  runWithRetries,
  ShortLivedDedupeCache,
} from './reliability.js';

describe('channels/reliability', () => {
  test('computeBackoffDelayMs uses exponential with 10% jitter', () => {
    const d0 = computeBackoffDelayMs(0, {
      baseDelayMs: 1000,
      maxDelayMs: 60_000,
      jitterFraction: 0.1,
      random: () => 0.5,
    });
    expect(d0).toBe(1050);
  });

  test('runWithRetries retries retryable failures', async () => {
    let attempts = 0;
    const waits: number[] = [];
    const out = await runWithRetries(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('retryable');
        return 'ok';
      },
      {
        maxAttempts: 4,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        random: () => 0,
        sleep: async (ms) => {
          waits.push(ms);
        },
        shouldRetry: (err) => (err instanceof Error ? err.message === 'retryable' : false),
      },
    );

    expect(out).toBe('ok');
    expect(attempts).toBe(3);
    expect(waits).toEqual([100, 200]);
  });

  test('runWithRetries stops on non-retryable error', async () => {
    await expect(
      runWithRetries(
        async () => {
          throw new Error('fatal');
        },
        {
          maxAttempts: 5,
          baseDelayMs: 100,
          maxDelayMs: 1000,
          shouldRetry: () => false,
        },
      ),
    ).rejects.toThrow('fatal');
  });

  test('ShortLivedDedupeCache dedupes within ttl and expires entries', () => {
    const cache = new ShortLivedDedupeCache({ ttlMs: 100, maxEntries: 100 });
    expect(cache.seen('k', 1000)).toBe(false);
    expect(cache.seen('k', 1050)).toBe(true);
    expect(cache.seen('k', 1201)).toBe(false);
  });

  test('ReconnectGuard keeps one pending reconnect', async () => {
    const guard = new ReconnectGuard();
    let runs = 0;
    const scheduledA = guard.schedule(1, () => {
      runs += 1;
    });
    const scheduledB = guard.schedule(1, () => {
      runs += 1;
    });
    expect(scheduledA).toBe(true);
    expect(scheduledB).toBe(false);
    expect(guard.pending).toBe(true);

    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toBe(1);
    expect(guard.pending).toBe(false);
  });
});
