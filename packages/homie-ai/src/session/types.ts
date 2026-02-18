import type { ChatId } from '../types/ids.js';

export type SessionRole = 'system' | 'user' | 'assistant' | 'tool';

export interface SessionMessage {
  id?: number;
  chatId: ChatId;
  role: SessionRole;
  content: string;
  createdAtMs: number;
  /**
   * Author metadata for user messages (required for safe group history + group memory).
   * Optional for backwards compatibility with existing DB rows and for non-user roles.
   */
  authorId?: string | undefined;
  authorDisplayName?: string | undefined;
  /**
   * Source platform message id for traceability / adapter-level threading.
   * Usually equals the incoming `IncomingMessage.messageId` (string).
   */
  sourceMessageId?: string | undefined;
  mentioned?: boolean | undefined;
  isGroup?: boolean | undefined;
}

export interface CompactOptions {
  chatId: ChatId;
  maxTokens: number;
  personaReminder: string;
  summarize: (input: string) => Promise<string>;
  force?: boolean | undefined;
}

export interface SessionStore {
  appendMessage(msg: SessionMessage): void;
  getMessages(chatId: ChatId, limit?: number): SessionMessage[];
  estimateTokens(chatId: ChatId): number;
  compactIfNeeded(options: CompactOptions): Promise<boolean>;
}
