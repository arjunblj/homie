import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ChatId } from '../types/ids.js';
import { asEpisodeId, asFactId, asLessonId, asPersonId } from '../types/ids.js';
import type { MemoryStore } from './store.js';
import type { Episode, Fact, Lesson, PersonRecord, RelationshipStage } from './types.js';

const schemaSql = `
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  channel TEXT NOT NULL,
  channel_user_id TEXT NOT NULL,
  relationship_stage TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_people_channel_user_id
  ON people(channel, channel_user_id);

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT,
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  subject,
  content,
  fact_id UNINDEXED
);

CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  content,
  episode_id UNINDEXED
);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
`;

const normalizeStage = (s: string): RelationshipStage => {
  if (s === 'new' || s === 'acquaintance' || s === 'friend' || s === 'close') return s;
  return 'new';
};

const ImportPayloadSchema = z
  .object({
    people: z
      .array(
        z.object({
          id: z.string().min(1),
          display_name: z.string(),
          channel: z.string(),
          channel_user_id: z.string(),
          relationship_stage: z.string(),
          created_at_ms: z.number(),
          updated_at_ms: z.number(),
        }),
      )
      .default([]),
    facts: z
      .array(
        z.object({
          person_id: z.string().nullable().optional(),
          subject: z.string(),
          content: z.string(),
          created_at_ms: z.number(),
        }),
      )
      .default([]),
    episodes: z
      .array(
        z.object({
          chat_id: z.string(),
          content: z.string(),
          created_at_ms: z.number(),
        }),
      )
      .default([]),
    lessons: z
      .array(
        z.object({
          category: z.string(),
          content: z.string(),
          created_at_ms: z.number(),
        }),
      )
      .default([]),
  })
  .strict();

export interface SqliteMemoryStoreOptions {
  dbPath: string;
}

export class SqliteMemoryStore implements MemoryStore {
  private readonly db: Database;

