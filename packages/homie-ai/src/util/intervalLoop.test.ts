import { describe, expect, test } from 'bun:test';

import { IntervalLoop } from './intervalLoop.js';

describe('IntervalLoop', () => {
  test('start + stop toggles running state (healthCheck)', () => {
    const loop = new IntervalLoop({
      name: 'test_loop',
      everyMs: 1000,
      tick: async () => {},
    });

    loop.start();
    expect(() => loop.healthCheck()).not.toThrow();

    loop.stop();
    expect(() => loop.healthCheck()).toThrow('loop not running');
  });

  test('start is a no-op when signal already aborted', () => {
    const ac = new AbortController();
    ac.abort();

    const loop = new IntervalLoop({
      name: 'aborted_loop',
      everyMs: 1000,
      tick: async () => {},
      signal: ac.signal,
    });

    loop.start();
    expect(() => loop.healthCheck()).toThrow('loop not running');
  });

  test('healthCheck throws when loop becomes stale', () => {
    const realNow = Date.now;
    try {
      let t = 1_000_000;
      Date.now = () => t;

      const loop = new IntervalLoop({
        name: 'stale_loop',
        everyMs: 1000,
        tick: async () => {},
      });

      loop.start();

      t += 10_000;
      expect(() => loop.healthCheck({ staleAfterMs: 1000 })).toThrow('loop stale');

      loop.stop();
    } finally {
      Date.now = realNow;
    }
  });

  test('runOnce does not overlap ticks', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    let calls = 0;
    const loop = new IntervalLoop({
      name: 'overlap_loop',
      everyMs: 1000,
      tick: async () => {
        calls += 1;
        await gate;
      },
    });

    // Intentionally call the private method in tests to deterministically cover the
    // no-overlap guard without relying on timers.
    const p1 = (loop as unknown as { runOnce: () => Promise<void> }).runOnce();
    const p2 = (loop as unknown as { runOnce: () => Promise<void> }).runOnce();

    expect(calls).toBe(1);
    release?.();
    await Promise.all([p1, p2]);
  });

  test('healthCheck throws after a recent tick error', () => {
    const loop = new IntervalLoop({
      name: 'error_loop',
      everyMs: 1000,
      tick: async () => {},
    });

    loop.start();
    // Avoid emitting error logs during tests; simulate a recent error by setting the timestamp.
    (loop as unknown as { lastErrorAtMs?: number }).lastErrorAtMs = Date.now();

    expect(() => loop.healthCheck({ staleAfterMs: 60_000 })).toThrow('recently errored');
    loop.stop();
  });
});
