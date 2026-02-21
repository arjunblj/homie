import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import { SqliteMemoryStore } from '../memory/sqlite.js';
import { SqliteSessionStore } from '../session/sqlite.js';
import {
  createNoDebounceAccumulator,
  createTestConfig,
  createTestIdentity,
} from '../testing/helpers.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { TurnEngine } from './turnEngine.js';

describe('TurnEngine behavior paths', () => {
  test('supports group reactions via BehaviorEngine decision', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-react-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

      const backend: LLMBackend = {
        async complete(params) {
          if (params.role === 'fast') {
            return { text: '{"action":"react","emoji":"🔥"}', steps: [] };
          }
          return { text: 'lol', steps: [] };
        },
      };

      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });
      const engine = new TurnEngine({
        config: createTestConfig({ projectDir: tmp, identityDir, dataDir }),
        backend,
        sessionStore,
        accumulator: createNoDebounceAccumulator(),
      });

      const msg: IncomingMessage = {
        channel: 'signal',
        chatId: asChatId('g'),
        messageId: asMessageId('m'),
        authorId: '+1',
        text: 'thats wild',
        isGroup: true,
        isOperator: false,
        timestampMs: 1,
      };

      const out = await engine.handleIncomingMessage(msg);
      expect(out.kind).toBe('react');
      if (out.kind !== 'react') throw new Error('Expected react');
      expect(out.emoji).toBe('🔥');

      const hist = sessionStore.getMessages(msg.chatId, 10);
      expect(hist.some((m) => m.content.includes('[REACTION]'))).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('runs slop regen loop and returns regenerated text', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-slop-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

      const backend: LLMBackend = {
        async complete(params) {
          const sys = params.messages.find((m) => m.role === 'system')?.content ?? '';
          if (sys.includes('Rewrite the reply')) return { text: 'yo', steps: [] };
          return { text: "I'd be happy to help with that!", steps: [] };
        },
      };

      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });
      const engine = new TurnEngine({
        config: createTestConfig({ projectDir: tmp, identityDir, dataDir }),
        backend,
        sessionStore,
        accumulator: createNoDebounceAccumulator(),
      });

      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('c'),
        messageId: asMessageId('m'),
        authorId: 'u',
        text: 'hi',
        isGroup: false,
        isOperator: true,
        timestampMs: Date.now(),
      };

      const out = await engine.handleIncomingMessage(msg);
      expect(out).toEqual({ kind: 'send_text', text: 'yo' });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('does not persist extractor errors as lessons', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-memerr-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

      const backend: LLMBackend = {
        async complete() {
          return { text: 'yo', steps: [] };
        },
      };

      const extractor = {
        async extractAndReconcile(): Promise<void> {
          throw new Error('boom');
        },
      };

      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });
      const memoryStore = new SqliteMemoryStore({ dbPath: path.join(dataDir, 'memory.db') });
      const engine = new TurnEngine({
        config: createTestConfig({ projectDir: tmp, identityDir, dataDir }),
        backend,
        sessionStore,
        memoryStore,
        extractor,
        accumulator: createNoDebounceAccumulator(),
      });

      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('c'),
        messageId: asMessageId('m'),
        authorId: 'u',
        text: 'hi',
        isGroup: false,
        isOperator: true,
        timestampMs: Date.now(),
      };

      const out = await engine.handleIncomingMessage(msg);
      expect(out.kind).toBe('send_text');

      const lessons = await memoryStore.getLessons('memory_extraction_error');
      expect(lessons.length).toBe(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
