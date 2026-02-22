import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { asChatId, asPersonId } from '../types/ids.js';
import { assembleMemoryContext } from './context-pack.js';
import { SqliteMemoryStore } from './sqlite.js';

describe('assembleMemoryContext structured staleness pruning', () => {
  test('omits concerns/goals not mentioned in recent episodes window', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-mem-stale-'));
    let store: SqliteMemoryStore | undefined;
    try {
      store = new SqliteMemoryStore({ dbPath: path.join(tmp, 'memory.db') });
      const chatId = asChatId('tg:1');
      const personId = asPersonId('p1');
      const channelUserId = 'telegram:1';

      await store.trackPerson({
        id: personId,
        displayName: 'Alice',
        channel: 'telegram',
        channelUserId,
        relationshipScore: 0.6,
        capsule: 'Alice capsule',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });

      await store.updateStructuredPersonData(personId, {
        currentConcerns: ['big deadline', 'wedding planning'],
        goals: ['run a marathon', 'learn rust'],
      });

      await store.logEpisode({
        chatId,
        personId,
        content: 'we talked about a deadline and rust stuff',
        createdAtMs: Date.now() - 60_000,
      });

      const ctx = await assembleMemoryContext({
        store,
        query: 'deadline',
        chatId,
        channelUserId,
        budget: 800,
        scope: 'dm',
      });

      expect(ctx.text).toContain('On their mind lately: big deadline');
      expect(ctx.text).not.toContain('wedding planning');
      expect(ctx.text).toContain('Working toward: learn rust');
      expect(ctx.text).not.toContain('run a marathon');
    } finally {
      store?.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
