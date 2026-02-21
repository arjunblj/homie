import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import { EventScheduler } from '../proactive/scheduler.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { createMemoryExtractor } from './extractor.js';
import { SqliteMemoryStore } from './sqlite.js';

describe('memory/extractor proactive events', () => {
  test('schedules extracted events when scheduler is provided', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-extractor-pro-'));
    try {
      const store = new SqliteMemoryStore({ dbPath: path.join(tmp, 'memory.db') });
      const scheduler = new EventScheduler({ dbPath: path.join(tmp, 'proactive.db') });

      let call = 0;
      const backend: LLMBackend = {
        async complete() {
          call += 1;
          if (call === 1) {
            const nowMs = Date.now();
            return {
              text: JSON.stringify({
                facts: [],
                events: [
                  {
                    kind: 'reminder',
                    subject: 'Dentist appointment',
                    triggerAtMs: nowMs + 60_000,
                    recurrence: 'once',
                  },
                ],
              }),
              steps: [],
            };
          }
          return { text: JSON.stringify({ actions: [] }), steps: [] };
        },
      };

      const extractor = createMemoryExtractor({
        backend,
        store,
        scheduler,
        timezone: 'UTC',
      });

      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('cli:local'),
        messageId: asMessageId('m'),
        authorId: 'operator',
        text: 'I have a dentist appointment tomorrow',
        isGroup: false,
        isOperator: true,
        timestampMs: Date.now(),
      };

      await extractor.extractAndReconcile({ msg, userText: msg.text, assistantText: 'ok' });

      const pending = scheduler.getPendingEvents(5 * 60_000);
      expect(pending.some((e) => e.subject.includes('Dentist'))).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('does not schedule proactive events for group chats', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-extractor-pro-group-'));
    try {
      const store = new SqliteMemoryStore({ dbPath: path.join(tmp, 'memory.db') });
      const scheduler = new EventScheduler({ dbPath: path.join(tmp, 'proactive.db') });

      let call = 0;
      const backend: LLMBackend = {
        async complete() {
          call += 1;
          if (call === 1) {
            const nowMs = Date.now();
            return {
              text: JSON.stringify({
                facts: [],
                events: [
                  {
                    kind: 'reminder',
                    subject: 'Dentist appointment',
                    triggerAtMs: nowMs + 60_000,
                    recurrence: 'once',
                  },
                ],
              }),
              steps: [],
            };
          }
          return { text: JSON.stringify({ actions: [] }), steps: [] };
        },
      };

      const extractor = createMemoryExtractor({
        backend,
        store,
        scheduler,
        timezone: 'UTC',
      });

      const msg: IncomingMessage = {
        channel: 'telegram',
        chatId: asChatId('tg:-100123'),
        messageId: asMessageId('m'),
        authorId: 'u',
        text: 'Dentist tomorrow',
        isGroup: true,
        isOperator: false,
        timestampMs: Date.now(),
      };

      await extractor.extractAndReconcile({ msg, userText: msg.text, assistantText: 'ok' });

      const pending = scheduler.getPendingEvents(5 * 60_000);
      expect(pending.length).toBe(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('schedules anticipated event and follow-up 24h later when followUp is true', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-extractor-anticipated-'));
    try {
      const store = new SqliteMemoryStore({ dbPath: path.join(tmp, 'memory.db') });
      const scheduler = new EventScheduler({ dbPath: path.join(tmp, 'proactive.db') });

      const nowMs = Date.now();
      const triggerAtMs = nowMs + 2 * 60 * 60_000; // 2h from now
      const followUpMs = triggerAtMs + 24 * 60 * 60_000; // 24h after trigger

      const backend: LLMBackend = {
        async complete() {
          return {
            text: JSON.stringify({
              facts: [],
              events: [
                {
                  kind: 'anticipated',
                  subject: 'Job interview at Acme',
                  triggerAtMs,
                  recurrence: 'once',
                  followUp: true,
                },
              ],
            }),
            steps: [],
          };
        },
      };

      const extractor = createMemoryExtractor({
        backend,
        store,
        scheduler,
        timezone: 'UTC',
      });

      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('cli:local'),
        messageId: asMessageId('m'),
        authorId: 'operator',
        text: 'I have a job interview at Acme next Tuesday',
        isGroup: false,
        isOperator: true,
        timestampMs: nowMs,
      };

      await extractor.extractAndReconcile({ msg, userText: msg.text, assistantText: 'ok' });

      const pending = scheduler.getPendingEvents(366 * 24 * 60 * 60_000);
      const anticipated = pending.find((e) => e.subject === 'Job interview at Acme');
      const followUp = pending.find(
        (e) => e.kind === 'follow_up' && e.subject === 'Follow up: Job interview at Acme',
      );

      expect(anticipated).toBeDefined();
      expect(anticipated?.triggerAtMs).toBe(triggerAtMs);
      expect(anticipated?.kind).toBe('anticipated');

      expect(followUp).toBeDefined();
      expect(followUp?.triggerAtMs).toBe(followUpMs);
      expect(followUp?.kind).toBe('follow_up');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