  public constructor(options: SqliteMemoryStoreOptions) {
    mkdirSync(path.dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA mmap_size = 268435456;');
    this.db.exec(schemaSql);
  }

  public async trackPerson(person: PersonRecord): Promise<void> {
    this.db
      .query(
        `INSERT INTO people (id, display_name, channel, channel_user_id, relationship_stage, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           display_name=excluded.display_name,
           relationship_stage=excluded.relationship_stage,
           updated_at_ms=excluded.updated_at_ms`,
      )
      .run(
        person.id,
        person.displayName,
        person.channel,
        person.channelUserId,
        person.relationshipStage,
        person.createdAtMs,
        person.updatedAtMs,
      );
  }

  public async getPerson(id: string): Promise<PersonRecord | null> {
    const row = this.db
      .query(
        `SELECT id, display_name, channel, channel_user_id, relationship_stage, created_at_ms, updated_at_ms
         FROM people WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          display_name: string;
          channel: string;
          channel_user_id: string;
          relationship_stage: string;
          created_at_ms: number;
          updated_at_ms: number;
        }
      | undefined;
    if (!row) return null;
    return {
      id: asPersonId(row.id),
      displayName: row.display_name,
      channel: row.channel,
      channelUserId: row.channel_user_id,
      relationshipStage: normalizeStage(row.relationship_stage),
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    };
  }

  public async getPersonByChannelId(channelUserId: string): Promise<PersonRecord | null> {
    const row = this.db
      .query(
        `SELECT id, display_name, channel, channel_user_id, relationship_stage, created_at_ms, updated_at_ms
         FROM people WHERE channel_user_id = ? LIMIT 1`,
      )
      .get(channelUserId) as
      | {
          id: string;
          display_name: string;
          channel: string;
          channel_user_id: string;
          relationship_stage: string;
          created_at_ms: number;
          updated_at_ms: number;
        }
      | undefined;
    if (!row) return null;
    return {
      id: asPersonId(row.id),
      displayName: row.display_name,
      channel: row.channel,
      channelUserId: row.channel_user_id,
      relationshipStage: normalizeStage(row.relationship_stage),
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    };
  }

  public async searchPeople(query: string): Promise<PersonRecord[]> {
    const q = `%${query}%`;
    const rows = this.db
      .query(
        `SELECT id, display_name, channel, channel_user_id, relationship_stage, created_at_ms, updated_at_ms
         FROM people
         WHERE display_name LIKE ? OR channel_user_id LIKE ?
         ORDER BY updated_at_ms DESC
         LIMIT 25`,
      )
      .all(q, q) as Array<{
      id: string;
      display_name: string;
      channel: string;
      channel_user_id: string;
      relationship_stage: string;
      created_at_ms: number;
      updated_at_ms: number;
    }>;

    return rows.map((row) => ({
      id: asPersonId(row.id),
      displayName: row.display_name,
      channel: row.channel,
      channelUserId: row.channel_user_id,
      relationshipStage: normalizeStage(row.relationship_stage),
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    }));
  }

  public async updateRelationshipStage(id: string, stage: RelationshipStage): Promise<void> {
    this.db
      .query(`UPDATE people SET relationship_stage = ?, updated_at_ms = ? WHERE id = ?`)
      .run(stage, Date.now(), id);
  }

  public async storeFact(fact: Fact): Promise<void> {
    const res = this.db
      .query(
        `INSERT INTO facts (person_id, subject, content, created_at_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .run(fact.personId ?? null, fact.subject, fact.content, fact.createdAtMs);

    const factId = Number(res.lastInsertRowid);
    this.db
      .query(`INSERT INTO facts_fts (subject, content, fact_id) VALUES (?, ?, ?)`)
      .run(fact.subject, fact.content, factId);
  }

  public async getFacts(subject: string): Promise<Fact[]> {
    const rows = this.db
      .query(
        `SELECT id, person_id, subject, content, created_at_ms
         FROM facts
         WHERE subject = ?
         ORDER BY created_at_ms DESC
         LIMIT 200`,
      )
      .all(subject) as Array<{
      id: number;
      person_id: string | null;
      subject: string;
      content: string;
      created_at_ms: number;
    }>;

    return rows.map((r) => ({
      id: asFactId(r.id),
      ...(r.person_id ? { personId: r.person_id } : {}),
      subject: r.subject,
      content: r.content,
      createdAtMs: r.created_at_ms,
    }));
  }

  public async searchFacts(query: string, limit = 20): Promise<Fact[]> {
    const rows = this.db
      .query(
        `SELECT f.id, f.person_id, f.subject, f.content, f.created_at_ms
         FROM facts_fts
         JOIN facts f ON f.id = facts_fts.fact_id
         WHERE facts_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit) as Array<{
      id: number;
      person_id: string | null;
      subject: string;
      content: string;
      created_at_ms: number;
    }>;

    return rows.map((r) => ({
      id: asFactId(r.id),
      ...(r.person_id ? { personId: r.person_id } : {}),
      subject: r.subject,
      content: r.content,
      createdAtMs: r.created_at_ms,
    }));
  }

  public async logEpisode(episode: Episode): Promise<void> {
    const res = this.db
      .query(`INSERT INTO episodes (chat_id, content, created_at_ms) VALUES (?, ?, ?)`)
      .run(episode.chatId as unknown as string, episode.content, episode.createdAtMs);

    const episodeId = Number(res.lastInsertRowid);
    this.db
      .query(`INSERT INTO episodes_fts (content, episode_id) VALUES (?, ?)`)
      .run(episode.content, episodeId);
  }

  public async searchEpisodes(query: string, limit = 20): Promise<Episode[]> {
    const rows = this.db
      .query(
        `SELECT e.id, e.chat_id, e.content, e.created_at_ms
         FROM episodes_fts
         JOIN episodes e ON e.id = episodes_fts.episode_id
         WHERE episodes_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit) as Array<{
      id: number;
      chat_id: string;
      content: string;
      created_at_ms: number;
    }>;

    return rows.map((r) => ({
      id: asEpisodeId(r.id),
      chatId: r.chat_id as unknown as ChatId,
      content: r.content,
      createdAtMs: r.created_at_ms,
    }));
  }

  public async getRecentEpisodes(chatId: ChatId, hours = 24): Promise<Episode[]> {
    const since = Date.now() - hours * 60 * 60 * 1000;
    const rows = this.db
      .query(
        `SELECT id, chat_id, content, created_at_ms
         FROM episodes
         WHERE chat_id = ? AND created_at_ms >= ?
         ORDER BY created_at_ms DESC
         LIMIT 200`,
      )
      .all(chatId as unknown as string, since) as Array<{
      id: number;
      chat_id: string;
      content: string;
      created_at_ms: number;
    }>;

    return rows.map((r) => ({
      id: asEpisodeId(r.id),
      chatId: r.chat_id as unknown as ChatId,
      content: r.content,
      createdAtMs: r.created_at_ms,
    }));
  }

  public async logLesson(lesson: Lesson): Promise<void> {
    this.db
      .query(`INSERT INTO lessons (category, content, created_at_ms) VALUES (?, ?, ?)`)
      .run(lesson.category, lesson.content, lesson.createdAtMs);
  }

  public async getLessons(category?: string): Promise<Lesson[]> {
    const rows = category
      ? (this.db
          .query(
            `SELECT id, category, content, created_at_ms FROM lessons WHERE category = ? ORDER BY created_at_ms DESC LIMIT 500`,
          )
          .all(category) as Array<{
          id: number;
          category: string;
          content: string;
          created_at_ms: number;
        }>)
      : (this.db
          .query(
            `SELECT id, category, content, created_at_ms FROM lessons ORDER BY created_at_ms DESC LIMIT 500`,
          )
          .all() as Array<{
          id: number;
          category: string;
          content: string;
          created_at_ms: number;
        }>);

    return rows.map((r) => ({
      id: asLessonId(r.id),
      category: r.category,
      content: r.content,
      createdAtMs: r.created_at_ms,
    }));
  }

  public async deletePerson(id: string): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.query(`DELETE FROM facts WHERE person_id = ?`).run(id);
      this.db.query(`DELETE FROM people WHERE id = ?`).run(id);
    });
    tx();
  }

