import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LLMBackend } from '../backend/types.js';
import type { HomieConfig } from '../config/types.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { AgentRuntime } from './runtime.js';
import type { IncomingMessage } from './types.js';

const baseConfig: HomieConfig = {
  schemaVersion: 1,
  model: {
    provider: { kind: 'anthropic' },
    models: { default: 'claude-sonnet-4-5', fast: 'claude-haiku-4-5' },
  },
  behavior: {
    sleep: { enabled: true, timezone: 'UTC', startLocal: '23:00', endLocal: '07:00' },
    groupMaxChars: 240,
    dmMaxChars: 420,
    minDelayMs: 0,
    maxDelayMs: 0,
    debounceMs: 0,
  },
  tools: { shell: false },
  paths: {
    projectDir: '/tmp/project',
    identityDir: '/tmp/project/identity',
    skillsDir: '/tmp/project/skills',
    dataDir: '/tmp/project/data',
  },
};

const silentBackend: LLMBackend = {
  async complete() {
    return { text: '   ', steps: [] };
  },
};

describe('AgentRuntime', () => {
  test('treats empty output as silence', async () => {
    const identityDir = await mkdtemp(path.join(os.tmpdir(), 'homie-identity-'));
    try {
      await writeFile(path.join(identityDir, 'SOUL.md'), 'soul', 'utf8');
      await writeFile(path.join(identityDir, 'STYLE.md'), 'style', 'utf8');
      await writeFile(path.join(identityDir, 'USER.md'), 'user', 'utf8');
      await writeFile(path.join(identityDir, 'first-meeting.md'), 'hi', 'utf8');
      await writeFile(
        path.join(identityDir, 'personality.json'),
        JSON.stringify({ traits: ['x'], voiceRules: ['y'], antiPatterns: [] }),
        'utf8',
      );

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
