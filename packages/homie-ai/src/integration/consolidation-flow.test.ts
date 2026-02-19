import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LLMBackend } from '../backend/types.js';
import { createDefaultConfig } from '../config/defaults.js';
import { runMemoryConsolidationOnce } from '../memory/consolidation.js';
import { SqliteMemoryStore } from '../memory/sqlite.js';
import { asPersonId } from '../types/ids.js';

describe('integration: consolidation -> capsule', () => {
  test('runMemoryConsolidationOnce writes person capsule', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-consolidation-flow-'));
    const dataDir = path.join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });

    try {
      const base = createDefaultConfig(tmp);
      const config = {
        ...base,
        memory: {
          ...base.memory,
          enabled: true,
          consolidation: { ...base.memory.consolidation, enabled: true },
        },
        paths: {
          ...base.paths,
          dataDir,
        },
      };

      const backend: LLMBackend = {
        async complete() {
          return { text: 'Summary.\n- Likes hiking\n- Prefers short texts', steps: [] };
        },
      };

      const memory = new SqliteMemoryStore({ dbPath: path.join(dataDir, 'memory.db') });
      const personId = asPersonId('person:cli:operator');
      await memory.trackPerson({
        id: personId,
        displayName: 'Alex',
        channel: 'cli',
        channelUserId: 'cli:operator',
        relationshipScore: 0.6,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      await memory.storeFact({
        personId,
        subject: 'Alex',
        content: 'Likes hiking',
        category: 'preference',
        evidenceQuote: 'Likes hiking',
        createdAtMs: Date.now(),
      });
      await memory.logLesson({
        type: 'success',
        category: 'behavioral_feedback',
        content: 'Keep it short',
        personId,
        createdAtMs: Date.now(),
      });

      await runMemoryConsolidationOnce({ backend, store: memory, config });
      const p = await memory.getPerson(personId);
      expect(p?.capsule ?? '').toContain('Likes hiking');
      memory.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
