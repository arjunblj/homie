import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from '../agent/types.js';
import type { CompleteParams, CompletionResult, LLMBackend } from '../backend/types.js';
import { SqliteMemoryStore } from '../memory/sqlite.js';
import type { SessionMessage, SessionStore } from '../session/types.js';
import type { ChatId } from '../types/ids.js';
import { asChatId, asMessageId } from '../types/ids.js';

/**
 * Creates a mock LLM backend that returns predefined responses.
 */
export function createMockBackend(responses: readonly [string, ...string[]]): LLMBackend {
  let index = 0;
  return {
    async complete(_params: CompleteParams): Promise<CompletionResult> {
      const response = responses[index % responses.length] ?? responses[0];
      index += 1;
      return { text: response, steps: [{ type: 'llm', text: response }] };
    },
  };
}

/**
 * Creates a mock session store with predefined messages.
 */
export function createMockSession(messages: SessionMessage[]): SessionStore {
  const messageMap = new Map<ChatId, SessionMessage[]>();
  const chatId = messages[0]?.chatId ?? asChatId('test-chat');
  messageMap.set(chatId, messages);

  return {
    appendMessage(msg: SessionMessage) {
      const existing = messageMap.get(msg.chatId) ?? [];
      messageMap.set(msg.chatId, [...existing, msg]);
    },
    getMessages(chatId: ChatId, limit?: number) {
      const msgs = messageMap.get(chatId) ?? [];
      return limit ? msgs.slice(-limit) : msgs;
    },
    estimateTokens(chatId: ChatId) {
      const msgs = messageMap.get(chatId) ?? [];
      return msgs.reduce((sum, msg) => sum + msg.content.length / 4, 0);
    },
    async compactIfNeeded() {
      return false;
    },
  };
}

/**
 * Creates a temporary SQLite memory store for testing.
 * Returns a cleanup function that should be called in test teardown.
 */
export async function createTestMemoryStore(): Promise<{
  store: SqliteMemoryStore;
  cleanup: () => Promise<void>;
}> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-test-memory-'));
  const dbPath = path.join(tmp, 'memory.db');
  const store = new SqliteMemoryStore({ dbPath });

  return {
    store,
    cleanup: async () => {
      store.close();
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

/**
 * Creates a test incoming message with sensible defaults.
 */
export function createTestMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channel: 'cli',
    chatId: asChatId('test-chat'),
    messageId: asMessageId('test-msg'),
    authorId: 'test-user',
    text: 'test message',
    isGroup: false,
    isOperator: false,
    timestampMs: Date.now(),
    ...overrides,
  };
}

/**
 * Creates a test session message with sensible defaults.
 */
export function createTestSessionMessage(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id: 1,
    chatId: asChatId('test-chat'),
    role: 'user',
    authorId: 'test-user',
    content: 'test message',
    createdAtMs: Date.now(),
    ...overrides,
  };
}
