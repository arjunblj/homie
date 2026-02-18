import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import type { TtsSynthesizer } from '../media/tts.js';
import { SqliteMemoryStore } from '../memory/sqlite.js';
import { SqliteSessionStore } from '../session/sqlite.js';
import { createTestConfig, createTestIdentity } from '../testing/helpers.js';
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
            relationshipStage: 'new',
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

      const engine = new TurnEngine({ config: cfg, backend, sessionStore, memoryStore, extractor });

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
      const engine = new TurnEngine({ config: cfg, backend, sessionStore });

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
        relationshipStage: 'friend',
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
          const sys = params.messages.find((m) => m.role === 'system')?.content ?? '';
          if (sys.includes('=== MEMORY CONTEXT (DATA) ===')) {
            sawTruncation = sys.includes('[...truncated]');
          }

          // Compaction uses fast role without tools.
          if (params.role === 'fast' && !params.tools) return { text: 'summary', steps: [] };

          return { text: 'yo', steps: [] };
        },
      };

      const engine = new TurnEngine({ config: cfg, backend, sessionStore, memoryStore });

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

  test('can return send_audio for Telegram voice-note replies (tts injected)', async () => {
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
      const tts: TtsSynthesizer = {
        async synthesizeVoiceNote(_text, _opts) {
          return {
            ok: true,
            mime: 'audio/ogg',
            filename: 'voice.ogg',
            bytes: new Uint8Array([1, 2, 3]),
            asVoiceNote: true,
          };
        },
      };

      const engine = new TurnEngine({
        config: cfg,
        backend,
        tts,
        slopDetector: { check: () => ({ isSlop: false, reasons: [] }) },
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
      expect(out.kind).toBe('send_audio');
      if (out.kind !== 'send_audio') throw new Error('Expected send_audio');
      expect(out.text).toBe('sure');
      expect(out.mime).toBe('audio/ogg');
      expect(out.bytes).toEqual(new Uint8Array([1, 2, 3]));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
