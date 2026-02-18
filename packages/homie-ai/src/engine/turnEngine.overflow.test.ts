import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import { DEFAULT_ENGINE, DEFAULT_MEMORY } from '../config/defaults.js';
import type { HomieConfig } from '../config/types.js';
import type { SessionMessage, SessionStore } from '../session/types.js';
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

describe('TurnEngine context overflow recovery', () => {
  test('force-compacts and retries once on context overflow error', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-overflow-'));
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
        },
        memory: DEFAULT_MEMORY,
        tools: {
          restricted: { enabledForOperator: true, allowlist: [] },
          dangerous: { enabledForOperator: false, allowAll: false, allowlist: [] },
        },
        paths: { projectDir: tmp, identityDir, skillsDir: path.join(tmp, 'skills'), dataDir },
      };

      const messages: SessionMessage[] = Array.from({ length: 30 }, (_, i) => ({
        chatId: asChatId('c'),
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `m${i}`,
        createdAtMs: i + 1,
      }));

      let sawForce = false;
      const sessionStore: SessionStore = {
        appendMessage(msg) {
          messages.push(msg);
        },
        getMessages() {
          return messages;
        },
        estimateTokens() {
          return 999_999;
        },
        async compactIfNeeded(opts) {
          if (opts.force) {
            sawForce = true;
            // Exercise summarize callback for coverage; we don't care about its content.
            await opts.summarize('x');
            return true;
          }
          return false;
        },
      };

      let defaultCalls = 0;
      const backend: LLMBackend = {
        async complete(params) {
          if (params.role === 'fast') return { text: 'summary', steps: [] };
          defaultCalls += 1;
          if (defaultCalls === 1) {
            throw new Error('context length exceeded');
          }
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
      expect(sawForce).toBe(true);
      expect(defaultCalls).toBe(2);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
