import { describe, expect, test } from 'bun:test';

import { asChatId } from '../types/ids.js';
import { shouldSuppressOutreach } from './heartbeat.js';
import type { EventScheduler } from './scheduler.js';

describe('proactive/heartbeat', () => {
  test('suppresses during cooldown after user message', () => {
    const scheduler = {
      countRecentSends: () => 0,
      countRecentSendsForScope: () => 0,
      countRecentSendsForChat: () => 0,
      countIgnoredRecent: () => 0,
    } as unknown as EventScheduler;

    const config = {
      enabled: true,
      heartbeatIntervalMs: 60_000,
      dm: {
        maxPerDay: 1,
        maxPerWeek: 3,
        cooldownAfterUserMs: 7_200_000,
        pauseAfterIgnored: 2,
      },
      group: {
        maxPerDay: 1,
        maxPerWeek: 1,
        cooldownAfterUserMs: 12 * 60 * 60_000,
        pauseAfterIgnored: 1,
      },
    };

    const res = shouldSuppressOutreach(
      scheduler,
      config,
      'check_in',
      asChatId('c'),
      Date.now() - 1_000,
    );
    expect(res.suppressed).toBe(true);
    expect(res.reason).toBe('cooldown_after_user');
  });
});
