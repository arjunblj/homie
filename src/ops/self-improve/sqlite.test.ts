import { describe, expect, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';

import { computeDedupeKey, SelfImproveSqliteStore } from './sqlite.js';

describe('SelfImproveSqliteStore', () => {
  test('dedupe key is stable across whitespace changes', () => {
    const a = computeDedupeKey({ title: 'Hello  World', proposal: 'Do  the thing' });
    const b = computeDedupeKey({ title: 'hello world', proposal: 'do the thing' });
    expect(a).toBe(b);
  });

  test('insertDraft dedupes and claimNext marks in_progress', () => {
    const dbPath = path.join(os.tmpdir(), `self-improve-${Date.now()}-${Math.random()}.db`);
    const store = new SelfImproveSqliteStore({ dbPath });
    try {
      const draft = {
        classification: 'thorn' as const,
        scope: 'tools' as const,
        confidence: 0.9,
        title: 'Tighten tool output',
        why: 'Some tool outputs are too long',
        proposal: 'Cap outputs and add tests',
        sourceLessons: [{ lessonId: 1, preview: 'x' }],
      };
      const a = store.insertDraft(draft);
      expect(a.ok).toBe(true);
      const b = store.insertDraft({ ...draft, title: 'Tighten   tool output' });
      expect(b.ok).toBe(false);

      const claimed = store.claimNext({ claimId: 'c1', leaseMs: 10_000, minConfidence: 0.0 });
      expect(claimed?.status).toBe('in_progress');
      expect(claimed?.claimId).toBe('c1');
    } finally {
      store.close();
    }
  });
});
