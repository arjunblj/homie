import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { asChatId, asPersonId } from '../types/ids.js';
import { SqliteMemoryStore } from './sqlite.js';

describe('SqliteMemoryStore', () => {
  test('deleting person cascades facts, episodes, lessons, and vector rows', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-mem-'));
    try {
      const personId = asPersonId('p1');
      const store = new SqliteMemoryStore({
        dbPath: path.join(dir, 'memory.db'),
        embedder: {
          dims: 4,
          embed: async (input) => new Float32Array([input.length, 1, 0, 0]),
          embedBatch: async (inputs) =>
            inputs.map((input) => new Float32Array([input.length, 1, 0, 0])),
        },
      });
      await store.trackPerson({
        id: personId,
        displayName: 'A',
        channel: 'signal',
        channelUserId: 'u1',
        relationshipScore: 0,
        createdAtMs: 1,
        updatedAtMs: 1,
      });
      await store.storeFact({
        personId,
        subject: 'A',
        content: 'likes pizza',
        createdAtMs: 2,
      });
      await store.logEpisode({
        chatId: asChatId('c1'),
        personId,
        content: 'episode text',
        createdAtMs: 3,
      });
      await store.logLesson({
        category: 'preference',
        content: 'likes pizza',
        personId,
        createdAtMs: 4,
      });

      const internal = store as unknown as {
        db: { query: (sql: string) => { all: (...args: unknown[]) => unknown[] } };
      };
      const factIds = (
        internal.db
          .query('SELECT id FROM facts WHERE person_id = ?')
          .all(String(personId)) as Array<{ id: number }>
      ).map((r) => r.id);
      const episodeIds = (
        internal.db
          .query('SELECT id FROM episodes WHERE person_id = ?')
          .all(String(personId)) as Array<{ id: number }>
      ).map((r) => r.id);

      await store.deletePerson(String(personId));

      expect(await store.getPerson(String(personId))).toBeNull();
      expect(await store.getFactsForPerson(personId)).toEqual([]);
      expect(await store.getLessons('preference')).toEqual([]);
      const remainingEpisodes = internal.db
        .query('SELECT COUNT(*) AS c FROM episodes WHERE person_id = ?')
        .all(String(personId)) as Array<{ c: number }>;
      expect(remainingEpisodes[0]?.c ?? 0).toBe(0);

      const hasFactsVec =
        (
          internal.db
            .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'facts_vec'`)
            .all() as Array<{ name?: string }>
        ).length > 0;
      const hasEpisodesVec =
        (
          internal.db
            .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'episodes_vec'`)
            .all() as Array<{ name?: string }>
        ).length > 0;
      if (hasFactsVec && factIds.length > 0) {
        const placeholders = factIds.map(() => '?').join(', ');
        const rows = internal.db
          .query(`SELECT COUNT(*) AS c FROM facts_vec WHERE fact_id IN (${placeholders})`)
          .all(...factIds) as Array<{ c: number }>;
        expect(rows[0]?.c ?? 0).toBe(0);
      }
      if (hasEpisodesVec && episodeIds.length > 0) {
        const placeholders = episodeIds.map(() => '?').join(', ');
        const rows = internal.db
          .query(`SELECT COUNT(*) AS c FROM episodes_vec WHERE episode_id IN (${placeholders})`)
          .all(...episodeIds) as Array<{ c: number }>;
        expect(rows[0]?.c ?? 0).toBe(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
