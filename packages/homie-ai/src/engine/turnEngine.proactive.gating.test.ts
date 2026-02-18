import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import { DEFAULT_ENGINE, DEFAULT_MEMORY } from '../config/defaults.js';
import type { HomieConfig } from '../config/types.js';
import type { MemoryStore } from '../memory/store.js';
import type { PersonRecord } from '../memory/types.js';
import { SqliteSessionStore } from '../session/sqlite.js';
import { asChatId, asPersonId } from '../types/ids.js';
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

const cfgFor = (tmp: string, identityDir: string, dataDir: string): HomieConfig => ({
  schemaVersion: 1,
  model: { provider: { kind: 'anthropic' }, models: { default: 'm', fast: 'mf' } },
  engine: DEFAULT_ENGINE,
  behavior: {
    sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
    groupMaxChars: 240,
    dmMaxChars: 420,
    minDelayMs: 0,
    maxDelayMs: 0,
    debounceMs: 0,
  },
  proactive: {
    enabled: true,
    heartbeatIntervalMs: 60_000,
    maxPerDay: 1,
    maxPerWeek: 3,
    cooldownAfterUserMs: 7_200_000,
    pauseAfterIgnored: 2,
  },
  memory: DEFAULT_MEMORY,
  tools: {
    restricted: { enabledForOperator: true, allowlist: [] },
    dangerous: { enabledForOperator: false, allowAll: false, allowlist: [] },
  },
  paths: { projectDir: tmp, identityDir, skillsDir: path.join(tmp, 'skills'), dataDir },
});

describe('TurnEngine proactive gating', () => {
  test('suppresses non-reminder outreach for new relationship stage', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-pro-gate-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeIdentity(identityDir);

      const backend: LLMBackend = {
        async complete() {
          return { text: 'hello', steps: [] };
        },
      };

      const memoryStore: MemoryStore = {
        async trackPerson() {},
        async getPerson() {
          return null;
        },
        async getPersonByChannelId() {
          return {
            id: asPersonId('person:x'),
            displayName: 'x',
            channel: 'signal',
            channelUserId: 'signal:+1',
            relationshipStage: 'new',
            createdAtMs: 1,
            updatedAtMs: 1,
          } satisfies PersonRecord;
        },
        async searchPeople() {
          return [];
        },
        async listPeople() {
          return [];
        },
        async updateRelationshipStage() {},
        async updatePersonCapsule() {},
        async storeFact() {},
        async updateFact() {},
        async deleteFact() {},
        async getFacts() {
          return [];
        },
        async getFactsForPerson() {
          return [];
        },
        async searchFacts() {
          return [];
        },
        async hybridSearchFacts() {
          return [];
        },
        async touchFacts() {},
        async logEpisode() {},
        async countEpisodes() {
          return 0;
        },
        async searchEpisodes() {
          return [];
        },
        async hybridSearchEpisodes() {
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

      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });
      const engine = new TurnEngine({
        config: cfgFor(tmp, identityDir, dataDir),
        backend,
        sessionStore,
        memoryStore,
        behaviorEngine: {
          decide: async (_msg: IncomingMessage, text: string) => ({ kind: 'send_text', text }),
        } as never,
        slopDetector: { check: () => ({ isSlop: false, reasons: [] }) },
      });

      const out = await engine.handleProactiveEvent({
        id: 1,
        kind: 'check_in',
        subject: 'hey',
        chatId: asChatId('signal:dm:+1'),
        triggerAtMs: Date.now(),
        recurrence: null,
        delivered: false,
        createdAtMs: Date.now(),
      });

      expect(out.kind).toBe('silence');
      if (out.kind !== 'silence') throw new Error('Expected silence');
      expect(out.reason).toBe('proactive_relationship_too_new');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('treats HEARTBEAT_OK as silence', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-pro-heartbeat-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeIdentity(identityDir);

      const backend: LLMBackend = {
        async complete() {
          return { text: 'HEARTBEAT_OK', steps: [] };
        },
      };

      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });
      const engine = new TurnEngine({
        config: cfgFor(tmp, identityDir, dataDir),
        backend,
        sessionStore,
        slopDetector: { check: () => ({ isSlop: false, reasons: [] }) },
      });

      const out = await engine.handleProactiveEvent({
        id: 1,
        kind: 'reminder',
        subject: 'thing',
        chatId: asChatId('cli:local'),
        triggerAtMs: Date.now(),
        recurrence: null,
        delivered: false,
        createdAtMs: Date.now(),
      });

      expect(out.kind).toBe('silence');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
