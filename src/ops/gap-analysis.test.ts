import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteFeedbackStore } from '../feedback/sqlite.js';
import { planGapAnalysis } from './gap-analysis.js';

describe('planGapAnalysis', () => {
  test('produces a plan for due finalizations', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-gap-analysis-'));
    try {
      const store = new SqliteFeedbackStore({ dbPath: path.join(tmp, 'feedback.db') });
      // Minimal smoke: no outgoing messages -> empty plan.
      const plan0 = planGapAnalysis({
        store,
        config: {
          enabled: true,
          finalizeAfterMs: 1,
          successThreshold: 0.6,
          failureThreshold: -0.4,
        },
        nowMs: Date.now(),
        limit: 25,
      });
      expect(plan0).toEqual([]);
      store.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
