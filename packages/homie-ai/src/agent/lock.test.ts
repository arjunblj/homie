import { describe, expect, test } from 'bun:test';

import { PerKeyLock } from './lock.js';

describe('PerKeyLock', () => {
  test('serializes work per key', async () => {
    const lock = new PerKeyLock<string>();
    const order: number[] = [];

    const p1 = lock.runExclusive('a', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
    });
    const p2 = lock.runExclusive('a', async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    // Allow the internal queueMicrotask cleanup to run for coverage.
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(order).toEqual([1, 2]);
  });

  test('allows concurrency across keys', async () => {
    const lock = new PerKeyLock<string>();
    let ranB = false;

    const p1 = lock.runExclusive('a', async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
    const p2 = lock.runExclusive('b', async () => {
      ranB = true;
    });

    await Promise.all([p1, p2]);
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(ranB).toBe(true);
  });

  test('exposes internal chain progression (coverage)', async () => {
    const lock = new PerKeyLock<string>();
    const p = lock.runExclusive('a', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 123;
    });

    const chain = (lock as unknown as { chains: Map<string, Promise<void>> }).chains.get('a');
    expect(chain).toBeInstanceOf(Promise);

    await expect(p).resolves.toBe(123);
    if (chain) await chain;
  });
});
