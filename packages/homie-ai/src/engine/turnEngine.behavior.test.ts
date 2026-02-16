import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import type { HomieConfig } from '../config/types.js';
import { SqliteMemoryStore } from '../memory/sqlite.js';
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

const cfgFor = (tmp: string, identityDir: string, dataDir: string): HomieConfig => ({
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
  tools: { shell: false },
  paths: { projectDir: tmp, identityDir, skillsDir: path.join(tmp, 'skills'), dataDir },
});

describe('TurnEngine behavior paths', () => {
  test('supports group reactions via BehaviorEngine decision', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-react-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeIdentity(identityDir);

      const backend: LLMBackend = {
        async complete(params) {
          if (params.role === 'fast') {
            return { text: '{"action":"react","emoji":"🔥"}', steps: [] };
          }
          return { text: 'lol', steps: [] };
        },
      };

      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });
      const engine = new TurnEngine({
        config: cfgFor(tmp, identityDir, dataDir),
        backend,
        sessionStore,
      });

      const msg: IncomingMessage = {
        channel: 'signal',
        chatId: asChatId('g'),
        messageId: asMessageId('m'),
        authorId: '+1',
        text: 'thats wild',
        isGroup: true,
        isOperator: false,
        timestampMs: 1,
      };

      const out = await engine.handleIncomingMessage(msg);
      expect(out.kind).toBe('react');
      if (out.kind !== 'react') throw new Error('Expected react');
      expect(out.emoji).toBe('🔥');

      const hist = sessionStore.getMessages(msg.chatId, 10);
      expect(hist.some((m) => m.content.includes('[REACTION]'))).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('runs slop regen loop and returns regenerated text', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-slop-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeIdentity(identityDir);

      const backend: LLMBackend = {
        async complete(params) {
          const sys = params.messages.find((m) => m.role === 'system')?.content ?? '';
          if (sys.includes('Rewrite the reply')) return { text: 'yo', steps: [] };
          return { text: "I'd be happy to help with that!", steps: [] };
        },
      };

      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });
      const engine = new TurnEngine({
        config: cfgFor(tmp, identityDir, dataDir),
        backend,
        sessionStore,
      });

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
      expect(out).toEqual({ kind: 'send_text', text: 'yo' });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('suppresses memory extraction errors into lessons', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-memerr-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeIdentity(identityDir);

      const backend: LLMBackend = {
        async complete(params) {
          if (params.role === 'fast') throw new Error('boom');
          return { text: 'yo', steps: [] };
        },
      };

      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });
      const memoryStore = new SqliteMemoryStore({ dbPath: path.join(dataDir, 'memory.db') });
      const engine = new TurnEngine({
        config: cfgFor(tmp, identityDir, dataDir),
        backend,
        sessionStore,
        memoryStore,
      });

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

      const lessons = await memoryStore.getLessons('memory_extraction_error');
      expect(lessons.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
