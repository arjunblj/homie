import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import { DEFAULT_ENGINE } from '../config/defaults.js';
import type { HomieConfig } from '../config/types.js';
import { TurnEngine } from '../engine/turnEngine.js';
import type { SessionMessage, SessionStore } from '../session/types.js';
import { asChatId, asMessageId } from '../types/ids.js';

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

const baseConfig = (projectDir: string, identityDir: string, dataDir: string): HomieConfig => ({
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
    enabled: false,
    heartbeatIntervalMs: 1_800_000,
    maxPerDay: 1,
    maxPerWeek: 3,
    cooldownAfterUserMs: 7_200_000,
    pauseAfterIgnored: 2,
  },
  memory: {
    enabled: false,
    contextBudgetTokens: 2000,
    capsule: { enabled: true, maxTokens: 200 },
    decay: { enabled: true, halfLifeDays: 30 },
    retrieval: { rrfK: 60, ftsWeight: 0.6, vecWeight: 0.4, recencyWeight: 0.2 },
    feedback: {
      enabled: true,
      finalizeAfterMs: 60_000,
      successThreshold: 0.6,
      failureThreshold: -0.3,
    },
    consolidation: {
      enabled: false,
      intervalMs: 86_400_000,
      modelRole: 'default',
      maxEpisodesPerRun: 50,
    },
  },
  tools: {
    restricted: { enabledForOperator: true, allowlist: [] },
    dangerous: { enabledForOperator: false, allowAll: false, allowlist: [] },
  },
  paths: { projectDir, identityDir, skillsDir: path.join(projectDir, 'skills'), dataDir },
});

describe('Harness invariants (acceptance)', () => {
  test('appends user message to session before first LLM call', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-invariants-append-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeIdentity(identityDir);

      let appendedUser = false;
      const sessionStore: SessionStore = {
        appendMessage(msg: SessionMessage) {
          if (msg.role === 'user') appendedUser = true;
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
          expect(appendedUser).toBe(true);
          return { text: 'yo', steps: [] };
        },
      };

      const engine = new TurnEngine({
        config: baseConfig(tmp, identityDir, dataDir),
        backend,
        sessionStore,
        // Avoid behavior fast-model calls for this acceptance test.
        behaviorEngine: {
          decide: async (_msg: IncomingMessage, text: string) => ({ kind: 'send_text', text }),
        } as never,
        slopDetector: { check: () => ({ isSlop: false, reasons: [] }) },
      });

      const out = await engine.handleIncomingMessage({
        channel: 'cli',
        chatId: asChatId('c'),
        messageId: asMessageId('m'),
        authorId: 'u',
        text: 'hi',
        isGroup: false,
        isOperator: true,
        timestampMs: Date.now(),
      });

      expect(out.kind).toBe('send_text');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('serializes concurrent turns per chatId', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-invariants-lock-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeIdentity(identityDir);

      let inFlight = 0;
      let sawConcurrent = false;
      const backend: LLMBackend = {
        async complete() {
          inFlight += 1;
          if (inFlight > 1) sawConcurrent = true;
          await new Promise((r) => setTimeout(r, 15));
          inFlight -= 1;
          return { text: 'yo', steps: [] };
        },
      };

      const engine = new TurnEngine({
        config: baseConfig(tmp, identityDir, dataDir),
        backend,
        behaviorEngine: {
          decide: async (_msg: IncomingMessage, text: string) => ({ kind: 'send_text', text }),
        } as never,
        slopDetector: { check: () => ({ isSlop: false, reasons: [] }) },
      });

      const chatId = asChatId('c');
      const m1 = engine.handleIncomingMessage({
        channel: 'cli',
        chatId,
        messageId: asMessageId('m1'),
        authorId: 'u',
        text: 'one',
        isGroup: false,
        isOperator: true,
        timestampMs: Date.now(),
      });
      const m2 = engine.handleIncomingMessage({
        channel: 'cli',
        chatId,
        messageId: asMessageId('m2'),
        authorId: 'u',
        text: 'two',
        isGroup: false,
        isOperator: true,
        timestampMs: Date.now(),
      });

      await Promise.all([m1, m2]);
      expect(sawConcurrent).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('collapses newlines for group sends', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-invariants-group-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeIdentity(identityDir);

      const backend: LLMBackend = {
        async complete() {
          return { text: 'a\n\nb', steps: [] };
        },
      };

      const engine = new TurnEngine({
        config: baseConfig(tmp, identityDir, dataDir),
        backend,
        behaviorEngine: {
          decide: async (_msg: IncomingMessage, text: string) => ({ kind: 'send_text', text }),
        } as never,
        slopDetector: { check: () => ({ isSlop: false, reasons: [] }) },
      });

      const out = await engine.handleIncomingMessage({
        channel: 'signal',
        chatId: asChatId('g'),
        messageId: asMessageId('m'),
        authorId: 'u',
        text: 'hi',
        isGroup: true,
        isOperator: false,
        timestampMs: Date.now(),
      });

      expect(out).toEqual({ kind: 'send_text', text: 'a b' });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
