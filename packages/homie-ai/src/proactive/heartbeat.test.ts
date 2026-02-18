import { describe, expect, test } from 'bun:test';

import { asChatId } from '../types/ids.js';
import { shouldSuppressOutreach } from './heartbeat.js';
import type { EventScheduler } from './scheduler.js';

describe('proactive/heartbeat', () => {
  test('suppresses during cooldown after user message', () => {
    const scheduler = {
      countRecentSends: () => 0,
      countRecentSendsForChat: () => 0,
      countIgnoredRecent: () => 0,
    } as unknown as EventScheduler;

    const config = {
      enabled: true,
      heartbeatIntervalMs: 60_000,
      maxPerDay: 1,
      maxPerWeek: 3,
      cooldownAfterUserMs: 7_200_000,
      pauseAfterIgnored: 2,
      groupMaxPerDay: 1,
      groupMaxPerWeek: 1,
      groupCooldownAfterUserMs: 12 * 60 * 60_000,
      groupPauseAfterIgnored: 1,
    };

    const res = shouldSuppressOutreach(scheduler, config, asChatId('c'), Date.now() - 1_000);
    expect(res.suppressed).toBe(true);
    expect(res.reason).toBe('cooldown_after_user');
  });
});
