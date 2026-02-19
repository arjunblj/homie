import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { LLMBackend } from '../backend/types.js';
import { TurnEngine } from '../engine/turnEngine.js';
import type { SessionMessage, SessionStore } from '../session/types.js';
import { createNoDebounceAccumulator, createTestConfig, createTestIdentity } from '../testing/helpers.js';
import { asChatId, asMessageId } from '../types/ids.js';

const HARNESS_OVERRIDES = {
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
      modelRole: 'default' as const,
      maxEpisodesPerRun: 50,
      dirtyGroupLimit: 3,
      dirtyPublicStyleLimit: 5,
      dirtyPersonLimit: 0,
    },
  },
} as const;

describe('Harness invariants (acceptance)', () => {
  test('appends user message to session before first LLM call', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-invariants-append-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

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
        config: createTestConfig({
          projectDir: tmp,
          identityDir,
          dataDir,
          overrides: HARNESS_OVERRIDES,
        }),
        backend,
        sessionStore,
        accumulator: createNoDebounceAccumulator(),
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
      await createTestIdentity(identityDir);

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
        config: createTestConfig({
          projectDir: tmp,
          identityDir,
          dataDir,
          overrides: HARNESS_OVERRIDES,
        }),
        backend,
        accumulator: createNoDebounceAccumulator(),
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
      await createTestIdentity(identityDir);

      const backend: LLMBackend = {
        async complete() {
          return { text: 'a\n\nb', steps: [] };
        },
      };

      const engine = new TurnEngine({
        config: createTestConfig({
          projectDir: tmp,
          identityDir,
          dataDir,
          overrides: HARNESS_OVERRIDES,
        }),
        backend,
        accumulator: createNoDebounceAccumulator(),
        slopDetector: { check: () => ({ isSlop: false, reasons: [] }) },
      });

      const out = await engine.handleIncomingMessage({
        channel: 'signal',
        chatId: asChatId('g'),
        messageId: asMessageId('m'),
        authorId: 'u',
        text: 'hi',
        isGroup: true,
        mentioned: true,
        isOperator: false,
        timestampMs: Date.now(),
      });

      expect(out).toEqual({ kind: 'send_text', text: 'a b' });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
