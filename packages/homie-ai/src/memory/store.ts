import type { ChatId, FactId } from '../types/ids.js';

import type { Episode, Fact, Lesson, PersonRecord, RelationshipStage } from './types.js';

export interface MemoryStore {
  getContextPack?: (options: {
    query: string;
    chatId: ChatId;
    channelType?: string | undefined;
    participants?: string[] | undefined;
    limit?: number | undefined;
    maxChars?: number | undefined;
  }) => Promise<{ context: string }>;

  trackPerson(person: PersonRecord): Promise<void>;
  getPerson(id: string): Promise<PersonRecord | null>;
  getPersonByChannelId(channelUserId: string): Promise<PersonRecord | null>;
  searchPeople(query: string): Promise<PersonRecord[]>;
  updateRelationshipStage(id: string, stage: RelationshipStage): Promise<void>;

  storeFact(fact: Fact): Promise<void>;
  updateFact(id: FactId, content: string): Promise<void>;
  deleteFact(id: FactId): Promise<void>;
  getFacts(subject: string): Promise<Fact[]>;
  searchFacts(query: string, limit?: number): Promise<Fact[]>;

  logEpisode(episode: Episode): Promise<void>;
  searchEpisodes(query: string, limit?: number): Promise<Episode[]>;
  getRecentEpisodes(chatId: ChatId, hours?: number): Promise<Episode[]>;

  logLesson(lesson: Lesson): Promise<void>;
  getLessons(category?: string): Promise<Lesson[]>;

  deletePerson(id: string): Promise<void>;

  exportJson(): Promise<unknown>;
  importJson(data: unknown): Promise<void>;
}