  public async exportJson(): Promise<unknown> {
    const people = this.db.query(`SELECT * FROM people`).all();
    const facts = this.db.query(`SELECT * FROM facts`).all();
    const episodes = this.db.query(`SELECT * FROM episodes`).all();
    const lessons = this.db.query(`SELECT * FROM lessons`).all();
    return { people, facts, episodes, lessons };
  }

  public async importJson(data: unknown): Promise<void> {
    const parsed = ImportPayloadSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`Invalid import payload: ${parsed.error.message}`);
    }

    const { people, facts, episodes, lessons } = parsed.data;

    const tx = this.db.transaction(() => {
      for (const p of people) {
        this.db
          .query(
            `INSERT OR REPLACE INTO people (id, display_name, channel, channel_user_id, relationship_stage, created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            p.id,
            p.display_name,
            p.channel,
            p.channel_user_id,
            p.relationship_stage,
            p.created_at_ms,
            p.updated_at_ms,
          );
      }
      for (const f of facts) {
        const res = this.db
          .query(
            `INSERT INTO facts (person_id, subject, content, created_at_ms) VALUES (?, ?, ?, ?)`,
          )
          .run(f.person_id ?? null, f.subject, f.content, f.created_at_ms);
        const id = Number(res.lastInsertRowid);
        this.db
          .query(`INSERT INTO facts_fts (subject, content, fact_id) VALUES (?, ?, ?)`)
          .run(f.subject, f.content, id);
      }
      for (const e of episodes) {
        const res = this.db
          .query(`INSERT INTO episodes (chat_id, content, created_at_ms) VALUES (?, ?, ?)`)
          .run(e.chat_id, e.content, e.created_at_ms);
        const id = Number(res.lastInsertRowid);
        this.db
          .query(`INSERT INTO episodes_fts (content, episode_id) VALUES (?, ?)`)
          .run(e.content, id);
      }
      for (const l of lessons) {
        this.db
          .query(`INSERT INTO lessons (category, content, created_at_ms) VALUES (?, ?, ?)`)
          .run(l.category, l.content, l.created_at_ms);
      }
    });

    tx();
  }
}
