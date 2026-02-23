import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LLMBackend } from '../backend/types.js';
import { createDefaultConfig } from '../config/defaults.js';
import { SqliteFeedbackStore } from '../feedback/sqlite.js';
import { FeedbackTracker } from '../feedback/tracker.js';
import { SqliteMemoryStore } from '../memory/sqlite.js';
import { asChatId } from '../types/ids.js';

describe('integration: feedback -> lesson', () => {
  test('finalization synthesizes a behavioral lesson', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-feedback-flow-'));
    const dataDir = path.join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });

    try {
      const base = createDefaultConfig(tmp);
      const config = {
        ...base,
        memory: {
          ...base.memory,
          enabled: true,
          feedback: {
            ...base.memory.feedback,
            enabled: true,
            finalizeAfterMs: 0,
            // Make it easy for this test to cross thresholds.
            successThreshold: 0.2,
            failureThreshold: -0.2,
          },
        },
        paths: {
          ...base.paths,
          dataDir,
        },
      };

      let llmCalls = 0;
      const backend: LLMBackend = {
        async complete() {
          llmCalls += 1;
          return {
            text: JSON.stringify({
              type: 'success',
              why: 'they replied quickly and reacted positively',
              lesson: 'Keep it short and warm',
              rule: 'Aim for <= 2 sentences unless asked',
              confidence: 0.8,
            }),
            steps: [],
          };
        },
      };

      const memory = new SqliteMemoryStore({ dbPath: path.join(dataDir, 'memory.db') });
      const feedbackStore = new SqliteFeedbackStore({ dbPath: path.join(dataDir, 'feedback.db') });
      const tracker = new FeedbackTracker({ store: feedbackStore, backend, memory, config });

      const chatId = asChatId('cli:local');
      tracker.onOutgoingSent({
        channel: 'cli',
        chatId,
        refKey: 'cli:out:1',
        isGroup: false,
        sentAtMs: 1_000,
        text: 'yo want to grab coffee this week?',
        messageType: 'reactive',
        primaryChannelUserId: 'cli:operator',
      });

      tracker.onIncomingReply({
        channel: 'cli',
        chatId,
        authorId: 'operator',
        text: 'yeah!',
        timestampMs: 10_000,
      });
      tracker.onIncomingReaction({
        channel: 'cli',
        chatId,
        targetRefKey: 'cli:out:1',
        emoji: '❤️',
        isRemove: false,
        authorId: 'operator',
        timestampMs: 12_000,
      });

      await tracker.tick(100_000);
      const lessons = await memory.getLessons('behavioral_feedback', 50);
      expect(lessons.length).toBeGreaterThan(0);
      expect(lessons[0]?.rule ?? '').toContain('2 sentences');
      expect(llmCalls).toBe(1);

      tracker.close();
      memory.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
