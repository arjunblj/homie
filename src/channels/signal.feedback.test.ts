import { describe, expect, test } from 'bun:test';

import type { OpenhomieConfig } from '../config/types.js';
import type { TurnEngine } from '../engine/turnEngine.js';
import type { FeedbackTracker } from '../feedback/tracker.js';
import { ShortLivedDedupeCache } from './reliability.js';
import { handleSignalWsMessageForTest, type SignalConfig } from './signal.js';
import { handleSignalDaemonEventForTest } from './signal-daemon.js';

describe('signal feedback correctness', () => {
  test('websocket handler does not record outgoing feedback when send fails', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response('bad', { status: 400 })) as unknown as typeof fetch;

      let outgoingCount = 0;
      const feedback = {
        onIncomingReply: () => {},
        onIncomingReaction: () => {},
        onOutgoingSent: () => {
          outgoingCount += 1;
        },
      } as unknown as FeedbackTracker;

      const engine = {
        handleIncomingMessage: async () => ({ kind: 'send_text', text: 'reply' as const }),
      } as unknown as TurnEngine;
      const sigCfg: SignalConfig = {
        apiUrl: 'http://127.0.0.1:1',
        number: '+15550001111',
      };
      const raw = JSON.stringify({
        envelope: {
          sourceNumber: '+15550002222',
          timestamp: 111,
          dataMessage: { message: 'hello', timestamp: 111 },
        },
      });

      await handleSignalWsMessageForTest(
        raw,
        sigCfg,
        {} as OpenhomieConfig,
        engine,
        feedback,
        undefined,
        new ShortLivedDedupeCache({ ttlMs: 120_000 }),
      );
      expect(outgoingCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('daemon handler does not record outgoing feedback when send fails', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response('bad', { status: 400 })) as unknown as typeof fetch;

      let outgoingCount = 0;
      const feedback = {
        onIncomingReply: () => {},
        onIncomingReaction: () => {},
        onOutgoingSent: () => {
          outgoingCount += 1;
        },
      } as unknown as FeedbackTracker;

      const engine = {
        handleIncomingMessage: async () => ({ kind: 'send_text', text: 'reply' as const }),
      } as unknown as TurnEngine;
      const raw = JSON.stringify({
        jsonrpc: '2.0',
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+15550002222',
            timestamp: 222,
            dataMessage: { message: 'hello', timestamp: 222 },
          },
        },
      });

      await handleSignalDaemonEventForTest(
        raw,
        { httpUrl: 'http://127.0.0.1:1' },
        {} as OpenhomieConfig,
        engine,
        feedback,
        undefined,
        new ShortLivedDedupeCache({ ttlMs: 120_000 }),
      );
      expect(outgoingCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
