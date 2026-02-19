import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { LLMBackend } from '../backend/types.js';
import type { PersonRecord } from '../memory/types.js';
import { SqliteSessionStore } from '../session/sqlite.js';
import {
  createNoDebounceAccumulator,
  createStubMemoryStore,
  createTestConfig,
  createTestIdentity,
} from '../testing/helpers.js';
import { asChatId, asPersonId } from '../types/ids.js';
import { TurnEngine } from './turnEngine.js';

const PROACTIVE_OVERRIDES = {
  proactive: {
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
  },
} as const;

describe('TurnEngine proactive gating', () => {
  test('suppresses non-reminder outreach for new relationship stage', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-pro-gate-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

      const backend: LLMBackend = {
        async complete() {
          return { text: 'hello', steps: [] };
        },
      };

      const memoryStore = createStubMemoryStore({
        getPersonByChannelIdResult: {
          id: asPersonId('person:x'),
          displayName: 'x',
          channel: 'signal',
          channelUserId: 'signal:+1',
          relationshipScore: 0,
          createdAtMs: 1,
          updatedAtMs: 1,
        } satisfies PersonRecord,
      });

      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });
      const engine = new TurnEngine({
        config: createTestConfig({
          projectDir: tmp,
          identityDir,
          dataDir,
          overrides: PROACTIVE_OVERRIDES,
        }),
        backend,
        sessionStore,
        memoryStore,
        accumulator: createNoDebounceAccumulator(),
        slopDetector: { check: () => ({ isSlop: false, reasons: [] }) },
      });

      const out = await engine.handleProactiveEvent({
        id: 1,
        kind: 'check_in',
        subject: 'hey',
        chatId: asChatId('signal:dm:+1'),
        triggerAtMs: Date.now(),
        recurrence: null,
        delivered: false,
        createdAtMs: Date.now(),
      });

      expect(out.kind).toBe('silence');
      if (out.kind !== 'silence') throw new Error('Expected silence');
      expect(out.reason).toBe('proactive_safe_mode');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('treats HEARTBEAT_OK as silence', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-pro-heartbeat-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

      const backend: LLMBackend = {
        async complete() {
          return { text: 'HEARTBEAT_OK', steps: [] };
        },
      };

      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });
      const engine = new TurnEngine({
        config: createTestConfig({
          projectDir: tmp,
          identityDir,
          dataDir,
          overrides: PROACTIVE_OVERRIDES,
        }),
        backend,
        sessionStore,
        accumulator: createNoDebounceAccumulator(),
        slopDetector: { check: () => ({ isSlop: false, reasons: [] }) },
      });

      const out = await engine.handleProactiveEvent({
        id: 1,
        kind: 'reminder',
        subject: 'thing',
        chatId: asChatId('cli:local'),
        triggerAtMs: Date.now(),
        recurrence: null,
        delivered: false,
        createdAtMs: Date.now(),
      });

      expect(out.kind).toBe('silence');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
