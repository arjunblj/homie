import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { createMemoryExtractor } from './extractor.js';
import { SqliteMemoryStore } from './sqlite.js';

describe('memory/extractor evidence grounding', () => {
  test('drops extracted facts when evidenceQuote is not verbatim user text', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-extractor-evidence-'));
    try {
      const store = new SqliteMemoryStore({ dbPath: path.join(tmp, 'memory.db') });
      const backend: LLMBackend = {
        async complete() {
          return {
            text: JSON.stringify({
              facts: [
                {
                  content: 'Likes ramen',
                  category: 'preference',
                  evidenceQuote: 'I am obsessed with ramen',
                },
              ],
              events: [],
            }),
            steps: [],
          };
        },
      };
      const extractor = createMemoryExtractor({
        backend,
        store,
        timezone: 'UTC',
      });
      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('cli:local'),
        messageId: asMessageId('m1'),
        authorId: 'user',
        text: 'I like pizza and tacos',
        isGroup: false,
        isOperator: false,
        timestampMs: Date.now(),
      };

      await extractor.extractAndReconcile({ msg, userText: msg.text, assistantText: 'nice' });
      const facts = await store.searchFacts('ramen', 10);
      expect(facts.length).toBe(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('keeps extracted facts when evidenceQuote is verbatim', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-extractor-evidence-ok-'));
    try {
      const store = new SqliteMemoryStore({ dbPath: path.join(tmp, 'memory.db') });
      const backend: LLMBackend = {
        async complete() {
          return {
            text: JSON.stringify({
              facts: [
                {
                  content: 'Likes pizza',
                  category: 'preference',
                  evidenceQuote: 'I like pizza',
                },
              ],
              events: [],
            }),
            steps: [],
          };
        },
      };
      const extractor = createMemoryExtractor({
        backend,
        store,
        timezone: 'UTC',
      });
      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('cli:local'),
        messageId: asMessageId('m2'),
        authorId: 'user',
        text: 'I like pizza and tacos',
        isGroup: false,
        isOperator: false,
        timestampMs: Date.now(),
      };

      await extractor.extractAndReconcile({ msg, userText: msg.text, assistantText: 'nice' });
      const facts = await store.searchFacts('pizza', 10);
      expect(facts.some((f) => f.content.includes('Likes pizza'))).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('keeps extracted facts when evidenceQuote differs only by whitespace', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-extractor-evidence-ws-'));
    try {
      const store = new SqliteMemoryStore({ dbPath: path.join(tmp, 'memory.db') });
      const backend: LLMBackend = {
        async complete() {
          return {
            text: JSON.stringify({
              facts: [
                {
                  content: 'Likes pizza',
                  category: 'preference',
                  evidenceQuote: 'I like\npizza',
                },
              ],
              events: [],
            }),
            steps: [],
          };
        },
      };
      const extractor = createMemoryExtractor({
        backend,
        store,
        timezone: 'UTC',
      });
      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('cli:local'),
        messageId: asMessageId('m_ws'),
        authorId: 'user',
        text: 'I like pizza and tacos',
        isGroup: false,
        isOperator: false,
        timestampMs: Date.now(),
      };

      await extractor.extractAndReconcile({ msg, userText: msg.text, assistantText: 'nice' });
      const facts = await store.searchFacts('pizza', 10);
      expect(facts.some((f) => f.content.includes('Likes pizza'))).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
