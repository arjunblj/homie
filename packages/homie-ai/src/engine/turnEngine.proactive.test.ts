import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { LLMBackend } from '../backend/types.js';
import { DEFAULT_MEMORY } from '../config/defaults.js';
import type { MemoryExtractor } from '../memory/extractor.js';
import type { SessionMessage, SessionStore } from '../session/types.js';
import {
  createNoDebounceAccumulator,
  createStubMemoryStore,
  createTestConfig,
  createTestIdentity,
} from '../testing/helpers.js';
import { asChatId } from '../types/ids.js';
import { TurnEngine } from './turnEngine.js';

describe('TurnEngine proactive', () => {
  test('does not append a user message or run extractor', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-pro-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

      const appended: SessionMessage[] = [];
      const sessionStore: SessionStore = {
        appendMessage(msg) {
          appended.push(msg);
        },
        getMessages() {
          return [];
        },
        estimateTokens() {
          return 0;
        },
        async compactIfNeeded() {
          return false;
        },
      };

      const backend: LLMBackend = {
        async complete() {
          return { text: 'hey', steps: [] };
        },
      };

      const extractor: MemoryExtractor = {
        async extractAndReconcile() {
          throw new Error('should not be called');
        },
      };

      const memoryStore = createStubMemoryStore();

      const cfg = createTestConfig({
        projectDir: tmp,
        identityDir,
        dataDir,
        overrides: {
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
              maxPerWeek: 3,
              cooldownAfterUserMs: 7_200_000,
              pauseAfterIgnored: 2,
            },
          },
          memory: { ...DEFAULT_MEMORY, enabled: false },
        },
      });

      const engine = new TurnEngine({
        config: cfg,
        backend,
        sessionStore,
        memoryStore,
        extractor,
        accumulator: createNoDebounceAccumulator(),
      });

      const out = await engine.handleProactiveEvent({
        id: 1,
        kind: 'reminder',
        subject: 'thing',
        chatId: asChatId('cli:local'),
        triggerAtMs: Date.now(),
        recurrence: 'once',
        delivered: false,
        createdAtMs: Date.now(),
      });

      expect(out.kind).toBe('send_text');
      expect(appended.some((m) => m.role === 'user')).toBe(false);
      expect(appended.some((m) => m.role === 'assistant')).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
