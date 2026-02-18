import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { asChatId } from '../types/ids.js';
import { SqliteFeedbackStore } from './sqlite.js';

const readJsonArray = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch (_err) {
    return [];
  }
};

describe('SqliteFeedbackStore reconciliation', () => {
  test('keeps reactions that arrive before outgoing is registered', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-feedback-reconcile-'));
    const dbPath = path.join(tmp, 'feedback.db');
    try {
      const store = new SqliteFeedbackStore({ dbPath });
      store.recordIncomingReaction({
        channel: 'cli',
        chatId: asChatId('cli:local'),
        targetRefKey: 'cli:test',
        emoji: '👍',
        isRemove: false,
        authorId: 'u1',
        timestampMs: 2_000,
      });
      store.registerOutgoing({
        channel: 'cli',
        chatId: asChatId('cli:local'),
        refKey: 'cli:test',
        isGroup: false,
        sentAtMs: 1_000,
        text: 'hello',
        primaryChannelUserId: 'cli:u1',
      });
      store.close();

      const inspect = new Database(dbPath, { strict: true });
      const row = inspect
        .query(
          `SELECT reaction_count, negative_reaction_count, sample_reactions_json
           FROM outgoing_messages
           WHERE ref_key = ?
           LIMIT 1`,
        )
        .get('cli:test') as
        | {
            reaction_count: number;
            negative_reaction_count: number;
            sample_reactions_json: string | null;
          }
        | undefined;
      expect(row?.reaction_count).toBe(1);
      expect(row?.negative_reaction_count).toBe(0);
      expect(readJsonArray(row?.sample_reactions_json ?? null)).toEqual(['👍']);
      inspect.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('keeps explicit replies that arrive before outgoing is registered', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-feedback-reconcile-'));
    const dbPath = path.join(tmp, 'feedback.db');
    try {
      const store = new SqliteFeedbackStore({ dbPath });
      store.recordIncomingReply({
        channel: 'cli',
        chatId: asChatId('cli:local'),
        authorId: 'u1',
        text: 'ok',
        replyToRefKey: 'cli:test',
        timestampMs: 2_000,
      });
      store.registerOutgoing({
        channel: 'cli',
        chatId: asChatId('cli:local'),
        refKey: 'cli:test',
        isGroup: false,
        sentAtMs: 1_000,
        text: 'hello',
        primaryChannelUserId: 'cli:u1',
      });
      store.close();

      const inspect = new Database(dbPath, { strict: true });
      const out = inspect
        .query(
          `SELECT response_count, time_to_first_response_ms, sample_replies_json
           FROM outgoing_messages
           WHERE ref_key = ?
           LIMIT 1`,
        )
        .get('cli:test') as
        | {
            response_count: number;
            time_to_first_response_ms: number | null;
            sample_replies_json: string | null;
          }
        | undefined;
      expect(out?.response_count).toBe(1);
      expect(out?.time_to_first_response_ms).toBe(1_000);
      expect(readJsonArray(out?.sample_replies_json ?? null)).toEqual(['ok']);

      const pending = inspect.query(`SELECT COUNT(*) as c FROM pending_replies`).get() as
        | { c: number }
        | undefined;
      expect(pending?.c ?? 0).toBe(0);
      inspect.close();

      // Retries should be idempotent.
      const out2 = new SqliteFeedbackStore({ dbPath });
      out2.recordIncomingReply({
        channel: 'cli',
        chatId: asChatId('cli:local'),
        authorId: 'u1',
        text: 'ok',
        replyToRefKey: 'cli:test',
        timestampMs: 2_000,
      });
      out2.close();

      const inspect2 = new Database(dbPath, { strict: true });
      const deduped = inspect2
        .query(
          `SELECT response_count
           FROM outgoing_messages
           WHERE ref_key = ?
           LIMIT 1`,
        )
        .get('cli:test') as { response_count: number } | undefined;
      expect(deduped?.response_count).toBe(1);
      inspect2.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
