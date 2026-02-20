import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import { DEFAULT_MEMORY } from '../config/defaults.js';
import { SqliteMemoryStore } from '../memory/sqlite.js';
import { SqliteSessionStore } from '../session/sqlite.js';
import {
  createNoDebounceAccumulator,
  createTestConfig,
  createTestIdentity,
} from '../testing/helpers.js';
import { asChatId, asMessageId, asPersonId } from '../types/ids.js';
import { TurnEngine } from './turnEngine.js';

describe('TurnEngine', () => {
  test('appends session messages and persists memory', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

      const cfg = createTestConfig({ projectDir: tmp, identityDir, dataDir });
      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });
      const memoryStore = new SqliteMemoryStore({ dbPath: path.join(dataDir, 'memory.db') });

      const backend: LLMBackend = {
        async complete() {
          return { text: 'yo', steps: [] };
        },
      };

      const extractor = {
        async extractAndReconcile() {
          await memoryStore.trackPerson({
            id: asPersonId('person:cli:operator'),
            displayName: 'operator',
            channel: 'cli',
            channelUserId: 'cli:operator',
            relationshipScore: 0,
            createdAtMs: Date.now(),
            updatedAtMs: Date.now(),
          });
          await memoryStore.storeFact({
            personId: asPersonId('person:cli:operator'),
            subject: 'operator',
            content: 'Likes the Rockets',
            createdAtMs: Date.now(),
          });
          await memoryStore.logLesson({
            category: 'test',
            content: 'kept it short',
            createdAtMs: Date.now(),
          });
        },
      };

      const engine = new TurnEngine({
        config: cfg,
        backend,
        sessionStore,
        memoryStore,
        extractor,
        accumulator: createNoDebounceAccumulator(),
      });

      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('cli:local'),
        messageId: asMessageId('cli:1'),
        authorId: 'operator',
        text: 'hey',
        isGroup: false,
        isOperator: true,
        timestampMs: Date.now(),
      };

      const out = await engine.handleIncomingMessage(msg);
      expect(out.kind).toBe('send_text');
      if (out.kind !== 'send_text') throw new Error('Expected send_text');
      expect(out.text).toBe('yo');

      const session = sessionStore.getMessages(msg.chatId, 10);
      expect(session.map((m) => m.role)).toEqual(['user', 'assistant']);

      const exported = (await memoryStore.exportJson()) as {
        people: unknown[];
        facts: unknown[];
        episodes: unknown[];
        lessons: unknown[];
      };
      expect(exported.episodes.length).toBe(1);
      expect(exported.facts.length).toBeGreaterThanOrEqual(1);
      expect(exported.lessons.length).toBeGreaterThanOrEqual(1);
      expect(exported.people.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('includes attachment context in persisted user text even when message text exists', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-att-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

      const cfg = createTestConfig({ projectDir: tmp, identityDir, dataDir });
      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });
      const backend: LLMBackend = {
        async complete() {
          return { text: 'yo', steps: [] };
        },
      };
      const engine = new TurnEngine({
        config: cfg,
        backend,
        sessionStore,
        accumulator: createNoDebounceAccumulator(),
      });

      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('cli:local'),
        messageId: asMessageId('cli:att'),
        authorId: 'operator',
        text: 'look',
        attachments: [
          {
            id: 'a1',
            kind: 'image',
            mime: 'image/jpeg',
            derivedText: 'caption',
          },
        ],
        isGroup: false,
        isOperator: true,
        timestampMs: Date.now(),
      };

      await engine.handleIncomingMessage(msg);
      const session = sessionStore.getMessages(msg.chatId, 10);
      expect(session[0]?.role).toBe('user');
      expect(session[0]?.content).toContain('look');
      expect(session[0]?.content).toContain('[sent a photo]');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('compacts session, uses local memory injection, and truncates long facts', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-compact-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

      const cfg = createTestConfig({ projectDir: tmp, identityDir, dataDir });
      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });
      const memoryStore = new SqliteMemoryStore({ dbPath: path.join(dataDir, 'memory.db') });

      // Pre-fill session with enough content to force compaction, so the engine executes
      // the fast-model summary callback.
      const chatId = asChatId('cli:local');
      const nowMs = Date.now();
      for (let i = 0; i < 12; i += 1) {
        sessionStore.appendMessage({
          chatId,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: 'x'.repeat(4000),
          createdAtMs: nowMs - 1000 - i,
        });
      }

      // Populate local memory so TurnEngine uses the no-getContextPack branch, hitting `truncate(...)`.
      await memoryStore.trackPerson({
        id: asPersonId('p1'),
        displayName: 'Operator',
        channel: 'cli',
        channelUserId: 'cli:operator',
        relationshipScore: 0.6,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
      await memoryStore.storeFact({
        personId: asPersonId('p1'),
        subject: 'Operator',
        content: `fact ${'y'.repeat(500)}`,
        createdAtMs: nowMs,
      });
      await memoryStore.logEpisode({
        chatId,
        content: `episode ${'z'.repeat(500)}`,
        createdAtMs: nowMs,
      });

      let sawTruncation = false;
      const backend: LLMBackend = {
        async complete(params) {
          const all = params.messages.map((m) => `${m.role}:${m.content}`).join('\n');
          if (all.includes('=== MEMORY CONTEXT (DATA) ===')) {
            sawTruncation = all.includes('[...truncated]');
          }

          // Compaction uses fast role without tools.
          if (params.role === 'fast' && !params.tools) return { text: 'summary', steps: [] };

          return { text: 'yo', steps: [] };
        },
      };

      const engine = new TurnEngine({
        config: cfg,
        backend,
        sessionStore,
        memoryStore,
        accumulator: createNoDebounceAccumulator(),
      });

      const msg: IncomingMessage = {
        channel: 'cli',
        chatId,
        messageId: asMessageId('cli:2'),
        authorId: 'operator',
        text: 'hey',
        isGroup: false,
        isOperator: true,
        timestampMs: nowMs,
      };

      const out = await engine.handleIncomingMessage(msg);
      expect(out.kind).toBe('send_text');
      expect(sawTruncation).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('dedupes identical incoming messages by (chatId, messageId)', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-dedupe-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

      const cfg = createTestConfig({ projectDir: tmp, identityDir, dataDir });
      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });

      let calls = 0;
      const backend: LLMBackend = {
        async complete() {
          calls += 1;
          return { text: 'yo', steps: [] };
        },
      };

      const engine = new TurnEngine({
        config: cfg,
        backend,
        sessionStore,
        slopDetector: { check: () => ({ isSlop: false, reasons: [] }) },
        accumulator: createNoDebounceAccumulator(),
      });

      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('cli:local'),
        messageId: asMessageId('cli:1'),
        authorId: 'operator',
        text: 'hey',
        isGroup: false,
        isOperator: true,
        timestampMs: Date.now(),
      };

      const out1 = await engine.handleIncomingMessage(msg);
      expect(out1).toEqual({ kind: 'send_text', text: 'yo' });

      const out2 = await engine.handleIncomingMessage(msg);
      expect(out2).toEqual({ kind: 'silence', reason: 'duplicate_message' });
      expect(calls).toBe(1);

      const session = sessionStore.getMessages(msg.chatId, 10);
      expect(session.map((m) => m.role)).toEqual(['user', 'assistant']);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('dedupe entries expire and map remains bounded', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-dedupe-expiry-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

      const cfg = createTestConfig({ projectDir: tmp, identityDir, dataDir });
      const backend: LLMBackend = {
        async complete() {
          return { text: 'yo', steps: [] };
        },
      };
      const engine = new TurnEngine({
        config: cfg,
        backend,
        accumulator: createNoDebounceAccumulator(),
      }) as unknown as {
        markIncomingSeen: (key: string, nowMs: number) => void;
        isDuplicateIncoming: (key: string, nowMs: number) => boolean;
        seenIncoming: Map<string, number>;
      };

      const nowMs = 1_000_000;
      engine.markIncomingSeen('chat|msg-1', nowMs);
      expect(engine.isDuplicateIncoming('chat|msg-1', nowMs + 1)).toBe(true);
      expect(engine.isDuplicateIncoming('chat|msg-1', nowMs + 600_001)).toBe(false);

      for (let i = 0; i < 10_250; i++) {
        engine.markIncomingSeen(`chat|msg-${i}`, nowMs + 2);
      }
      expect(engine.seenIncoming.size).toBeLessThanOrEqual(10_000);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('sets ttsHint on send_text when user requests voice note', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

      const cfg = createTestConfig({ projectDir: tmp, identityDir, dataDir });
      const backend: LLMBackend = {
        async complete() {
          return { text: 'sure', steps: [] };
        },
      };

      const engine = new TurnEngine({
        config: cfg,
        backend,
        slopDetector: { check: () => ({ isSlop: false, reasons: [] }) },
        accumulator: createNoDebounceAccumulator(),
      });

      const msg: IncomingMessage = {
        channel: 'telegram',
        chatId: asChatId('tg:123'),
        messageId: asMessageId('m1'),
        authorId: 'u1',
        authorDisplayName: 'u',
        text: 'send a voice note pls',
        isGroup: false,
        isOperator: false,
        timestampMs: Date.now(),
      };

      const out = await engine.handleIncomingMessage(msg);
      expect(out.kind).toBe('send_text');
      if (out.kind !== 'send_text') throw new Error('Expected send_text');
      expect(out.text).toBe('sure');
      expect(out.ttsHint).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('silences platform artifacts without LLM call', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-artifact-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

      const cfg = createTestConfig({
        projectDir: tmp,
        identityDir,
        dataDir,
        overrides: { memory: { ...DEFAULT_MEMORY, enabled: false } },
      });

      let llmCalled = false;
      const backend: LLMBackend = {
        async complete() {
          llmCalled = true;
          return { text: 'yo', steps: [] };
        },
      };

      const engine = new TurnEngine({
        config: cfg,
        backend,
        accumulator: createNoDebounceAccumulator(),
      });

      const msg: IncomingMessage = {
        channel: 'signal',
        chatId: asChatId('signal:dm:+1'),
        messageId: asMessageId('artifact-1'),
        authorId: 'u1',
        text: '<media:unknown>',
        isGroup: false,
        isOperator: false,
        timestampMs: Date.now(),
      };

      const out = await engine.handleIncomingMessage(msg);
      expect(out.kind).toBe('silence');
      if (out.kind === 'silence') expect(out.reason).toBe('platform_artifact');
      expect(llmCalled).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('artifact variants always stay silent and never draft failure text', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-artifact-variants-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

      const cfg = createTestConfig({
        projectDir: tmp,
        identityDir,
        dataDir,
        overrides: { memory: { ...DEFAULT_MEMORY, enabled: false } },
      });

      let llmCalls = 0;
      const backend: LLMBackend = {
        async complete() {
          llmCalls += 1;
          return { text: 'looks like something failed to send', steps: [] };
        },
      };

      const engine = new TurnEngine({
        config: cfg,
        backend,
        accumulator: createNoDebounceAccumulator(),
      });

      const artifacts = [
        '<media:unknown>',
        '<media:unknown>   ',
        '<media:unknown> <media:unknown>',
        '[typing indicator]',
        '[profile update]',
      ];

      for (const [idx, text] of artifacts.entries()) {
        const out = await engine.handleIncomingMessage({
          channel: 'signal',
          chatId: asChatId('signal:dm:+1'),
          messageId: asMessageId(`artifact-${idx}`),
          authorId: 'u1',
          text,
          isGroup: false,
          isOperator: false,
          timestampMs: Date.now() + idx,
        });
        expect(out.kind).toBe('silence');
        if (out.kind === 'silence') {
          expect(out.reason).toBe('platform_artifact');
          expect(out.reason ?? '').not.toContain('failed to send');
        }
      }
      expect(llmCalls).toBe(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('trackBackground rejection is swallowed (no unhandled rejection)', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-track-bg-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

      const cfg = createTestConfig({ projectDir: tmp, identityDir, dataDir });
      const memoryStore = new SqliteMemoryStore({ dbPath: path.join(dataDir, 'memory.db') });
      const backend: LLMBackend = {
        async complete() {
          return { text: 'yo', steps: [] };
        },
      };

      const engine = new TurnEngine({
        config: cfg,
        backend,
        memoryStore,
        extractor: {
          async extractAndReconcile() {
            return;
          },
        },
        trackBackground: async () => {
          throw new Error('tracker exploded');
        },
        accumulator: createNoDebounceAccumulator(),
      });

      const out = await engine.handleIncomingMessage({
        channel: 'cli',
        chatId: asChatId('cli:local'),
        messageId: asMessageId('bg-1'),
        authorId: 'operator',
        text: 'hey',
        isGroup: false,
        isOperator: true,
        timestampMs: Date.now(),
      });
      expect(out.kind).toBe('send_text');

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
