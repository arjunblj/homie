import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    skipRate: 0,
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

  test('proactive context respects overrideBuiltinRules', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-pro-override-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);
      await writeFile(path.join(identityDir, 'BEHAVIOR.md'), 'Custom behavior here.', 'utf8');

      let lastSystem: string | undefined;
      const backend: LLMBackend = {
        async complete(params) {
          lastSystem = params.messages.find((m) => m.role === 'system')?.content;
          return { text: 'HEARTBEAT_OK', steps: [] };
        },
      };

      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });
      const engine = new TurnEngine({
        config: createTestConfig({
          projectDir: tmp,
          identityDir,
          dataDir,
          overrides: {
            ...PROACTIVE_OVERRIDES,
            behavior: {
              sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
              groupMaxChars: 240,
              dmMaxChars: 420,
              minDelayMs: 0,
              maxDelayMs: 0,
              debounceMs: 0,
              overrideBuiltinRules: true,
            },
          },
        }),
        backend,
        sessionStore,
        accumulator: createNoDebounceAccumulator(),
      });

      await engine.handleProactiveEvent({
        id: 1,
        kind: 'reminder',
        subject: 'thing',
        chatId: asChatId('cli:local'),
        triggerAtMs: Date.now(),
        recurrence: null,
        delivered: false,
        createdAtMs: Date.now(),
      });

      expect(lastSystem).toContain('=== FRIEND BEHAVIOR (custom override) ===');
      expect(lastSystem).toContain('Custom behavior here.');
      expect(lastSystem).not.toContain('=== FRIEND BEHAVIOR (built-in) ===');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
