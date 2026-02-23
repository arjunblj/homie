import { describe, expect, test } from 'bun:test';

import type { IncomingMessage } from '../agent/types.js';
import type { MemoryStore } from '../memory/store.js';
import { asChatId, asEpisodeId, asMessageId } from '../types/ids.js';
import { log } from '../util/logger.js';
import { type PersistenceDeps, persistInboundEpisodeBestEffort } from './persistence.js';

describe('persistInboundEpisodeBestEffort', () => {
  test('tracks person then logs episode (best-effort)', async () => {
    const calls: string[] = [];
    let trackedId: string | undefined;
    let loggedPersonId: string | undefined;
    const memoryStore: Partial<MemoryStore> = {
      getPersonByChannelId: async () => null,
      trackPerson: async (p) => {
        calls.push('trackPerson');
        trackedId = String(p.id);
      },
      logEpisode: async (e) => {
        calls.push('logEpisode');
        loggedPersonId = String(e.personId);
        return asEpisodeId(1);
      },
    };

    const deps: PersistenceDeps = {
      sessionStore: undefined,
      extractor: undefined,
      outboundLedger: undefined,
      logger: log.child({ component: 'test' }),
      trackBackground: async <T>(p: Promise<T>) => await p,
      memoryStore: memoryStore as MemoryStore,
    };

    const msg: IncomingMessage = {
      chatId: asChatId('chat:1'),
      channel: 'signal',
      messageId: asMessageId('m1'),
      authorId: 'u1',
      authorDisplayName: 'Alice',
      isGroup: false,
      isOperator: false,
      mentioned: false,
      text: 'hello',
      timestampMs: Date.now(),
    };

    persistInboundEpisodeBestEffort(deps, msg, 'hello');

    // Ensure the background task completes.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['trackPerson', 'logEpisode']);
    expect(trackedId).toBeTruthy();
    expect(loggedPersonId).toBe(trackedId);
  });
});
