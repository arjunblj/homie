import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { asChatId, asPersonId } from '../types/ids.js';
import { assembleMemoryContext } from './context-pack.js';
import { SqliteMemoryStore } from './sqlite.js';

describe('assembleMemoryContext relevance + gating', () => {
  test('new_contact tier does not inject personal/relationship facts', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-mem-tier-'));
    let store: SqliteMemoryStore | undefined;
    try {
      store = new SqliteMemoryStore({ dbPath: path.join(tmp, 'memory.db') });
      const personId = asPersonId('p_alice');
      const channelUserId = 'telegram:1';

      await store.trackPerson({
        id: personId,
        displayName: 'Alice',
        channel: 'telegram',
        channelUserId,
        relationshipScore: 0.05, // new_contact
        capsule: 'Alice capsule',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });

      await store.storeFact({
        personId,
        subject: 'health',
        category: 'personal',
        content: 'Has asthma',
        createdAtMs: Date.now() - 3 * 24 * 60 * 60_000,
      });

      const ctx = await assembleMemoryContext({
        store,
        query: 'asthma',
        chatId: asChatId('tg:1'),
        channelUserId,
        budget: 600,
        scope: 'dm',
      });

      expect(ctx.text).toContain('Person: Alice');
      expect(ctx.text).not.toContain('Has asthma');
    } finally {
      store?.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('close_friend tier can inject personal facts with temporal fragments', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-mem-tier2-'));
    let store: SqliteMemoryStore | undefined;
    try {
      store = new SqliteMemoryStore({ dbPath: path.join(tmp, 'memory.db') });
      const personId = asPersonId('p_alice');
      const channelUserId = 'telegram:1';

      await store.trackPerson({
        id: personId,
        displayName: 'Alice',
        channel: 'telegram',
        channelUserId,
        relationshipScore: 0.95, // close_friend
        capsule: 'Alice capsule',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });

      await store.storeFact({
        personId,
        subject: 'health',
        category: 'personal',
        content: 'Has asthma',
        createdAtMs: Date.now() - 3 * 24 * 60 * 60_000,
      });

      const ctx = await assembleMemoryContext({
        store,
        query: 'asthma',
        chatId: asChatId('tg:1'),
        channelUserId,
        budget: 600,
        scope: 'dm',
      });

      expect(ctx.text).toContain('Facts:');
      expect(ctx.text).toContain('Has asthma');
      // Temporal fragment marker: "- [3d] Has asthma" (day count can vary by a small margin).
      expect(ctx.text).toMatch(/- \[\d+d\] Has asthma/u);
    } finally {
      store?.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
