import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_BEHAVIOR, DEFAULT_PROACTIVE } from '../config/defaults.js';
import type { MemoryStore } from '../memory/store.js';
import type { PersonRecord } from '../memory/types.js';
import { asPersonId } from '../types/ids.js';
import { CheckInPlanner } from './checkinPlanner.js';
import { EventScheduler } from './scheduler.js';

describe('CheckInPlanner', () => {
  test('enqueues a check_in event for an eligible DM', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-checkin-'));
    try {
      const scheduler = new EventScheduler({ dbPath: path.join(tmp, 'proactive.db') });
      const nowMs = Date.now();
      const alice: PersonRecord = {
        id: asPersonId('person:telegram:111'),
        displayName: 'Alice',
        channel: 'telegram',
        channelUserId: 'telegram:111',
        relationshipScore: 0.9,
        createdAtMs: nowMs - 1000,
        updatedAtMs: nowMs - 1000,
      };
      const bob: PersonRecord = {
        id: asPersonId('person:telegram:222'),
        displayName: 'Bob',
        channel: 'telegram',
        channelUserId: 'telegram:222',
        relationshipScore: 0.4,
        createdAtMs: nowMs - 1000,
        updatedAtMs: nowMs - 1000,
      };
      const memoryStore = {
        async listPeople() {
          return [alice, bob];
        },
        async countEpisodes(chatId: unknown) {
          if (String(chatId) === 'tg:111') return 10;
          if (String(chatId) === 'tg:222') return 10;
          return 0;
        },
      } as unknown as MemoryStore;

      const planner = new CheckInPlanner({
        scheduler,
        proactiveConfig: { ...DEFAULT_PROACTIVE, enabled: true },
        behaviorConfig: {
          ...DEFAULT_BEHAVIOR,
          sleep: { ...DEFAULT_BEHAVIOR.sleep, enabled: false, timezone: 'UTC' },
          minDelayMs: 0,
          maxDelayMs: 0,
          debounceMs: 0,
        },
        memoryStore,
        getLastUserMessageMs: (chatId) => {
          if (String(chatId) === 'tg:111') return nowMs - 20 * 86_400_000;
          if (String(chatId) === 'tg:222') return nowMs - 3 * 86_400_000;
          return undefined;
        },
        nowMs: () => nowMs,
        random01: () => 0,
      });

      await planner.planOnce();
      const pending = scheduler.getPendingEvents(10 * 60_000);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.kind).toBe('check_in');
      expect(String(pending[0]?.chatId)).toBe('tg:111');
      scheduler.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
