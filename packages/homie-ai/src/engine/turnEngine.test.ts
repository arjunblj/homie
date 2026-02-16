import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import type { HomieConfig } from '../config/types.js';
import { SqliteMemoryStore } from '../memory/sqlite.js';
import { SqliteSessionStore } from '../session/sqlite.js';
import { asChatId, asMessageId, asPersonId } from '../types/ids.js';
import { TurnEngine } from './turnEngine.js';

const baseConfig = (projectDir: string, identityDir: string, dataDir: string): HomieConfig => ({
  schemaVersion: 1,
  model: {
    provider: { kind: 'anthropic' },
    models: { default: 'claude-sonnet-4-5', fast: 'claude-haiku-4-5' },
  },
  behavior: {
    sleep: { enabled: false, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
    groupMaxChars: 240,
    dmMaxChars: 420,
    minDelayMs: 0,
    maxDelayMs: 0,
    debounceMs: 0,
  },
  tools: { shell: false },
  paths: { projectDir, identityDir, skillsDir: path.join(projectDir, 'skills'), dataDir },
});

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

describe('TurnEngine', () => {
  test('appends session messages and persists memory', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeIdentity(identityDir);

      const cfg = baseConfig(tmp, identityDir, dataDir);
      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });
      const memoryStore = new SqliteMemoryStore({ dbPath: path.join(dataDir, 'memory.db') });

      const backend: LLMBackend = {
        async complete(params) {
          // Simulate the post-turn memory extraction tool call.
          if (params.role === 'fast' && params.tools?.some((t) => t.name === 'memory_ingest')) {
            const ingest = params.tools.find((t) => t.name === 'memory_ingest');
            if (!ingest) return { text: '', steps: [] };
            await ingest.execute(
              {
                facts: [{ content: 'Likes the Rockets', confidence: 0.9 }],
                lessons: [{ category: 'test', content: 'kept it short' }],
              },
              { now: new Date() },
            );
            return { text: '', steps: [] };
          }

          return { text: 'yo', steps: [] };
        },
      };

      const engine = new TurnEngine({ config: cfg, backend, sessionStore, memoryStore });

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

  test('compacts session, uses local memory injection, and truncates long facts', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-compact-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeIdentity(identityDir);

      const cfg = baseConfig(tmp, identityDir, dataDir);
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
        subject: 'Operator',
        content: 'fact ' + 'y'.repeat(500),
        createdAtMs: nowMs,
      });
      await memoryStore.logEpisode({
        chatId,
        content: 'episode ' + 'z'.repeat(500),
        createdAtMs: nowMs,
      });

      let sawEllipsis = false;
      const backend: LLMBackend = {
        async complete(params) {
          const sys = params.messages.find((m) => m.role === 'system')?.content ?? '';
          if (sys.includes('=== MEMORY CONTEXT (DATA) ===')) {
            sawEllipsis = sys.includes('…');
          }

          // Compaction uses fast role without tools.
          if (params.role === 'fast' && !params.tools) return { text: 'summary', steps: [] };

          // Memory extraction uses the fast role with the ingest tool.
          if (params.role === 'fast' && params.tools?.some((t) => t.name === 'memory_ingest')) {
            return { text: '', steps: [] };
          }

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
      expect(sawEllipsis).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
