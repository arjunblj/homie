import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import { HookRegistry } from '../hooks/registry.js';
import { SqliteSessionStore } from '../session/sqlite.js';
import {
  createNoDebounceAccumulator,
  createTestConfig,
  createTestIdentity,
} from '../testing/helpers.js';
import { asChatId, asMessageId } from '../types/ids.js';
import type { Logger } from '../util/logger.js';
import { TurnEngine } from './turnEngine.js';

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return noopLogger;
  },
};

describe('TurnEngine hooks', () => {
  test('emits onBeforeGenerate and onTurnComplete', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-hooks-'));
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

      const hooks = new HookRegistry(noopLogger);
      let beforeGenerate = 0;
      let turnComplete = 0;
      hooks.register({
        onBeforeGenerate: async () => {
          beforeGenerate += 1;
        },
        onTurnComplete: async () => {
          turnComplete += 1;
        },
      });

      const engine = new TurnEngine({
        config: cfg,
        backend,
        sessionStore,
        accumulator: createNoDebounceAccumulator(),
        hooks,
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
      expect(beforeGenerate).toBeGreaterThanOrEqual(1);
      expect(turnComplete).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('hook failures do not crash turns', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-hooks-iso-'));
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

      const hooks = new HookRegistry(noopLogger);
      hooks.register({
        onTurnComplete: async () => {
          throw new Error('hook boom');
        },
      });

      const engine = new TurnEngine({
        config: cfg,
        backend,
        sessionStore,
        accumulator: createNoDebounceAccumulator(),
        hooks,
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
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
