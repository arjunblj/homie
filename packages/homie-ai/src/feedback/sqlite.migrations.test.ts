import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { asChatId } from '../types/ids.js';
import { FEEDBACK_MIGRATIONS, SqliteFeedbackStore } from './sqlite.js';

describe('SqliteFeedbackStore migrations', () => {
  test('upgrades v1 db to include reaction/reply tables', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-feedback-mig-'));
    const dbPath = path.join(tmp, 'feedback.db');
    try {
      // Simulate an existing v1 database (outgoing_messages only).
      const db = new Database(dbPath, { strict: true });
      db.exec(FEEDBACK_MIGRATIONS[0]);
      db.exec('PRAGMA user_version = 1;');
      db.close();

      const store = new SqliteFeedbackStore({ dbPath });
      store.registerOutgoing({
        channel: 'cli',
        chatId: asChatId('cli:local'),
        refKey: 'cli:test',
        isGroup: false,
        sentAtMs: Date.now(),
        text: 'hello',
        primaryChannelUserId: 'cli:operator',
      });
      store.recordIncomingReply({
        channel: 'cli',
        chatId: asChatId('cli:local'),
        authorId: 'operator',
        text: 'ok',
        timestampMs: Date.now(),
      });
      store.recordIncomingReaction({
        channel: 'cli',
        chatId: asChatId('cli:local'),
        targetRefKey: 'cli:test',
        emoji: '👍',
        isRemove: false,
        authorId: 'operator',
        timestampMs: Date.now(),
      });
      store.close();

      const inspect = new Database(dbPath, { strict: true });
      const tables = inspect
        .query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain('outgoing_messages');
      expect(names).toContain('outgoing_reactions');
      expect(names).toContain('outgoing_replies');

      const indexes = inspect
        .query(`SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name`)
        .all() as Array<{ name: string }>;
      const idx = indexes.map((i) => i.name);
      expect(idx).toContain('idx_outgoing_reactions_active');
      expect(idx).toContain('idx_outgoing_reactions_uniq');
      expect(idx).toContain('idx_outgoing_replies_outgoing');
      inspect.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
