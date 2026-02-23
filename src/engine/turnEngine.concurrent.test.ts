import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IncomingMessage } from '../agent/types.js';
import { type LLMBackend, llmContentToText } from '../backend/types.js';
import { DEFAULT_ENGINE, DEFAULT_MEMORY } from '../config/defaults.js';
import { SqliteSessionStore } from '../session/sqlite.js';
import {
  createNoDebounceAccumulator,
  createTestConfig,
  createTestIdentity,
} from '../testing/helpers.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { TurnEngine } from './turnEngine.js';

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve: resolve ?? (() => {}) };
};

describe('TurnEngine concurrency', () => {
  test('serializes turns per chatId but allows concurrency across chats', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-concurrent-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

      const cfg = createTestConfig({
        projectDir: tmp,
        identityDir,
        dataDir,
        overrides: {
          behavior: {
            sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
            groupMaxChars: 240,
            dmMaxChars: 420,
            minDelayMs: 0,
            maxDelayMs: 0,
            debounceMs: 0,
            overrideBuiltinRules: false,
          },
          engine: {
            ...DEFAULT_ENGINE,
            limiter: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
            perChatLimiter: {
              ...DEFAULT_ENGINE.perChatLimiter,
              capacity: 1_000_000,
              refillPerSecond: 1_000_000,
            },
            generation: {
              ...DEFAULT_ENGINE.generation,
              reactiveMaxSteps: 1,
              maxRegens: 0,
            },
          },
          memory: {
            ...DEFAULT_MEMORY,
            enabled: false,
            consolidation: { ...DEFAULT_MEMORY.consolidation, enabled: false },
            feedback: { ...DEFAULT_MEMORY.feedback, enabled: false },
          },
        },
      });

      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });

      const inFlightByChat = new Map<string, number>();
      const maxInFlightByChat = new Map<string, number>();
      let globalInFlight = 0;
      let globalMax = 0;

      const enteredFirst = new Map<string, Deferred>();
      const releaseFirst = new Map<string, Deferred>();
      const callCount = new Map<string, number>();

      const backend: LLMBackend = {
        async complete(params) {
          const lastUser = llmContentToText(
            [...params.messages].reverse().find((m) => m.role === 'user')?.content ?? '',
          );
          const m = /chat:([a-z0-9_-]+)/iu.exec(lastUser);
          const chatLabel = m?.[1] ?? 'unknown';

          const calls = (callCount.get(chatLabel) ?? 0) + 1;
          callCount.set(chatLabel, calls);

          const nextInFlight = (inFlightByChat.get(chatLabel) ?? 0) + 1;
          inFlightByChat.set(chatLabel, nextInFlight);
          maxInFlightByChat.set(
            chatLabel,
            Math.max(maxInFlightByChat.get(chatLabel) ?? 0, nextInFlight),
          );

          globalInFlight += 1;
          globalMax = Math.max(globalMax, globalInFlight);

          if (nextInFlight > 1) {
            throw new Error(`concurrent backend.complete for chat:${chatLabel}`);
          }

          // Hold the first completion for each chat so we can start a second turn while it's in-flight.
          if (calls === 1) {
            enteredFirst.get(chatLabel)?.resolve();
            await (releaseFirst.get(chatLabel)?.promise ?? Promise.resolve());
          } else {
            // Small delay to create observable overlap across chats.
            await new Promise((r) => setTimeout(r, 5));
          }

          globalInFlight -= 1;
          inFlightByChat.set(chatLabel, (inFlightByChat.get(chatLabel) ?? 1) - 1);
          return { text: `ok:${chatLabel}:${calls}`, steps: [] };
        },
      };

      const engine = new TurnEngine({
        config: cfg,
        backend,
        sessionStore,
        accumulator: createNoDebounceAccumulator(),
      });

      const chats = ['a', 'b', 'c'] as const;
      for (const c of chats) {
        enteredFirst.set(c, deferred());
        releaseFirst.set(c, deferred());
      }

      const firstWave = chats.map((c) =>
        engine.handleIncomingMessage({
          channel: 'cli',
          chatId: asChatId(`cli:${c}`),
          messageId: asMessageId(`cli:${c}:1`),
          authorId: 'operator',
          text: `chat:${c} first`,
          isGroup: false,
          isOperator: true,
          timestampMs: 1_000_000,
        } satisfies IncomingMessage),
      );

      // Wait until each chat has entered its first backend.complete call.
      await Promise.all(chats.map((c) => enteredFirst.get(c)?.promise ?? Promise.resolve()));

      const secondWave = chats.map((c) =>
        engine.handleIncomingMessage({
          channel: 'cli',
          chatId: asChatId(`cli:${c}`),
          messageId: asMessageId(`cli:${c}:2`),
          authorId: 'operator',
          text: `chat:${c} second`,
          isGroup: false,
          isOperator: true,
          timestampMs: 1_000_001,
        } satisfies IncomingMessage),
      );

      // Release all first-wave calls.
      for (const c of chats) {
        releaseFirst.get(c)?.resolve();
      }

      await Promise.all([...firstWave, ...secondWave]);

      // Per-chat serialization: never more than one in-flight completion per chat.
      for (const c of chats) {
        expect(maxInFlightByChat.get(c)).toBe(1);
        expect(callCount.get(c)).toBe(2);
      }

      // Cross-chat concurrency should happen (otherwise lock became global / limiter serialized everything).
      expect(globalMax).toBeGreaterThan(1);
      sessionStore.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
