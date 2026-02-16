import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import type { HomieConfig } from '../config/types.js';
import type { MemoryStore } from '../memory/store.js';
import { SqliteSessionStore } from '../session/sqlite.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { TurnEngine } from './turnEngine.js';

const writeIdentity = async (identityDir: string): Promise<void> => {
  await writeFile(path.join(identityDir, 'SOUL.md'), 'soul', 'utf8');
  await writeFile(path.join(identityDir, 'STYLE.md'), 'style', 'utf8');
  await writeFile(path.join(identityDir, 'USER.md'), 'user', 'utf8');
  await writeFile(path.join(identityDir, 'first-meeting.md'), 'hi', 'utf8');
  await writeFile(
    path.join(identityDir, 'personality.json'),
    JSON.stringify({ traits: ['x'], voiceRules: ['y'], antiPatterns: [] }),
    'utf8',
  );
};

describe('TurnEngine memory context pack', () => {
  test('prefers MemoryStore.getContextPack when available', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-pack-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeIdentity(identityDir);

      const cfg: HomieConfig = {
        schemaVersion: 1,
        model: { provider: { kind: 'anthropic' }, models: { default: 'x', fast: 'y' } },
        behavior: {
          sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
          groupMaxChars: 240,
          dmMaxChars: 420,
          minDelayMs: 0,
          maxDelayMs: 0,
          debounceMs: 0,
        },
        proactive: {
          enabled: false,
          heartbeatIntervalMs: 1_800_000,
          maxPerDay: 1,
          maxPerWeek: 3,
          cooldownAfterUserMs: 7_200_000,
          pauseAfterIgnored: 2,
        },
        tools: { shell: false },
        paths: { projectDir: tmp, identityDir, skillsDir: path.join(tmp, 'skills'), dataDir },
      };

      let sawContextPackQuery = '';
      const memoryStore: MemoryStore = {
        getContextPack: async ({ query }) => {
          sawContextPackQuery = query;
          return { context: '## Context Pack\n- memory' };
        },
        async trackPerson() {},
        async getPerson() {
          return null;
        },
        async getPersonByChannelId() {
          return null;
        },
        async searchPeople() {
          return [];
        },
        async updateRelationshipStage() {},
        async storeFact() {},
        async updateFact() {},
        async deleteFact() {},
        async getFacts() {
          return [];
        },
        async searchFacts() {
          return [];
        },
        async logEpisode() {},
        async searchEpisodes() {
          return [];
        },
        async getRecentEpisodes() {
          return [];
        },
        async logLesson() {},
        async getLessons() {
          return [];
        },
        async deletePerson() {},
        async exportJson() {
          return {};
        },
        async importJson() {},
      };

      const backend: LLMBackend = {
        async complete(params) {
          // Assert the memory context pack got injected.
          const system = params.messages.find((m) => m.role === 'system')?.content ?? '';
          expect(system).toContain('## Context Pack');
          expect(system).toContain('memory');
          return { text: 'yo', steps: [] };
        },
      };

      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });
      const engine = new TurnEngine({ config: cfg, backend, sessionStore, memoryStore });

      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('c'),
        messageId: asMessageId('m'),
        authorId: 'u',
        text: 'hi',
        isGroup: false,
        isOperator: true,
        timestampMs: Date.now(),
      };

      const out = await engine.handleIncomingMessage(msg);
      expect(out.kind).toBe('send_text');
      expect(sawContextPackQuery).toBe('hi');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
