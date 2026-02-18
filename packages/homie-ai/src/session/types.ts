import type { ChatId } from '../types/ids.js';

export type SessionRole = 'system' | 'user' | 'assistant' | 'tool';

export interface SessionMessage {
  id?: number;
  chatId: ChatId;
  role: SessionRole;
  content: string;
  createdAtMs: number;
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
