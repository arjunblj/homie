import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import { SqliteOutboundLedger } from '../session/outbound-ledger.js';
import {
  createNoDebounceAccumulator,
  createTestConfig,
  createTestIdentity,
} from '../testing/helpers.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { TurnEngine } from './turnEngine.js';

describe('TurnEngine outbound ledger', () => {
  test('injects outbound ledger as data (not system)', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-ledger-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

      const cfg = createTestConfig({ projectDir: tmp, identityDir, dataDir });
      const ledger = new SqliteOutboundLedger({ dbPath: path.join(dataDir, 'sessions.db') });
      ledger.recordSend({
        chatId: asChatId('c'),
        text: 'hey did you ever hear back',
        messageType: 'reactive',
        sentAtMs: Date.now() - 60_000,
      });

      let sawLedgerInSystem = false;
      let sawLedgerInData = false;
      const backend: LLMBackend = {
        async complete(params) {
          const system = params.messages.find((m) => m.role === 'system')?.content ?? '';
          const userData = params.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content)
            .join('\n');
          if (system.includes('OUTBOUND LEDGER')) sawLedgerInSystem = true;
          if (userData.includes('OUTBOUND LEDGER')) sawLedgerInData = true;
          return { text: 'yo', steps: [] };
        },
      };

      const engine = new TurnEngine({
        config: cfg,
        backend,
        outboundLedger: ledger,
        accumulator: createNoDebounceAccumulator(),
      });

      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('c'),
        messageId: asMessageId('m'),
        authorId: 'u',
        text: 'sup',
        isGroup: false,
        isOperator: true,
        timestampMs: Date.now(),
      };

      const out = await engine.handleIncomingMessage(msg);
      expect(out.kind).toBe('send_text');
      expect(sawLedgerInSystem).toBe(false);
      expect(sawLedgerInData).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
