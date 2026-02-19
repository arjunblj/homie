import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import { SqliteMemoryStore } from '../memory/sqlite.js';
import { SqliteSessionStore } from '../session/sqlite.js';
import { createTestConfig, createTestIdentity } from '../testing/helpers.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { TurnEngine } from './turnEngine.js';

describe('TurnEngine memory context', () => {
  test('injects memory context as data (not system)', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-mem-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

      const cfg = createTestConfig({ projectDir: tmp, identityDir, dataDir });

      const memoryStore = new SqliteMemoryStore({
        dbPath: path.join(dataDir, 'memory.db'),
      });

      // Seed a fact so context assembly has something to inject
      await memoryStore.storeFact({
        subject: 'test-user',
        content: 'Likes TypeScript',
        createdAtMs: Date.now(),
      });

      let sawMemoryContext = false;
      const backend: LLMBackend = {
        async complete(params) {
          const all = params.messages.map((m) => `${m.role}:${m.content}`).join('\n');
          if (all.includes('MEMORY CONTEXT')) sawMemoryContext = true;
          return { text: 'yo', steps: [] };
        },
      };

      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });
      const engine = new TurnEngine({ config: cfg, backend, sessionStore, memoryStore });

      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('c'),
        messageId: asMessageId('m'),
        authorId: 'u',
        text: 'tell me about typescript',
        isGroup: false,
        isOperator: true,
        timestampMs: Date.now(),
      };

      const out = await engine.handleIncomingMessage(msg);
      expect(out.kind).toBe('send_text');
      expect(sawMemoryContext).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
