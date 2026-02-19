import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import { DEFAULT_MEMORY } from '../config/defaults.js';
import { SqliteSessionStore } from '../session/sqlite.js';
import { createNoDebounceAccumulator, createTestConfig, createTestIdentity } from '../testing/helpers.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { TurnEngine } from './turnEngine.js';

describe('TurnEngine engagement gate + stale discard', () => {
  test('group gate can silence without calling default model', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-gate-silence-'));
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
        overrides: { memory: { ...DEFAULT_MEMORY, enabled: false } },
      });
      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });

      let defaultCalls = 0;
      let fastCalls = 0;
      const backend: LLMBackend = {
        async complete(params) {
          if (params.role === 'default') defaultCalls += 1;
          if (params.role === 'fast') fastCalls += 1;
          if (params.role === 'fast') return { text: '{"action":"silence"}', steps: [] };
          return { text: 'yo', steps: [] };
        },
      };

      const engine = new TurnEngine({
        config: cfg,
        backend,
        sessionStore,
        accumulator: createNoDebounceAccumulator(),
      });
      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('cli:group'),
        messageId: asMessageId('m1'),
        authorId: 'u1',
        authorDisplayName: 'Alice',
        text: 'lol',
        isGroup: true,
        isOperator: true,
        mentioned: false,
        timestampMs: Date.now(),
      };

      const out = await engine.handleIncomingMessage(msg);
      expect(out.kind).toBe('silence');
      expect(fastCalls).toBe(0);
      expect(defaultCalls).toBe(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('stale discard drops send/reaction when newer message arrives mid-run', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-stale-'));
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
        overrides: { memory: { ...DEFAULT_MEMORY, enabled: false } },
      });
      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });

      let allowDefaultResolve: (() => void) | undefined;
      const defaultGate = new Promise<void>((r) => {
        allowDefaultResolve = r;
      });

      const backend: LLMBackend = {
        async complete(params) {
          if (params.role === 'fast') return { text: '{"action":"send"}', steps: [] };
          if (params.role === 'default') {
            await defaultGate;
            return { text: 'yo', steps: [] };
          }
          return { text: 'yo', steps: [] };
        },
      };

      const engine = new TurnEngine({
        config: cfg,
        backend,
        sessionStore,
        accumulator: createNoDebounceAccumulator(),
      });
      const chatId = asChatId('cli:group');
      const base: Omit<IncomingMessage, 'messageId' | 'text' | 'timestampMs'> = {
        channel: 'cli',
        chatId,
        authorId: 'u1',
        authorDisplayName: 'Alice',
        isGroup: true,
        isOperator: true,
        mentioned: true,
      };

      const p1 = engine.handleIncomingMessage({
        ...base,
        messageId: asMessageId('m1'),
        text: 'first',
        timestampMs: Date.now(),
      });

      // Ensure the first turn is in-flight (blocked inside default completion).
      await new Promise((r) => setTimeout(r, 5));

      const p2 = engine.handleIncomingMessage({
        ...base,
        messageId: asMessageId('m2'),
        text: 'second',
        timestampMs: Date.now() + 1,
      });

      allowDefaultResolve?.();

      const out1 = await p1;
      expect(out1.kind).toBe('silence');
      expect(out1.kind === 'silence' ? out1.reason : '').toContain('stale');

      const out2 = await p2;
      // We don't care what the second does here; it just shouldn't break.
      expect(out2.kind).toBeTruthy();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
