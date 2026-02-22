import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { asChatId, asPersonId } from '../types/ids.js';
import { assembleMemoryContext } from './context-pack.js';
import { SqliteMemoryStore } from './sqlite.js';

describe('assembleMemoryContext skip heuristic', () => {
  test('skips memory context for phatic/ultra-short queries', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-mem-skip-'));
    let store: SqliteMemoryStore | undefined;
    try {
      store = new SqliteMemoryStore({ dbPath: path.join(tmp, 'memory.db') });
      await store.trackPerson({
        id: asPersonId('p1'),
        displayName: 'Alice',
        channel: 'telegram',
        channelUserId: 'telegram:1',
        relationshipScore: 0.6,
        capsule: 'Alice capsule',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });

      const ctx = await assembleMemoryContext({
        store,
        query: 'lol',
        chatId: asChatId('tg:1'),
        channelUserId: 'telegram:1',
        budget: 600,
        scope: 'dm',
      });

      expect(ctx.text).toBe('');
    } finally {
      store?.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('does not skip when query has obvious signal', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-mem-noskip-'));
    let store: SqliteMemoryStore | undefined;
    try {
      store = new SqliteMemoryStore({ dbPath: path.join(tmp, 'memory.db') });
      await store.trackPerson({
        id: asPersonId('p1'),
        displayName: 'Alice',
        channel: 'telegram',
        channelUserId: 'telegram:1',
        relationshipScore: 0.6,
        capsule: 'Alice capsule',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });

      const ctx = await assembleMemoryContext({
        store,
        query: 'bday?',
        chatId: asChatId('tg:1'),
        channelUserId: 'telegram:1',
        budget: 600,
        scope: 'dm',
      });

      expect(ctx.text).toContain('Person: Alice');
    } finally {
      store?.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
