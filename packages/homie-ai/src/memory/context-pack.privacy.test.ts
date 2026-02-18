import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { asChatId, asPersonId } from '../types/ids.js';
import { assembleMemoryContext } from './context-pack.js';
import { SqliteMemoryStore } from './sqlite.js';

describe('assembleMemoryContext privacy', () => {
  test('does not leak other people facts/lessons in DMs', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-mem-scope-'));
    let store: SqliteMemoryStore | undefined;
    try {
      store = new SqliteMemoryStore({ dbPath: path.join(tmp, 'memory.db') });
      const chatId = asChatId('tg:1');

      const aliceId = asPersonId('p_alice');
      const bobId = asPersonId('p_bob');

      await store.trackPerson({
        id: aliceId,
        displayName: 'Alice',
        channel: 'telegram',
        channelUserId: 'telegram:1',
        relationshipStage: 'friend',
        capsule: 'Alice capsule',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      await store.trackPerson({
        id: bobId,
        displayName: 'Bob',
        channel: 'telegram',
        channelUserId: 'telegram:2',
        relationshipStage: 'friend',
        capsule: 'Bob capsule',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });

      await store.storeFact({
        personId: aliceId,
        subject: 'food',
        content: 'Likes sushi',
        createdAtMs: Date.now(),
      });
      await store.storeFact({
        personId: bobId,
        subject: 'food',
        content: 'Hates sushi',
        createdAtMs: Date.now(),
      });

      await store.logLesson({
        category: 'behavioral_feedback',
        content: 'Prefer short replies',
        rule: 'Keep replies short and warm',
        personId: aliceId,
        createdAtMs: Date.now(),
      });
      await store.logLesson({
        category: 'behavioral_feedback',
        content: 'Be rude',
        rule: 'Be rude to Bob',
        personId: bobId,
        createdAtMs: Date.now(),
      });

      await store.logEpisode({
        chatId,
        content: 'dm episode one',
        createdAtMs: Date.now(),
      });
      await store.logEpisode({
        chatId: asChatId('tg:2'),
        content: 'other chat episode',
        createdAtMs: Date.now(),
      });

      const ctx = await assembleMemoryContext({
        store,
        query: 'sushi',
        chatId,
        channelUserId: 'telegram:1',
        budget: 600,
        scope: 'dm',
      });

      expect(ctx.text).toContain('Person: Alice');
      expect(ctx.text).toContain('Likes sushi');
      expect(ctx.text).not.toContain('Hates sushi');
      expect(ctx.text).not.toContain('Bob capsule');
      expect(ctx.text).not.toContain('Be rude to Bob');
      expect(ctx.text).not.toContain('other chat episode');
    } finally {
      store?.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('group scope never injects personal memory', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-mem-scope-group-'));
    let store: SqliteMemoryStore | undefined;
    try {
      store = new SqliteMemoryStore({ dbPath: path.join(tmp, 'memory.db') });
      const chatId = asChatId('tg:100');

      await store.trackPerson({
        id: asPersonId('p1'),
        displayName: 'Alice',
        channel: 'telegram',
        channelUserId: 'telegram:1',
        relationshipStage: 'friend',
        capsule: 'Alice capsule',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      await store.storeFact({
        personId: asPersonId('p1'),
        subject: 'food',
        content: 'Likes sushi',
        createdAtMs: Date.now(),
      });
      await store.logLesson({
        category: 'behavioral_feedback',
        content: 'Prefer short replies',
        rule: 'Keep replies short and warm',
        personId: asPersonId('p1'),
        createdAtMs: Date.now(),
      });
      await store.logEpisode({
        chatId,
        content: 'group episode one',
        createdAtMs: Date.now(),
      });

      const ctx = await assembleMemoryContext({
        store,
        query: 'sushi',
        chatId,
        channelUserId: 'telegram:1',
        budget: 600,
        scope: 'group',
      });

      expect(ctx.text).toContain('Recent context:');
      expect(ctx.text).toContain('group episode one');
      expect(ctx.text).not.toContain('Person:');
      expect(ctx.text).not.toContain('Capsule:');
      expect(ctx.text).not.toContain('Facts:');
      expect(ctx.text).not.toContain('Lessons:');
    } finally {
      store?.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
