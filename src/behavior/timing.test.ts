import { describe, expect, test } from 'bun:test';

import { isInSleepWindow, parseHHMM, randomDelayMs, sampleHumanDelayMs } from './timing.js';

describe('behavior/timing', () => {
  test('parseHHMM parses valid time', () => {
    expect(parseHHMM('07:30')).toEqual({ h: 7, m: 30 });
  });

  test('isInSleepWindow handles cross-midnight windows', () => {
    const sleep = { enabled: true, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' };
    expect(isInSleepWindow(new Date('2026-02-16T23:30:00.000Z'), sleep)).toBe(true);
    expect(isInSleepWindow(new Date('2026-02-16T08:00:00.000Z'), sleep)).toBe(false);
  });

  test('randomDelayMs stays within bounds', () => {
    for (let i = 0; i < 50; i += 1) {
      const v = randomDelayMs(10, 20);
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThanOrEqual(20);
    }
  });

  test('sampleHumanDelayMs stays within bounds (deterministic rng)', () => {
    const rng = (() => {
      const seq = [0.2, 0.7, 0.4, 0.9];
      let i = 0;
      return () => {
        const v = seq[i % seq.length] ?? 0.5;
        i += 1;
        return v;
      };
    })();

    const v = sampleHumanDelayMs({
      minMs: 3000,
      maxMs: 18_000,
      kind: 'send_text',
      textLen: 120,
      rng,
    });
    expect(v).toBeGreaterThanOrEqual(3000);
    expect(v).toBeLessThanOrEqual(18_000);
  });

  test('sampleHumanDelayMs biases reactions faster than texts', () => {
    const rng = (() => {
      const seq = [0.3, 0.8, 0.3, 0.8];
      let i = 0;
      return () => {
        const v = seq[i % seq.length] ?? 0.5;
        i += 1;
        return v;
      };
    })();

    const reactDelay = sampleHumanDelayMs({
      minMs: 3000,
      maxMs: 18_000,
      kind: 'react',
      textLen: 1,
      rng,
    });
    const sendDelay = sampleHumanDelayMs({
      minMs: 3000,
      maxMs: 18_000,
      kind: 'send_text',
      textLen: 200,
      rng,
    });
    expect(reactDelay).toBeLessThan(sendDelay);
  });
});
