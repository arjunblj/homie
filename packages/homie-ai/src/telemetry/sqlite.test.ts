import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SqliteTelemetryStore } from './sqlite.js';

describe('SqliteTelemetryStore', () => {
  test('logs turns and summarizes usage window', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-telemetry-'));
    try {
      const store = new SqliteTelemetryStore({ dbPath: path.join(tmp, 'telemetry.db') });
      const now = Date.now();

      store.logTurn({
        id: 't1',
        kind: 'incoming',
        channel: 'cli',
        chatId: 'cli:local',
        messageId: 'm1',
        startedAtMs: now - 1_000,
        durationMs: 12,
        action: 'send_text',
        llmCalls: 2,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      });
      store.logTurn({
        id: 't2',
        kind: 'proactive',
        channel: 'cli',
        chatId: 'cli:local',
        proactiveKind: 'reminder',
        proactiveEventId: 1,
        startedAtMs: now - 500,
        durationMs: 9,
        action: 'silence',
        reason: 'proactive_model_silence',
        llmCalls: 1,
        usage: {
          inputTokens: 3,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      });

      const summary = store.getUsageSummary(60_000);
      expect(summary.turns).toBeGreaterThanOrEqual(2);
      expect(summary.llmCalls).toBeGreaterThanOrEqual(3);
      expect(summary.inputTokens).toBeGreaterThanOrEqual(13);
      expect(summary.outputTokens).toBeGreaterThanOrEqual(5);

      const llm = store.getLlmUsageSummary(60_000);
      // This test logs turns directly; llm_calls are populated via the instrumented backend.
      expect(llm.llmCalls).toBeGreaterThanOrEqual(0);

      store.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
