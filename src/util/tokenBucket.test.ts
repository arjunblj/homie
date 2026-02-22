import { describe, expect, test } from 'bun:test';

import { TokenBucket } from './tokenBucket.js';

describe('TokenBucket', () => {
  test('take(0) does not sleep', async () => {
    let slept = 0;
    const b = new TokenBucket(
      { capacity: 1, refillPerSecond: 1000 },
      {
        now: () => 0,
        sleep: async () => {
          slept += 1;
        },
      },
    );

    await b.take(0);
    expect(slept).toBe(0);
  });

  test('take(cost) consumes immediately when tokens are available', async () => {
    let t = 0;
    let sleptMs = 0;
    const b = new TokenBucket(
      { capacity: 2, refillPerSecond: 1 },
      {
        now: () => t,
        sleep: async (ms) => {
          sleptMs += ms;
          t += ms;
        },
      },
    );

    await b.take(1);
    expect(sleptMs).toBe(0);
  });

  test('take(cost) waits and refills deterministically when empty', async () => {
    let t = 0;
    let sleptMs = 0;
    const b = new TokenBucket(
      { capacity: 1, refillPerSecond: 1 }, // 1 token per second
      {
        now: () => t,
        sleep: async (ms) => {
          sleptMs += ms;
          t += ms;
        },
        maxSleepMs: 10_000,
      },
    );

    await b.take(1); // consume initial token
    await b.take(1); // must wait ~1000ms to refill 1 token
    expect(sleptMs).toBeGreaterThanOrEqual(1000);
  });
});
