import type { ChatId, EpisodeId, FactId, LessonId, PersonId } from '../types/ids.js';

export type RelationshipStage = 'new' | 'acquaintance' | 'friend' | 'close';

export interface PersonRecord {
  id: PersonId;
  displayName: string;
  channel: string;
  channelUserId: string;
  relationshipStage: RelationshipStage;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface Fact {
  id?: FactId;
  personId?: string;
  subject: string;
  content: string;
  createdAtMs: number;
}

export interface Episode {
  id?: EpisodeId;
  chatId: ChatId;
  content: string;
  createdAtMs: number;
}

export interface Lesson {
  id?: LessonId;
  category: string;
  content: string;
  createdAtMs: number;
}
