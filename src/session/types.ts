import type { AttachmentMeta } from '../agent/attachments.js';
import type { ChatId } from '../types/ids.js';

export type SessionRole = 'system' | 'user' | 'assistant' | 'tool';

export interface SessionMessage {
  id?: number;
  chatId: ChatId;
  role: SessionRole;
  content: string;
  createdAtMs: number;
  authorId?: string | undefined;
  authorDisplayName?: string | undefined;
  sourceMessageId?: string | undefined;
  attachments?: readonly AttachmentMeta[] | undefined;
}

export interface CompactOptions {
  chatId: ChatId;
  maxTokens: number;
  personaReminder: string;
  summarize: (input: string) => Promise<string>;
  force?: boolean | undefined;
  onSessionEnd?:
    | ((ctx: {
        chatId: ChatId;
        transcript: readonly SessionMessage[];
        summary: string;
      }) => Promise<void>)
    | undefined;
}

export interface SessionStore {
  appendMessage(msg: SessionMessage): void;
  getMessages(chatId: ChatId, limit?: number): SessionMessage[];
  estimateTokens(chatId: ChatId): number;
  compactIfNeeded(options: CompactOptions): Promise<boolean>;
}
