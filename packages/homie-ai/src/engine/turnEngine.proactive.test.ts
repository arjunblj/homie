import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import type { HomieConfig } from '../config/types.js';
import type { MemoryExtractor } from '../memory/extractor.js';
import type { MemoryStore } from '../memory/store.js';
import type { SessionMessage, SessionStore } from '../session/types.js';
import { asChatId } from '../types/ids.js';
import { TurnEngine } from './turnEngine.js';

describe('TurnEngine proactive', () => {
  test('does not append a user message or run extractor', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-pro-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeFile(path.join(identityDir, 'SOUL.md'), 'soul', 'utf8');
      await writeFile(path.join(identityDir, 'STYLE.md'), 'style', 'utf8');
      await writeFile(path.join(identityDir, 'USER.md'), 'user', 'utf8');
      await writeFile(path.join(identityDir, 'first-meeting.md'), 'hi', 'utf8');
      await writeFile(
        path.join(identityDir, 'personality.json'),
        JSON.stringify({ traits: ['x'], voiceRules: ['y'], antiPatterns: [] }),
        'utf8',
      );

      const appended: SessionMessage[] = [];
      const sessionStore: SessionStore = {
        appendMessage(msg) {
          appended.push(msg);
        },
        getMessages() {
          return [];
        },
        estimateTokens() {
          return 0;
        },
        async compactIfNeeded() {
          return false;
        },
      };

      const backend: LLMBackend = {
        async complete() {
          return { text: 'hey', steps: [] };
        },
      };

      const extractor: MemoryExtractor = {
        async extractAndReconcile() {
          throw new Error('should not be called');
        },
      };

      const memoryStore: MemoryStore = {
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
        async getFactsForPerson() {
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

      const cfg: HomieConfig = {
        schemaVersion: 1,
        model: { provider: { kind: 'anthropic' }, models: { default: 'm', fast: 'mf' } },
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
        tools: { shell: false },
        paths: { projectDir: tmp, identityDir, skillsDir: path.join(tmp, 'skills'), dataDir },
      };

      const engine = new TurnEngine({
        config: cfg,
        backend,
        sessionStore,
        memoryStore,
        extractor,
        behaviorEngine: {
          decide: async (_msg: IncomingMessage, text: string) => ({ kind: 'send_text', text }),
        } as never,
        slopDetector: { check: () => ({ isSlop: false, reasons: [] }) },
      });

      const out = await engine.handleProactiveEvent({
        id: 1,
        kind: 'reminder',
        subject: 'thing',
        chatId: asChatId('cli:local'),
        triggerAtMs: Date.now(),
        recurrence: 'once',
        delivered: false,
        createdAtMs: Date.now(),
      });

      expect(out.kind).toBe('send_text');
      expect(appended.some((m) => m.role === 'user')).toBe(false);
      expect(appended.some((m) => m.role === 'assistant')).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
