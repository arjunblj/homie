import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import { asChatId, asMessageId, asPersonId } from '../types/ids.js';
import { createMemoryExtractor } from './extractor.js';
import { SqliteMemoryStore } from './sqlite.js';

describe('memory/extractor soft-delete', () => {
  test('reconciliation delete marks facts as not current instead of hard-deleting', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-extractor-soft-delete-'));
    try {
      const store = new SqliteMemoryStore({ dbPath: path.join(tmp, 'memory.db') });
      const personId = asPersonId('person:cli:user');
      await store.trackPerson({
        id: personId,
        displayName: 'User',
        channel: 'cli',
        channelUserId: 'cli:user',
        relationshipScore: 0.5,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      await store.storeFact({
        personId,
        subject: 'User',
        content: 'Lives in SF',
        category: 'personal',
        evidenceQuote: 'I live in SF',
        createdAtMs: Date.now(),
      });

      const backend: LLMBackend = {
        async complete(params) {
          const sys = params.messages.find((m) => m.role === 'system')?.content ?? '';
          if (sys.includes('extract structured memories')) {
            return {
              text: JSON.stringify({
                facts: [
                  {
                    content: 'Lives in NYC',
                    category: 'personal',
                    factType: 'factual',
                    temporalScope: 'current',
                    evidenceQuote: 'I live in NYC',
                  },
                ],
                events: [],
              }),
              steps: [],
            };
          }
          if (sys.includes('reconcile newly extracted facts')) {
            return {
              text: JSON.stringify({
                actions: [
                  { type: 'delete', existingIdx: 0, content: 'Lives in SF' },
                  { type: 'add', content: 'Lives in NYC' },
                ],
              }),
              steps: [],
            };
          }
          if (sys.includes('You verify whether extracted facts are actually supported')) {
            return {
              text: JSON.stringify({
                verified: [{ content: 'Lives in NYC', supported: true, reason: 'verbatim' }],
              }),
              steps: [],
            };
          }
          throw new Error(`unexpected system prompt: ${sys.slice(0, 60)}`);
        },
      };

      const extractor = createMemoryExtractor({ backend, store, timezone: 'UTC' });
      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('cli:local'),
        messageId: asMessageId('m_sd'),
        authorId: 'user',
        text: 'I live in NYC',
        isGroup: false,
        isOperator: false,
        timestampMs: Date.now(),
      };

      await extractor.extractAndReconcile({ msg, userText: msg.text, assistantText: 'ok' });

      const currentFacts = await store.getFactsForPerson(personId, 50);
      expect(currentFacts.map((f) => f.content)).toEqual(['Lives in NYC']);

      const exported = (await store.exportJson()) as {
        facts: Array<{ subject: string; content: string; is_current: number }>;
      };
      const factRows = exported.facts.filter((f) => f.subject === 'User');
      expect(factRows.length).toBe(2);
      const isCurr = new Map(factRows.map((f) => [String(f.content), Number(f.is_current)]));
      expect(isCurr.get('Lives in SF')).toBe(0);
      expect(isCurr.get('Lives in NYC')).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
