import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { asChatId, asPersonId } from '../types/ids.js';
import { SqliteMemoryStore } from './sqlite.js';

describe('SqliteMemoryStore (more)', () => {
  test('supports basic CRUD and export/import roundtrip', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-mem-'));
    try {
      const db1 = path.join(tmp, 'm1.db');
      const db2 = path.join(tmp, 'm2.db');
      const store1 = new SqliteMemoryStore({ dbPath: db1 });

      const now = Date.now();
      await store1.trackPerson({
        id: asPersonId('p1'),
        displayName: 'Alice',
        channel: 'signal',
        channelUserId: 'signal:+100',
        relationshipStage: 'new',
        createdAtMs: now,
        updatedAtMs: now,
      });
      expect((await store1.getPerson('p1'))?.displayName).toBe('Alice');
      expect((await store1.getPersonByChannelId('signal:+100'))?.id).toBe(asPersonId('p1'));
      const people = await store1.searchPeople('Ali');
      expect(people.map((p) => p.id)).toContain(asPersonId('p1'));

      await store1.updateRelationshipStage('p1', 'friend');
      expect((await store1.getPerson('p1'))?.relationshipStage).toBe('friend');

      await store1.storeFact({
        personId: asPersonId('p1'),
        subject: 'Alice',
        content: 'Likes the Rockets',
        createdAtMs: now,
      });
      const facts = await store1.getFacts('Alice');
      expect(facts.length).toBe(1);
      expect(facts[0]?.content).toContain('Rockets');

      const foundFacts = await store1.searchFacts('Rockets', 10);
      expect(foundFacts.length).toBeGreaterThanOrEqual(1);

      const chatId = asChatId('signal:group:abc');
      await store1.logEpisode({
        chatId,
        content: 'USER: hey\nFRIEND: yo',
        createdAtMs: now,
      });
      const recent = await store1.getRecentEpisodes(chatId, 72);
      expect(recent.length).toBe(1);
      const eps = await store1.searchEpisodes('FRIEND', 10);
      expect(eps.length).toBeGreaterThanOrEqual(1);

      await store1.logLesson({
        category: 'silence',
        content: 'stayed quiet',
        createdAtMs: now,
      });
      const lessons = await store1.getLessons('silence');
      expect(lessons.length).toBe(1);

      const exported = await store1.exportJson();
      const store2 = new SqliteMemoryStore({ dbPath: db2 });
      await store2.importJson(exported);

      expect((await store2.getPerson('p1'))?.displayName).toBe('Alice');
      expect((await store2.getFacts('Alice')).length).toBe(1);
      expect((await store2.getRecentEpisodes(chatId, 72)).length).toBe(1);
      expect((await store2.getLessons('silence')).length).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('search does not throw on raw user text', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-mem-fts-'));
    try {
      const db = path.join(tmp, 'm.db');
      const store = new SqliteMemoryStore({ dbPath: db });
      await store.storeFact({
        subject: 'Alice',
        content: 'Likes pizza (especially "pepperoni")!',
        createdAtMs: Date.now(),
      });

      const facts = await store.searchFacts('pizza (pepperoni) OR ?', 10);
      const episodes = await store.searchEpisodes('hello (world) OR ?', 10);
      expect(Array.isArray(facts)).toBe(true);
      expect(Array.isArray(episodes)).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
