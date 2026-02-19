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
        relationshipScore: 0.6,
        capsule: 'Alice capsule',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      await store.trackPerson({
        id: bobId,
        displayName: 'Bob',
        channel: 'telegram',
        channelUserId: 'telegram:2',
        relationshipScore: 0.6,
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

  test('group scope injects only group-safe memory (group capsule + public style)', async () => {
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
        relationshipScore: 0.6,
        capsule: 'Alice capsule',
        publicStyleCapsule: 'Public style: likes dry humor',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      await store.upsertGroupCapsule(chatId, 'Group norms: roast gently, stay brief', Date.now());
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
      expect(ctx.text).toContain('GroupCapsule:');
      expect(ctx.text).toContain('PublicStyle:');
      expect(ctx.text).not.toContain('Person:');
      expect(ctx.text).not.toContain('Capsule: Alice capsule');
      expect(ctx.text).not.toContain('Facts:');
      expect(ctx.text).not.toContain('Lessons:');
      expect(ctx.text).not.toContain('Likes sushi');
    } finally {
      store?.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('DM scope does not inject group capsule or public style', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-mem-dm-no-group-'));
    let store: SqliteMemoryStore | undefined;
    try {
      store = new SqliteMemoryStore({ dbPath: path.join(tmp, 'memory.db') });
      const chatId = asChatId('tg:200');

      await store.trackPerson({
        id: asPersonId('p_carol'),
        displayName: 'Carol',
        channel: 'telegram',
        channelUserId: 'telegram:200',
        relationshipScore: 0.6,
        capsule: 'Carol private capsule',
        publicStyleCapsule: 'Public style: enthusiastic and loud',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      await store.upsertGroupCapsule(chatId, 'Group norms: be chill', Date.now());

      const ctx = await assembleMemoryContext({
        store,
        query: 'hello',
        chatId,
        channelUserId: 'telegram:200',
        budget: 600,
        scope: 'dm',
      });

      expect(ctx.text).toContain('Person: Carol');
      expect(ctx.text).toContain('Capsule: Carol private capsule');
      expect(ctx.text).not.toContain('GroupCapsule:');
      expect(ctx.text).not.toContain('PublicStyle:');
    } finally {
      store?.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('group capsule appears in group context even with no public style', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-mem-group-no-style-'));
    let store: SqliteMemoryStore | undefined;
    try {
      store = new SqliteMemoryStore({ dbPath: path.join(tmp, 'memory.db') });
      const chatId = asChatId('tg:300');

      await store.upsertGroupCapsule(chatId, 'Group norms: no spam, stay on topic', Date.now());

      const ctx = await assembleMemoryContext({
        store,
        query: 'topic',
        chatId,
        channelUserId: 'telegram:300',
        budget: 600,
        scope: 'group',
      });

      expect(ctx.text).toContain('GroupCapsule:');
      expect(ctx.text).toContain('no spam, stay on topic');
      expect(ctx.text).not.toContain('PublicStyle:');
    } finally {
      store?.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
