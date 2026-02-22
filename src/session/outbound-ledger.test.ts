import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { asChatId, asPersonId } from '../types/ids.js';
import { SqliteOutboundLedger } from './outbound-ledger.js';

describe('SqliteOutboundLedger', () => {
  test('records sends, prunes to 10, and marks got_reply on next user message', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-ledger-'));
    const dbPath = path.join(tmp, 'sessions.db');
    const ledger = new SqliteOutboundLedger({ dbPath });
    try {
      const chatId = asChatId('tg:1');
      const personId = asPersonId('p1');

      for (let i = 0; i < 12; i += 1) {
        const sentAtMs = Date.now() + i;
        ledger.recordSend({
          chatId,
          personId,
          text: `msg ${i} ${'x'.repeat(200)}`,
          messageType: 'reactive',
          sentAtMs,
        });
      }

      const rows = ledger.listRecent(chatId, 50);
      expect(rows.length).toBe(10);
      expect(rows[0]?.gotReply).toBe(false);
      expect(rows[0]?.contentPreview.length).toBeLessThanOrEqual(121);

      ledger.markGotReply({ chatId, atMs: Date.now() + 10_000 });
      const rows2 = ledger.listRecent(chatId, 1);
      expect(rows2[0]?.gotReply).toBe(true);
    } finally {
      ledger.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
