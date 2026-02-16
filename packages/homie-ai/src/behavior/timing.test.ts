import { describe, expect, test } from 'bun:test';

import { isInSleepWindow, parseHHMM, randomDelayMs } from './timing.js';

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
});
