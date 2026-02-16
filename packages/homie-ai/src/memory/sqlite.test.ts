import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { asChatId, asPersonId } from '../types/ids.js';
import { SqliteMemoryStore } from './sqlite.js';

describe('SqliteMemoryStore', () => {
  test('deletes person + facts but keeps episodes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-mem-'));
    try {
      const store = new SqliteMemoryStore({ dbPath: path.join(dir, 'memory.db') });
      await store.trackPerson({
        id: asPersonId('p1'),
        displayName: 'A',
        channel: 'signal',
        channelUserId: 'u1',
        relationshipStage: 'new',
        createdAtMs: 1,
        updatedAtMs: 1,
      });
      await store.storeFact({
        personId: 'p1',
        subject: 'A',
        content: 'likes pizza',
        createdAtMs: 2,
      });
      await store.logEpisode({ chatId: asChatId('c1'), content: 'episode text', createdAtMs: 3 });

      await store.deletePerson('p1');

      expect(await store.getPerson('p1')).toBeNull();
      const facts = await store.searchFacts('pizza');
      expect(facts.length).toBe(0);

      const episodes = await store.searchEpisodes('episode');
      expect(episodes.length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
