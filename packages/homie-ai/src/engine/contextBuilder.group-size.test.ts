import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_BEHAVIOR,
  DEFAULT_ENGINE,
  DEFAULT_MEMORY,
  DEFAULT_MODEL,
  DEFAULT_PROACTIVE,
  DEFAULT_TOOLS,
} from '../config/defaults.js';
import type { HomieConfig } from '../config/types.js';
import { SqliteSessionStore } from '../session/sqlite.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { ContextBuilder } from './contextBuilder.js';

const baseConfig = (
  projectDir: string,
  identityDir: string,
  skillsDir: string,
  dataDir: string,
): HomieConfig => ({
  schemaVersion: 1,
  model: DEFAULT_MODEL,
  engine: DEFAULT_ENGINE,
  behavior: { ...DEFAULT_BEHAVIOR, minDelayMs: 0, maxDelayMs: 0, debounceMs: 0 },
  proactive: DEFAULT_PROACTIVE,
  memory: { ...DEFAULT_MEMORY, enabled: false },
  tools: DEFAULT_TOOLS,
  paths: { projectDir, identityDir, skillsDir, dataDir },
});

describe('ContextBuilder group size estimate', () => {
  test('includes large-group rules when enough unique authors are present', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-context-group-size-'));
    const identityDir = path.join(tmp, 'identity');
    const skillsDir = path.join(tmp, 'skills');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(skillsDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });

      const cfg = baseConfig(tmp, identityDir, skillsDir, dataDir);
      const sessionStore = new SqliteSessionStore({ dbPath: path.join(dataDir, 'sessions.db') });
      const cb = new ContextBuilder({ config: cfg, sessionStore });

      const chatId = asChatId('cli:group');
      const now = Date.now();

      // Seed 7 distinct authors so groupSizeEstimate > 6.
      for (let i = 0; i < 7; i += 1) {
        sessionStore.appendMessage({
          chatId,
          role: 'user',
          content: `m${i}`,
          createdAtMs: now + i,
          authorId: `u${i}`,
          authorDisplayName: `User ${i}`,
          sourceMessageId: `m${i}`,
        });
      }

      const ctx = await cb.buildReactiveModelContext({
        msg: {
          channel: 'cli',
          chatId,
          messageId: asMessageId('incoming:group'),
          authorId: 'u6',
          authorDisplayName: 'User 6',
          text: 'm6',
          isGroup: true,
          isOperator: true,
          mentioned: true,
          timestampMs: now + 6,
        },
        userText: 'm6',
        tools: undefined,
        toolsForMessage: () => undefined,
        toolGuidance: () => '',
        identityPrompt: 'IDENTITY',
      });

      expect(ctx.system).toContain('--- Large group ---');
      expect(ctx.system).toContain('This is a larger group.');

      sessionStore.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
