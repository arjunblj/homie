import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { asChatId } from '../types/ids.js';
import { SqliteSessionStore } from './sqlite.js';

describe('SqliteSessionStore', () => {
  test('roundtrips author metadata for user messages', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-sessions-authors-'));
    try {
      const dbPath = path.join(dir, 'session.db');
      const store = new SqliteSessionStore({ dbPath });
      const chatId = asChatId('c1');
      const now = Date.now();

      store.appendMessage({
        chatId,
        role: 'user',
        content: 'hello',
        createdAtMs: now,
        authorId: 'u1',
        authorDisplayName: 'Arjun',
        sourceMessageId: 'telegram:123',
        mentioned: true,
        isGroup: true,
      });

      const msgs = store.getMessages(chatId, 10);
      expect(msgs.length).toBe(1);
      expect(msgs[0]?.role).toBe('user');
      expect(msgs[0]?.authorId).toBe('u1');
      expect(msgs[0]?.authorDisplayName).toBe('Arjun');
      expect(msgs[0]?.sourceMessageId).toBe('telegram:123');
      expect(msgs[0]?.mentioned).toBe(true);
      expect(msgs[0]?.isGroup).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('compacts and injects persona reminder', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-sessions-'));
    try {
      const dbPath = path.join(dir, 'session.db');
      const store = new SqliteSessionStore({ dbPath });
      const chatId = asChatId('c1');

      for (let i = 0; i < 50; i += 1) {
        store.appendMessage({
          chatId,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `message ${i} ${'x'.repeat(40)}`,
          createdAtMs: Date.now() + i,
        });
      }

      const did = await store.compactIfNeeded({
        chatId,
        maxTokens: 200,
        personaReminder: 'Traits: dry',
        summarize: async () => 'summary',
      });
      expect(did).toBe(true);

      const msgs = store.getMessages(chatId, 500);
      const all = msgs.map((m) => m.content).join('\n');
      expect(all).toContain('=== CONVERSATION SUMMARY ===');
      expect(all).toContain('=== PERSONA REMINDER ===');
      expect(all).toContain('Traits: dry');

      // Smoke coverage for the estimateTokens helper.
      expect(store.estimateTokens(chatId)).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
