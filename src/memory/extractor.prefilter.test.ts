import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { createMemoryExtractor } from './extractor.js';
import { SqliteMemoryStore } from './sqlite.js';

describe('memory/extractor prefilters', () => {
  test('skips extraction on low-signal phatic messages (no LLM calls)', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-extractor-prefilter-'));
    try {
      const store = new SqliteMemoryStore({ dbPath: path.join(tmp, 'memory.db') });
      let calls = 0;
      const backend: LLMBackend = {
        async complete() {
          calls += 1;
          throw new Error('should not be called');
        },
      };
      const extractor = createMemoryExtractor({ backend, store, timezone: 'UTC' });
      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('cli:local'),
        messageId: asMessageId('m_pf_1'),
        authorId: 'user',
        text: 'lol',
        isGroup: false,
        isOperator: false,
        timestampMs: Date.now(),
      };

      await extractor.extractAndReconcile({ msg, userText: msg.text, assistantText: 'nice' });
      expect(calls).toBe(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('does not skip extraction on event-shaped messages', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-extractor-prefilter-evt-'));
    try {
      const store = new SqliteMemoryStore({ dbPath: path.join(tmp, 'memory.db') });
      let calls = 0;
      const backend: LLMBackend = {
        async complete() {
          calls += 1;
          return { text: JSON.stringify({ facts: [], events: [] }), steps: [] };
        },
      };
      const extractor = createMemoryExtractor({ backend, store, timezone: 'UTC' });
      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('cli:local'),
        messageId: asMessageId('m_pf_2'),
        authorId: 'user',
        text: 'remind me tomorrow',
        isGroup: false,
        isOperator: false,
        timestampMs: Date.now(),
      };

      await extractor.extractAndReconcile({ msg, userText: msg.text, assistantText: 'ok' });
      expect(calls).toBeGreaterThan(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
