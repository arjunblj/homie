import type { ChatId } from '../types/ids.js';

import type { Episode, Fact, Lesson, PersonRecord, RelationshipStage } from './types.js';

export interface MemoryStore {
  trackPerson(person: PersonRecord): Promise<void>;
  getPerson(id: string): Promise<PersonRecord | null>;
  getPersonByChannelId(channelUserId: string): Promise<PersonRecord | null>;
  searchPeople(query: string): Promise<PersonRecord[]>;
  updateRelationshipStage(id: string, stage: RelationshipStage): Promise<void>;

  storeFact(fact: Fact): Promise<void>;
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
