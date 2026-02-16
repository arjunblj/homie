import type { ChatId } from '../types/ids.js';

export type RelationshipStage = 'new' | 'acquaintance' | 'friend' | 'close';

export interface PersonRecord {
  id: string;
  displayName: string;
  channel: string;
  channelUserId: string;
  relationshipStage: RelationshipStage;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface Fact {
  id?: number;
  personId?: string;
  subject: string;
  content: string;
  createdAtMs: number;
}

export interface Episode {
  id?: number;
  chatId: ChatId;
  content: string;
  createdAtMs: number;
}

export interface Lesson {
  id?: number;
  category: string;
  content: string;
  createdAtMs: number;
}
