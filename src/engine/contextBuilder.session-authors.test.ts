import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IncomingMessage } from '../agent/types.js';
import {
  DEFAULT_BEHAVIOR,
  DEFAULT_ENGINE,
  DEFAULT_MEMORY,
  DEFAULT_MODEL,
  DEFAULT_PROACTIVE,
  DEFAULT_TOOLS,
} from '../config/defaults.js';
import type { OpenhomieConfig } from '../config/types.js';
import { SqliteSessionStore } from '../session/sqlite.js';
import { asChatId, asMessageId } from '../types/ids.js';
import { ContextBuilder } from './contextBuilder.js';

const baseConfig = (
  projectDir: string,
  identityDir: string,
  skillsDir: string,
  dataDir: string,
): OpenhomieConfig => ({
  schemaVersion: 1,
  model: DEFAULT_MODEL,
  engine: DEFAULT_ENGINE,
  behavior: { ...DEFAULT_BEHAVIOR, minDelayMs: 0, maxDelayMs: 0, debounceMs: 0 },
  proactive: DEFAULT_PROACTIVE,
  memory: { ...DEFAULT_MEMORY, enabled: false },
  tools: DEFAULT_TOOLS,
  paths: { projectDir, identityDir, skillsDir, dataDir, bootstrapDocs: [] },
});

describe('ContextBuilder session authors', () => {
  test('renders group history with author labels; DM history without labels', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-context-session-authors-'));
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

      const groupChatId = asChatId('cli:group');
      const dmChatId = asChatId('cli:dm');
      const now = Date.now();

      // Group: persist an earlier message from Alice, then a current one from Bob.
      sessionStore.appendMessage({
        chatId: groupChatId,
        role: 'user',
        content: 'hi',
        createdAtMs: now,
        authorId: 'u1',
        authorDisplayName: 'Alice]\n',
        sourceMessageId: 'm1',
      });
      sessionStore.appendMessage({
        chatId: groupChatId,
        role: 'user',
        content: 'sup',
        createdAtMs: now + 1,
        authorId: 'u2',
        authorDisplayName: 'Bob',
        sourceMessageId: 'm2',
      });

      // DM: even if metadata exists, we keep history content plain.
      sessionStore.appendMessage({
        chatId: dmChatId,
        role: 'user',
        content: 'hi',
        createdAtMs: now,
        authorId: 'u1',
        authorDisplayName: 'Alice',
        sourceMessageId: 'm3',
      });
      sessionStore.appendMessage({
        chatId: dmChatId,
        role: 'user',
        content: 'sup',
        createdAtMs: now + 1,
        authorId: 'u1',
        authorDisplayName: 'Alice',
        sourceMessageId: 'm4',
      });

      const groupMsg: IncomingMessage = {
        channel: 'cli',
        chatId: groupChatId,
        messageId: asMessageId('m2'),
        authorId: 'u2',
        authorDisplayName: 'Bob',
        text: 'sup',
        isGroup: true,
        isOperator: true,
        mentioned: true,
        timestampMs: now + 1,
      };
      const groupCtx = await cb.buildReactiveModelContext({
        msg: groupMsg,
        excludeSourceMessageIds: ['m2'],
        tools: undefined,
        toolsForMessage: () => undefined,
        toolGuidance: () => '',
        identityPrompt: 'IDENTITY',
      });
      // Since the incoming message is already persisted, the most-recent user message is removed
      // from history to avoid doubling. We should still keep the earlier labeled message.
      expect(groupCtx.historyForModel.length).toBe(1);
      expect(groupCtx.historyForModel[0]?.content).toBe('[from Alice] hi');

      const dmMsg: IncomingMessage = {
        channel: 'cli',
        chatId: dmChatId,
        messageId: asMessageId('m4'),
        authorId: 'u1',
        authorDisplayName: 'Alice',
        text: 'sup',
        isGroup: false,
        isOperator: true,
        mentioned: true,
        timestampMs: now + 1,
      };
      const dmCtx = await cb.buildReactiveModelContext({
        msg: dmMsg,
        excludeSourceMessageIds: ['m4'],
        tools: undefined,
        toolsForMessage: () => undefined,
        toolGuidance: () => '',
        identityPrompt: 'IDENTITY',
      });
      expect(dmCtx.historyForModel.length).toBe(1);
      expect(dmCtx.historyForModel[0]?.content).toBe('hi');

      sessionStore.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
