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

export interface SessionNote {
  chatId: ChatId;
  key: string;
  content: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface UpsertSessionNoteResult {
  note: SessionNote;
  truncated: boolean;
  /** Present only when inserting a new key and we had to evict an old one. */
  evictedKey?: string | undefined;
}

export interface CompactOptions {
  chatId: ChatId;
  maxTokens: number;
  personaReminder: string;
  summarize: (input: string) => Promise<string>;
  force?: boolean | undefined;
  onCompaction?:
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
  upsertNote(opts: {
    chatId: ChatId;
    key: string;
    content: string;
    nowMs: number;
  }): UpsertSessionNoteResult;
  getNote(chatId: ChatId, key: string): SessionNote | null;
  listNotes(chatId: ChatId, limit?: number): SessionNote[];
}
