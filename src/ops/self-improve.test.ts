import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SqliteFeedbackStore } from '../feedback/sqlite.js';
import { makeOutgoingRefKey } from '../feedback/types.js';
import { asChatId } from '../types/ids.js';
import { planFeedbackSelfImprove } from './self-improve.js';

describe('planFeedbackSelfImprove', () => {
  test('includes due outgoing rows and flags lesson-worthy failures', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-self-improve-'));
    try {
      const store = new SqliteFeedbackStore({ dbPath: path.join(tmp, 'feedback.db') });

      const chatId = asChatId('tg:123');
      const refKey = makeOutgoingRefKey(chatId, { channel: 'telegram', messageId: 42 });
      const sentAtMs = 1_000;

      store.registerOutgoing({
        channel: 'telegram',
        chatId,
        refKey,
        isGroup: false,
        sentAtMs,
        text: 'hello',
        primaryChannelUserId: 'telegram:u1',
      });

      // Add a strongly negative reaction to ensure score < failure threshold.
      store.recordIncomingReaction({
        channel: 'telegram',
        chatId,
        targetRefKey: refKey,
        emoji: '💩',
        isRemove: false,
        authorId: 'u2',
        timestampMs: sentAtMs + 10_000,
      });

      const plan = planFeedbackSelfImprove({
        store,
        config: {
          enabled: true,
          finalizeAfterMs: 60_000,
          successThreshold: 0.6,
          failureThreshold: -0.3,
        },
        nowMs: sentAtMs + 60_000 + 1,
        limit: 10,
      });

      expect(plan.length).toBe(1);
      expect(plan[0]?.refKey).toBe(refKey);
      expect(plan[0]?.willLogLesson).toBe(true);
      expect(plan[0]?.score).toBeLessThan(-0.3);

      store.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
