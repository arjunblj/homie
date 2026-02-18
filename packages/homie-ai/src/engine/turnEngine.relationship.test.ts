import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import { DEFAULT_ENGINE, DEFAULT_MEMORY } from '../config/defaults.js';
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

describe('TurnEngine relationship stages', () => {
  test('does not reset stage and promotes based on interactions', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-stage-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeIdentity(identityDir);

      const cfg: HomieConfig = {
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
          heartbeatIntervalMs: 60_000,
          maxPerDay: 1,
          maxPerWeek: 3,
          cooldownAfterUserMs: 7_200_000,
          pauseAfterIgnored: 2,
          groupMaxPerDay: 1,
          groupMaxPerWeek: 1,
          groupCooldownAfterUserMs: 12 * 60 * 60_000,
          groupPauseAfterIgnored: 1,
        },
        memory: DEFAULT_MEMORY,
        tools: {
          restricted: { enabledForOperator: true, allowlist: [] },
          dangerous: { enabledForOperator: false, allowAll: false, allowlist: [] },
        },
        paths: { projectDir: tmp, identityDir, skillsDir: path.join(tmp, 'skills'), dataDir },
      };

      const backend: LLMBackend = {
        async complete() {
          return { text: 'yo', steps: [] };
        },
      };

      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });
      const memoryStore = new SqliteMemoryStore({ dbPath: path.join(dataDir, 'memory.db') });
      const engine = new TurnEngine({
        config: cfg,
        backend,
        sessionStore,
        memoryStore,
        slopDetector: { check: () => ({ isSlop: false, reasons: [] }) },
      });

      const baseMsg: Omit<IncomingMessage, 'text' | 'messageId'> = {
        channel: 'signal',
        chatId: asChatId('signal:dm:+1'),
        authorId: '+1',
        authorDisplayName: 'u',
        isGroup: false,
        isOperator: false,
        timestampMs: Date.now(),
      };

      for (let i = 0; i < 3; i += 1) {
        await engine.handleIncomingMessage({
          ...baseMsg,
          messageId: asMessageId(`m${i}`),
          text: `hi ${i}`,
        });
      }

      const person = await memoryStore.getPersonByChannelId('signal:+1');
      expect(person?.relationshipStage).toBe('acquaintance');

      if (person) {
        await memoryStore.updateRelationshipStage(person.id, 'friend');
      }

      await engine.handleIncomingMessage({
        ...baseMsg,
        messageId: asMessageId('m3'),
        text: 'hi again',
      });

      const after = await memoryStore.getPersonByChannelId('signal:+1');
      expect(after?.relationshipStage).toBe('friend');

      await engine.drain();
      sessionStore.close();
      memoryStore.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
