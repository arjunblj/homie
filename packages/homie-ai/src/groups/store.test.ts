import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { asChatId } from '../types/ids.js';
import { GroupStore } from './store.js';

describe('GroupStore', () => {
  test('tracks groups and members', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-groups-'));
    try {
      const store = new GroupStore({ dbPath: path.join(dir, 'groups.db') });
      const chatId = asChatId('g1');

      store.upsertGroup(chatId, 'signal', 'Test Group');
      store.trackMember(chatId, 'alice');
      store.trackMember(chatId, 'bob');
      store.trackMember(chatId, 'alice'); // duplicate

      const g = store.getGroup(chatId);
      expect(g).not.toBeNull();
      expect(g?.name).toBe('Test Group');
      expect(g?.members).toEqual(['alice', 'bob']);

      const all = store.listGroups();
      expect(all.length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
