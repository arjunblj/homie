import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SqliteSessionStore } from '../session/sqlite.js';
import { asChatId } from '../types/ids.js';
import { readNotesTool, writeNoteTool } from './scratchpad.js';

describe('scratchpad tools', () => {
  test('write_note persists and read_notes returns stored content', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'homie-scratchpad-tools-'));
    try {
      const store = new SqliteSessionStore({ dbPath: path.join(dir, 'sessions.db') });
      const chatId = asChatId('signal:dm:+1');
      const controller = new AbortController();
      const ctx = {
        now: new Date(),
        signal: controller.signal,
        chat: {
          chatId,
          channel: 'signal',
          channelUserId: 'signal:+1',
          isGroup: false,
          isOperator: false,
        },
        services: { sessionStore: store },
      };

      const wrote = await writeNoteTool.execute({ key: 'notes.todo', content: 'buy milk' }, ctx);
      expect(wrote).toMatchObject({ status: 'ok', key: 'notes.todo' });

      const readOne = await readNotesTool.execute({ key: 'notes.todo' }, ctx);
      expect(readOne).toMatchObject({
        status: 'ok',
        notes: [{ key: 'notes.todo', content: 'buy milk' }],
      });

      const readAll = await readNotesTool.execute({}, ctx);
      expect(readAll).toMatchObject({ status: 'ok' });
      expect((readAll as { notes?: unknown[] }).notes?.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
