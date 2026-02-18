import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LLMBackend } from '../backend/types.js';
import { createTestConfig, createTestIdentity } from '../testing/helpers.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { AgentRuntime } from './runtime.js';
import type { IncomingMessage } from './types.js';

const baseConfig = createTestConfig({
  projectDir: '/tmp/project',
  identityDir: '/tmp/project/identity',
  dataDir: '/tmp/project/data',
  overrides: {
    behavior: {
      sleep: { enabled: true, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
      groupMaxChars: 240,
      dmMaxChars: 420,
      minDelayMs: 0,
      maxDelayMs: 0,
      debounceMs: 0,
    },
  },
});

const silentBackend: LLMBackend = {
  async complete() {
    return { text: '   ', steps: [] };
  },
};

describe('AgentRuntime', () => {
  test('treats empty output as silence', async () => {
    const identityDir = await mkdtemp(path.join(os.tmpdir(), 'homie-identity-'));
    try {
      await createTestIdentity(identityDir);

      const msg: IncomingMessage = {
        channel: 'cli',
        chatId: asChatId('c'),
        messageId: asMessageId('m'),
        authorId: 'u',
        text: 'hi',
        isGroup: false,
        timestampMs: Date.now(),
      };

      const runtime = new AgentRuntime({
        config: { ...baseConfig, paths: { ...baseConfig.paths, identityDir } },
        backend: silentBackend,
      });

      const out = await runtime.handleIncomingMessage(msg);
      expect(out).toBeNull();
    } finally {
      await rm(identityDir, { recursive: true, force: true });
    }
  });
});
