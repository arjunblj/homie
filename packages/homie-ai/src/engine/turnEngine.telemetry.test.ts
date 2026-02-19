import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import { DEFAULT_ENGINE, DEFAULT_MEMORY } from '../config/defaults.js';
import type { HomieConfig } from '../config/types.js';
import type { TelemetryStore } from '../telemetry/types.js';
import { createNoDebounceAccumulator } from '../testing/helpers.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { TurnEngine } from './turnEngine.js';

const baseConfig = (projectDir: string, identityDir: string, dataDir: string): HomieConfig => ({
  schemaVersion: 1,
  model: {
    provider: { kind: 'anthropic' },
    models: { default: 'claude-sonnet-4-5', fast: 'claude-haiku-4-5' },
  },
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
    heartbeatIntervalMs: 1_800_000,
    dm: {
      maxPerDay: 1,
      maxPerWeek: 3,
      cooldownAfterUserMs: 7_200_000,
      pauseAfterIgnored: 2,
    },
    group: {
      maxPerDay: 1,
      maxPerWeek: 1,
      cooldownAfterUserMs: 12 * 60 * 60_000,
      pauseAfterIgnored: 1,
    },
  },
  memory: DEFAULT_MEMORY,
  tools: {
    restricted: { enabledForOperator: true, allowlist: [] },
    dangerous: { enabledForOperator: false, allowAll: false, allowlist: [] },
  },
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

describe('TurnEngine telemetry hardening', () => {
  test('does not fail turns when telemetry.logTurn throws', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-telemetry-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeIdentity(identityDir);

      const cfg = baseConfig(tmp, identityDir, dataDir);
      const backend: LLMBackend = {
        async complete() {
          return { text: 'yo', steps: [] };
        },
      };
      const telemetry: TelemetryStore = {
        ping() {},
        close() {},
        logTurn() {
          throw new Error('boom');
        },
        logLlmCall() {},
        getUsageSummary(windowMs) {
          return {
            windowMs,
            turns: 0,
            llmCalls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          };
        },
        getLlmUsageSummary(windowMs) {
          return {
            windowMs,
            turns: 0,
            llmCalls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          };
        },
      };

      const engine = new TurnEngine({
        config: cfg,
        backend,
        telemetry,
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
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
