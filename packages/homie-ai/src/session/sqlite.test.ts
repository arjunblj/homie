import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { asChatId } from '../types/ids.js';
import { SqliteSessionStore } from './sqlite.js';

describe('SqliteSessionStore', () => {
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
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
