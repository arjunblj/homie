import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LLMBackend } from '../backend/types.js';
import { createDefaultConfig } from '../config/defaults.js';
import { asChatId, asPersonId } from '../types/ids.js';
import { runMemoryConsolidationOnce } from './consolidation.js';
import type { MemoryExtractor } from './extractor.js';
import { SqliteMemoryStore } from './sqlite.js';

const stubBackend: LLMBackend = {
  async complete() {
    return { text: 'Summary.\n- Stub capsule', steps: [] };
  },
};

describe('memory consolidation enhancements', () => {
  test('dedupes duplicate facts by retiring the older one', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-consolidation-dedup-'));
    const dataDir = path.join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });
    try {
      const base = createDefaultConfig(tmp);
      const config = { ...base, paths: { ...base.paths, dataDir } };
      const memory = new SqliteMemoryStore({ dbPath: path.join(dataDir, 'memory.db') });

      const personId = asPersonId('person:cli:operator');
      await memory.trackPerson({
        id: personId,
        displayName: 'Alex',
        channel: 'cli',
        channelUserId: 'cli:operator',
        relationshipScore: 0,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });

      const older = Date.now() - 5_000;
      const newer = Date.now();
      await memory.storeFact({
        personId,
        subject: 'Alex',
        content: 'Likes hiking',
        category: 'preference',
        evidenceQuote: 'Likes hiking',
        createdAtMs: older,
      });
      await memory.storeFact({
        personId,
        subject: 'Alex',
        content: 'Likes hiking', // exact duplicate
        category: 'preference',
        evidenceQuote: 'Likes hiking',
        createdAtMs: newer,
      });

      await runMemoryConsolidationOnce({ backend: stubBackend, store: memory, config });
      const facts = await memory.getFactsForPerson(personId, 50);
      expect(facts.map((f) => f.content)).toEqual(['Likes hiking']);
      memory.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('retires obvious contradictions (works at X vs works at Y) by keeping newest', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-consolidation-contradict-'));
    const dataDir = path.join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });
    try {
      const base = createDefaultConfig(tmp);
      const config = { ...base, paths: { ...base.paths, dataDir } };
      const memory = new SqliteMemoryStore({ dbPath: path.join(dataDir, 'memory.db') });

      const personId = asPersonId('person:cli:operator');
      await memory.trackPerson({
        id: personId,
        displayName: 'Alex',
        channel: 'cli',
        channelUserId: 'cli:operator',
        relationshipScore: 0,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });

      const older = Date.now() - 5_000;
      const newer = Date.now();
      await memory.storeFact({
        personId,
        subject: 'Alex',
        content: 'Works at Google',
        category: 'professional',
        evidenceQuote: 'Works at Google',
        createdAtMs: older,
      });
      await memory.storeFact({
        personId,
        subject: 'Alex',
        content: 'Works at Meta',
        category: 'professional',
        evidenceQuote: 'Works at Meta',
        createdAtMs: newer,
      });

      await runMemoryConsolidationOnce({ backend: stubBackend, store: memory, config });
      const facts = await memory.getFactsForPerson(personId, 50);
      expect(facts.map((f) => f.content)).toEqual(['Works at Meta']);
      memory.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('catch-up extraction runs for episodes needing extraction', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-consolidation-catchup-'));
    const dataDir = path.join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });
    try {
      const base = createDefaultConfig(tmp);
      const config = { ...base, paths: { ...base.paths, dataDir } };
      const memory = new SqliteMemoryStore({ dbPath: path.join(dataDir, 'memory.db') });

      const personId = asPersonId('person:cli:operator');
      await memory.trackPerson({
        id: personId,
        displayName: 'Alex',
        channel: 'cli',
        channelUserId: 'cli:operator',
        relationshipScore: 0,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });

      const episodeId = await memory.logEpisode({
        chatId: asChatId('cli:operator'),
        personId,
        isGroup: false,
        content: 'USER: I work at ACME\nFRIEND: cool',
        createdAtMs: Date.now(),
      });

      const calls: Array<{ episodeId?: unknown; userText: string }> = [];
      const extractor: MemoryExtractor = {
        async extractAndReconcile(turn) {
          calls.push({ episodeId: turn.episodeId, userText: turn.userText });
          if (turn.episodeId) await memory.markEpisodeExtracted(turn.episodeId, Date.now());
        },
      };

      await runMemoryConsolidationOnce({ backend: stubBackend, store: memory, config, extractor });
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0]?.episodeId).toEqual(episodeId);

      const remaining = await memory.listEpisodesNeedingExtraction(10);
      expect(remaining).toEqual([]);
      memory.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
