import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
        relationshipScore: 0,
        createdAtMs: now,
        updatedAtMs: now,
      });
      expect((await store1.getPerson('p1'))?.displayName).toBe('Alice');
      expect((await store1.getPersonByChannelId('signal:+100'))?.id).toBe(asPersonId('p1'));
      const people = await store1.searchPeople('Ali');
      expect(people.map((p) => p.id)).toContain(asPersonId('p1'));

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

  test('dirty flags coalesce and can be claimed', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-mem-dirty-'));
    try {
      const db = path.join(tmp, 'm.db');
      const store = new SqliteMemoryStore({ dbPath: db });

      const now = Date.now();
      const chatId = asChatId('signal:group:dirty');
      const personId = asPersonId('p_dirty');

      await store.logEpisode({
        chatId,
        personId,
        isGroup: true,
        content: 'USER: hi\nFRIEND: yo',
        createdAtMs: now,
      });

      const dirtyChats = await store.claimDirtyGroupCapsules(10);
      expect(dirtyChats).toEqual([chatId]);
      expect(await store.claimDirtyGroupCapsules(10)).toEqual([]);
      await store.completeDirtyGroupCapsule(chatId);
      expect(await store.claimDirtyGroupCapsules(10)).toEqual([]);

      const dirtyPeople = await store.claimDirtyPublicStyles(10);
      expect(dirtyPeople).toEqual([personId]);
      expect(await store.claimDirtyPublicStyles(10)).toEqual([]);
      await store.completeDirtyPublicStyle(personId);
      expect(await store.claimDirtyPublicStyles(10)).toEqual([]);

      const recent = await store.getRecentEpisodes(chatId, 72);
      expect(recent[0]?.personId).toBe(personId);
      expect(recent[0]?.isGroup).toBe(true);
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

  test('md-mirror uses collision-resistant filenames for people', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-mem-md-mirror-'));
    try {
      const dataDir = path.join(tmp, 'data');
      const dbPath = path.join(dataDir, 'memory.db');
      const store = new SqliteMemoryStore({ dbPath });

      const now = Date.now();
      const p1 = asPersonId('person:abc');
      const p2 = asPersonId('person/abc'); // Legacy stem collides with person:abc

      await store.trackPerson({
        id: p1,
        displayName: 'A',
        channel: 'signal',
        channelUserId: 'signal:+1',
        relationshipScore: 0,
        createdAtMs: now,
        updatedAtMs: now,
      });
      await store.trackPerson({
        id: p2,
        displayName: 'B',
        channel: 'signal',
        channelUserId: 'signal:+2',
        relationshipScore: 0,
        createdAtMs: now,
        updatedAtMs: now,
      });

      await store.updatePersonCapsule(p1, 'caps1');
      await store.updatePersonCapsule(p2, 'caps2');

      const peopleDir = path.join(dataDir, 'md', 'people');
      const files = (await readdir(peopleDir)).filter((f) => f.endsWith('.md'));
      expect(files.length).toBe(2);

      const contents = await Promise.all(
        files.map((f) => readFile(path.join(peopleDir, f), 'utf8')),
      );
      expect(contents.some((c) => c.includes('id: person:abc'))).toBe(true);
      expect(contents.some((c) => c.includes('id: person/abc'))).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('md-mirror migrates legacy filenames and preserves notes', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-mem-md-mirror-legacy-'));
    try {
      const dataDir = path.join(tmp, 'data');
      const dbPath = path.join(dataDir, 'memory.db');
      const store = new SqliteMemoryStore({ dbPath });

      const now = Date.now();
      const personId = asPersonId('person:abc');
      await store.trackPerson({
        id: personId,
        displayName: 'Alice',
        channel: 'signal',
        channelUserId: 'signal:+1',
        relationshipScore: 0,
        createdAtMs: now,
        updatedAtMs: now,
      });

      const legacyPeopleDir = path.join(dataDir, 'md', 'people');
      await mkdir(legacyPeopleDir, { recursive: true });
      const legacyPath = path.join(legacyPeopleDir, 'person_abc.md');
      await writeFile(
        legacyPath,
        ['# Alice', '', '## Notes', 'human note', '', '## Capsule', '(empty)', ''].join('\n'),
        'utf8',
      );

      await store.updatePersonCapsule(personId, 'auto capsule');

      const files = (await readdir(legacyPeopleDir)).filter((f) => f.endsWith('.md'));
      expect(files).not.toContain('person_abc.md');

      const contents = await Promise.all(
        files.map((f) => readFile(path.join(legacyPeopleDir, f), 'utf8')),
      );
      const migrated = contents.find((c) => c.includes('id: person:abc'));
      expect(migrated).toBeTruthy();
      expect(migrated ?? '').toContain('human note');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
