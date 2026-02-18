import type { ChatId, FactId, PersonId } from '../types/ids.js';

import type { Episode, Fact, Lesson, PersonRecord, RelationshipStage } from './types.js';

export interface MemoryStore {
  trackPerson(person: PersonRecord): Promise<void>;
  getPerson(id: string): Promise<PersonRecord | null>;
  getPersonByChannelId(channelUserId: string): Promise<PersonRecord | null>;
  searchPeople(query: string): Promise<PersonRecord[]>;
  listPeople(limit?: number, offset?: number): Promise<PersonRecord[]>;
  updateRelationshipStage(id: string, stage: RelationshipStage): Promise<void>;
  updatePersonCapsule(personId: PersonId, capsule: string | null): Promise<void>;
  updatePublicStyleCapsule(personId: PersonId, capsule: string | null): Promise<void>;

  getGroupCapsule(chatId: ChatId): Promise<string | null>;
  upsertGroupCapsule(chatId: ChatId, capsule: string | null, updatedAtMs: number): Promise<void>;

  markGroupCapsuleDirty(chatId: ChatId, atMs: number): Promise<void>;
  claimDirtyGroupCapsules(limit: number): Promise<ChatId[]>;
  completeDirtyGroupCapsule(chatId: ChatId): Promise<void>;

  markPublicStyleDirty(personId: PersonId, atMs: number): Promise<void>;
  claimDirtyPublicStyles(limit: number): Promise<PersonId[]>;
  completeDirtyPublicStyle(personId: PersonId): Promise<void>;

  storeFact(fact: Fact): Promise<void>;
  updateFact(id: FactId, content: string): Promise<void>;
  deleteFact(id: FactId): Promise<void>;
  getFacts(subject: string): Promise<Fact[]>;
  getFactsForPerson(personId: PersonId, limit?: number): Promise<Fact[]>;
  searchFacts(query: string, limit?: number): Promise<Fact[]>;
  hybridSearchFacts(query: string, limit?: number): Promise<Fact[]>;
  touchFacts(ids: readonly FactId[], atMs: number): Promise<void>;

  logEpisode(episode: Episode): Promise<void>;
  countEpisodes(chatId: ChatId): Promise<number>;
  searchEpisodes(query: string, limit?: number): Promise<Episode[]>;
  hybridSearchEpisodes(query: string, limit?: number): Promise<Episode[]>;
  getRecentEpisodes(chatId: ChatId, hours?: number): Promise<Episode[]>;
  getRecentGroupEpisodesForPerson(personId: PersonId, hours?: number): Promise<Episode[]>;

  logLesson(lesson: Lesson): Promise<void>;
  getLessons(category?: string, limit?: number): Promise<Lesson[]>;

  deletePerson(id: string): Promise<void>;

  exportJson(): Promise<unknown>;
  importJson(data: unknown): Promise<void>;
}
