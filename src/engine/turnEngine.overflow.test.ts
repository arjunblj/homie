import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import type { SessionMessage, SessionStore } from '../session/types.js';
import {
  createNoDebounceAccumulator,
  createTestConfig,
  createTestIdentity,
} from '../testing/helpers.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { TurnEngine } from './turnEngine.js';

describe('TurnEngine context overflow recovery', () => {
  test('force-compacts and retries once on context overflow error', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-engine-overflow-'));
    const identityDir = path.join(tmp, 'identity');
    const dataDir = path.join(tmp, 'data');
    try {
      await mkdir(identityDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await createTestIdentity(identityDir);

      const cfg = createTestConfig({ projectDir: tmp, identityDir, dataDir });

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
        upsertNote({ chatId, key, content, nowMs }) {
          return {
            note: { chatId, key, content, createdAtMs: nowMs, updatedAtMs: nowMs },
            truncated: false,
          };
        },
        getNote() {
          return null;
        },
        listNotes() {
          return [];
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
        accumulator: createNoDebounceAccumulator(),
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
