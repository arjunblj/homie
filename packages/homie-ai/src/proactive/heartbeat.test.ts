import { describe, expect, test } from 'bun:test';

import { asChatId } from '../types/ids.js';
import { HeartbeatLoop, shouldSuppressOutreach } from './heartbeat.js';
import type { EventScheduler } from './scheduler.js';
import type { ProactiveEvent } from './types.js';

describe('proactive/heartbeat', () => {
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
  } as const;

  test('suppresses during cooldown after user message', () => {
    const scheduler = {
      countRecentSends: () => 0,
      countRecentSendsForScope: () => 0,
      countRecentSendsForChat: () => 0,
      countIgnoredRecent: () => 0,
    } as unknown as EventScheduler;

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

  test('does not suppress reminders even if over rate limits', () => {
    const scheduler = {
      countRecentSends: () => 0,
      countRecentSendsForScope: () => 999,
      countRecentSendsForChat: () => 999,
      countIgnoredRecent: () => 999,
    } as unknown as EventScheduler;

    const res = shouldSuppressOutreach(
      scheduler,
      config,
      'reminder',
      asChatId('signal:dm:+1'),
      Date.now() - 1_000,
    );
    expect(res.suppressed).toBe(false);
  });

  test('suppresses when daily cap exceeded (DM scope)', () => {
    const scheduler = {
      countRecentSends: () => 0,
      countRecentSendsForScope: () => 1,
      countRecentSendsForChat: () => 0,
      countIgnoredRecent: () => 0,
    } as unknown as EventScheduler;

    const res = shouldSuppressOutreach(
      scheduler,
      config,
      'check_in',
      asChatId('signal:dm:+1'),
      undefined,
    );
    expect(res).toEqual({ suppressed: true, reason: 'max_per_day' });
  });

  test('suppresses when ignored-pause threshold reached', () => {
    const scheduler = {
      countRecentSends: () => 0,
      countRecentSendsForScope: () => 0,
      countRecentSendsForChat: () => 0,
      countIgnoredRecent: () => 2,
    } as unknown as EventScheduler;

    const res = shouldSuppressOutreach(
      scheduler,
      config,
      'check_in',
      asChatId('signal:dm:+1'),
      undefined,
    );
    expect(res).toEqual({ suppressed: true, reason: 'ignored_pause' });
  });

  test('HeartbeatLoop.tick releases suppressed events without calling onProactive', async () => {
    const calls: string[] = [];
    const scheduler = {
      claimPendingEvents: () =>
        [
          {
            id: 1,
            kind: 'check_in',
            subject: 'hey',
            chatId: asChatId('signal:dm:+1'),
            triggerAtMs: Date.now(),
            recurrence: null,
            delivered: false,
            createdAtMs: Date.now(),
          },
        ] satisfies ProactiveEvent[],
      releaseClaim: (id: number) => {
        calls.push(`release:${id}`);
      },
      markDelivered: (id: number) => {
        calls.push(`delivered:${id}`);
      },
      logProactiveSend: () => {
        calls.push('logged');
      },
      countRecentSendsForScope: () => 999,
      countRecentSendsForChat: () => 0,
      countIgnoredRecent: () => 0,
    } as unknown as EventScheduler;

    const hb = new HeartbeatLoop({
      scheduler,
      proactiveConfig: config,
      behaviorConfig: {
        sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
        groupMaxChars: 240,
        dmMaxChars: 420,
        minDelayMs: 0,
        maxDelayMs: 0,
        debounceMs: 0,
      },
      onProactive: async () => {
        calls.push('onProactive');
        return true;
      },
    });

    await hb.tick();
    expect(calls).toEqual(['release:1']);
  });

  test('HeartbeatLoop.tick marks delivered when onProactive sends', async () => {
    const calls: string[] = [];
    const scheduler = {
      claimPendingEvents: () =>
        [
          {
            id: 2,
            kind: 'check_in',
            subject: 'hey',
            chatId: asChatId('signal:dm:+1'),
            triggerAtMs: Date.now(),
            recurrence: null,
            delivered: false,
            createdAtMs: Date.now(),
          },
        ] satisfies ProactiveEvent[],
      releaseClaim: (id: number) => {
        calls.push(`release:${id}`);
      },
      markDelivered: (id: number) => {
        calls.push(`delivered:${id}`);
      },
      logProactiveSend: (chatId: unknown, id: number) => {
        calls.push(`log:${String(chatId)}:${id}`);
      },
      countRecentSendsForScope: () => 0,
      countRecentSendsForChat: () => 0,
      countIgnoredRecent: () => 0,
    } as unknown as EventScheduler;

    const hb = new HeartbeatLoop({
      scheduler,
      proactiveConfig: config,
      behaviorConfig: {
        sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
        groupMaxChars: 240,
        dmMaxChars: 420,
        minDelayMs: 0,
        maxDelayMs: 0,
        debounceMs: 0,
      },
      onProactive: async () => true,
    });

    await hb.tick();
    expect(calls).toEqual(['delivered:2', `log:${String(asChatId('signal:dm:+1'))}:2`]);
  });

  test('HeartbeatLoop.tick releases claim when onProactive declines', async () => {
    const calls: string[] = [];
    const scheduler = {
      claimPendingEvents: () =>
        [
          {
            id: 3,
            kind: 'check_in',
            subject: 'hey',
            chatId: asChatId('signal:dm:+1'),
            triggerAtMs: Date.now(),
            recurrence: null,
            delivered: false,
            createdAtMs: Date.now(),
          },
        ] satisfies ProactiveEvent[],
      releaseClaim: (id: number) => {
        calls.push(`release:${id}`);
      },
      markDelivered: (id: number) => {
        calls.push(`delivered:${id}`);
      },
      logProactiveSend: () => {
        calls.push('logged');
      },
      countRecentSendsForScope: () => 0,
      countRecentSendsForChat: () => 0,
      countIgnoredRecent: () => 0,
    } as unknown as EventScheduler;

    const hb = new HeartbeatLoop({
      scheduler,
      proactiveConfig: config,
      behaviorConfig: {
        sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
        groupMaxChars: 240,
        dmMaxChars: 420,
        minDelayMs: 0,
        maxDelayMs: 0,
        debounceMs: 0,
      },
      onProactive: async () => false,
    });

    await hb.tick();
    expect(calls).toEqual(['release:3']);
  });

  test('HeartbeatLoop.tick returns early when proactive disabled or in sleep window', async () => {
    const scheduler = {
      claimPendingEvents: () => {
        throw new Error('should not be called');
      },
    } as unknown as EventScheduler;

    const hbDisabled = new HeartbeatLoop({
      scheduler,
      proactiveConfig: { ...config, enabled: false },
      behaviorConfig: {
        sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
        groupMaxChars: 240,
        dmMaxChars: 420,
        minDelayMs: 0,
        maxDelayMs: 0,
        debounceMs: 0,
      },
      onProactive: async () => true,
    });
    await hbDisabled.tick();

    const hbSleeping = new HeartbeatLoop({
      scheduler,
      proactiveConfig: config,
      behaviorConfig: {
        // Always-sleep window.
        sleep: { enabled: true, timezone: 'UTC', startLocal: '00:00', endLocal: '23:59' },
        groupMaxChars: 240,
        dmMaxChars: 420,
        minDelayMs: 0,
        maxDelayMs: 0,
        debounceMs: 0,
      },
      onProactive: async () => true,
    });
    await hbSleeping.tick();
  });

  test('HeartbeatLoop start/stop is idempotent', () => {
    const scheduler = {
      claimPendingEvents: () => [],
      countRecentSendsForScope: () => 0,
      countRecentSendsForChat: () => 0,
      countIgnoredRecent: () => 0,
      releaseClaim: () => {},
      markDelivered: () => {},
      logProactiveSend: () => {},
    } as unknown as EventScheduler;

    const hb = new HeartbeatLoop({
      scheduler,
      proactiveConfig: config,
      behaviorConfig: {
        sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
        groupMaxChars: 240,
        dmMaxChars: 420,
        minDelayMs: 0,
        maxDelayMs: 0,
        debounceMs: 0,
      },
      onProactive: async () => true,
    });

    hb.start();
    hb.start();
    hb.stop();
    hb.stop();
  });

  test('exponential backoff suppresses when recent send is within 2^N * base cooldown', () => {
    const now = Date.now();
    const scheduler = {
      countRecentSends: () => 0,
      countRecentSendsForScope: () => 0,
      countRecentSendsForChat: () => 0,
      countIgnoredRecent: () => 1,
      lastSendMsForChat: () => now - 1_000,
    } as unknown as EventScheduler;

    const res = shouldSuppressOutreach(
      scheduler,
      config,
      'check_in',
      asChatId('signal:dm:+1'),
      undefined,
    );
    expect(res.suppressed).toBe(true);
    expect(res.reason).toBe('ignored_exponential_backoff');
  });

  test('exponential backoff allows send after sufficient time', () => {
    const now = Date.now();
    const scheduler = {
      countRecentSends: () => 0,
      countRecentSendsForScope: () => 0,
      countRecentSendsForChat: () => 0,
      countIgnoredRecent: () => 1,
      lastSendMsForChat: () => now - config.dm.cooldownAfterUserMs * 3,
    } as unknown as EventScheduler;

    const res = shouldSuppressOutreach(
      scheduler,
      config,
      'check_in',
      asChatId('signal:dm:+1'),
      undefined,
    );
    expect(res.suppressed).toBe(false);
  });

  test('exponential backoff is capped at 1 week', () => {
    const now = Date.now();
    const scheduler = {
      countRecentSends: () => 0,
      countRecentSendsForScope: () => 0,
      countRecentSendsForChat: () => 0,
      countIgnoredRecent: () => 1,
      lastSendMsForChat: () => now - 8 * 86_400_000,
    } as unknown as EventScheduler;

    const res = shouldSuppressOutreach(
      scheduler,
      config,
      'check_in',
      asChatId('signal:dm:+1'),
      undefined,
    );
    expect(res.suppressed).toBe(false);
  });
});
