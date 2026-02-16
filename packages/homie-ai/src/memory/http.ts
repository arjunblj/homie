import { asChatId, type ChatId, type FactId, type PersonId } from '../types/ids.js';

import type { MemoryStore } from './store.js';
import type { Episode, Fact, Lesson, PersonRecord, RelationshipStage } from './types.js';

export interface HttpMemoryStoreOptions {
  baseUrl: string;
  token?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export class HttpMemoryStore implements MemoryStore {
  private readonly baseUrl: string;
  private readonly token?: string | undefined;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: HttpMemoryStoreOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    type JsonHeaders = Record<string, string> & { Authorization?: string | undefined };
    const h: JsonHeaders = { 'Content-Type': 'application/json' };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private async postJson<T>(pathPart: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${pathPart}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Memory HTTP ${pathPart} failed: HTTP ${res.status} ${detail}`);
    }
    return (await res.json()) as T;
  }

  public getContextPack = async (options: {
    query: string;
    chatId: ChatId;
    channelType?: string | undefined;
    participants?: string[] | undefined;
    limit?: number | undefined;
    maxChars?: number | undefined;
  }): Promise<{ context: string }> => {
    type ContextPackResponse = { context?: string };
    const body = {
      query: options.query,
      scope: 'all',
      limit: options.limit ?? 12,
      max_chars: options.maxChars ?? 6000,
      chat_id: String(options.chatId),
      channel_type: options.channelType,
      participants: options.participants,
    };
    const res = await this.postJson<ContextPackResponse>('/context_pack', body);
    return { context: (res.context ?? '').trim() };
  };

  public async trackPerson(_person: PersonRecord): Promise<void> {
    // The Madhav memory service learns entities from episodes; no-op for v1 adapter.
  }
  public async getPerson(_id: string): Promise<PersonRecord | null> {
    return null;
  }
  public async getPersonByChannelId(_channelUserId: string): Promise<PersonRecord | null> {
    return null;
  }
  public async searchPeople(_query: string): Promise<PersonRecord[]> {
    return [];
  }
  public async updateRelationshipStage(_id: string, _stage: RelationshipStage): Promise<void> {
    // No-op (server-owned).
  }

  public async updateFact(_id: FactId, _content: string): Promise<void> {}
  public async deleteFact(_id: FactId): Promise<void> {}

  public async storeFact(_fact: Fact): Promise<void> {
    // No-op (server-owned extraction).
  }
  public async getFacts(_subject: string): Promise<Fact[]> {
    return [];
  }
  public async getFactsForPerson(_personId: PersonId, _limit?: number): Promise<Fact[]> {
    return [];
  }
  public async searchFacts(_query: string, _limit?: number): Promise<Fact[]> {
    return [];
  }

  public async logEpisode(episode: Episode): Promise<void> {
    const startedAt = new Date(episode.createdAtMs).toISOString();
    await this.postJson('/log_episode', {
      source: 'homie',
      chat_id: String(episode.chatId),
      chat_name: '',
      participants: [],
      started_at: startedAt,
      ended_at: startedAt,
      topics: [],
      sentiment: null,
      raw_content: episode.content,
    });
  }

  public async searchEpisodes(query: string, limit?: number): Promise<Episode[]> {
    type SearchResult = { text?: string };
    const res = await this.postJson<SearchResult[]>('/search', {
      query,
      scope: 'episodes',
      limit: limit ?? 10,
    });

    return res.map((r) => ({
      chatId: asChatId(''),
      content: (r.text ?? '').trim(),
      createdAtMs: 0,
    }));
  }

  public async getRecentEpisodes(_chatId: ChatId, _hours?: number): Promise<Episode[]> {
    return [];
  }

  public async logLesson(lesson: Lesson): Promise<void> {
    await this.postJson('/log_lesson', {
      type: 'observation',
      what_happened: lesson.category,
      the_lesson: lesson.content,
      context: '',
    });
  }
  public async getLessons(_category?: string): Promise<Lesson[]> {
    return [];
  }

  public async deletePerson(_id: string): Promise<void> {
    // Not supported by the server API.
  }

  public async exportJson(): Promise<unknown> {
    return { ok: false, error: 'export not supported for http memory store' };
  }
  public async importJson(_data: unknown): Promise<void> {
    // Not supported.
  }
}
