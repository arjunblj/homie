import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { z } from 'zod';
import type { ChatId, FactId, PersonId } from '../types/ids.js';
import { asEpisodeId, asFactId, asLessonId, asPersonId } from '../types/ids.js';
import { runSqliteMigrations } from '../util/sqlite-migrations.js';
import type { Embedder } from './embeddings.js';
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

function safeFtsQueryFromText(raw: string): string | null {
  // FTS5 MATCH is a query language, not plain text. Convert arbitrary user text into a safe query.
  const tokens =
    raw
      .toLowerCase()
      .match(/[a-z0-9]+/gu)
      ?.filter((t) => t.length >= 2) ?? [];
  const uniq = Array.from(new Set(tokens)).slice(0, 10);
  if (uniq.length === 0) return null;
  return uniq.map((t) => `"${t}"`).join(' OR ');
}

function parseVecDimFromSql(createSql: string | null | undefined): number | null {
  if (!createSql) return null;
  const m = createSql.match(/embedding\s+float\[(\d+)\]/u);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeEmbedding(vec: Float32Array, dim: number): Float32Array | null {
  if (!Number.isFinite(dim) || dim <= 0) return null;
  if (vec.length === dim) return vec;

  if (vec.length < dim) {
    // Padding with zeros preserves cosine similarity for the original subspace.
    const padded = new Float32Array(dim);
    padded.set(vec, 0);
    return padded;
  }

  // Truncation is lossy; skip instead of corrupting similarity semantics.
  return null;
}

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
  embedder?: Embedder | undefined;
}

export class SqliteMemoryStore implements MemoryStore {
  private readonly db: Database;
  private readonly embedder: Embedder | undefined;
  private readonly vecEnabled: boolean;
  private readonly vecDim: number | undefined;
  private readonly stmts: ReturnType<typeof createStatements>;

  public constructor(options: SqliteMemoryStoreOptions) {
    mkdirSync(path.dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath, { strict: true });
    this.embedder = options.embedder;
    this.vecEnabled = false;
    this.vecDim = this.embedder?.dims;
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA mmap_size = 268435456;');
    runSqliteMigrations(this.db, [schemaSql]);
    this.stmts = createStatements(this.db);

    if (this.embedder && this.vecDim) {
      try {
        sqliteVec.load(this.db);
        const desiredDim = this.vecDim;

        const existingFactsVecSql = this.db
          .query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'facts_vec'`)
          .get() as { sql: string | null } | undefined;
        const existingEpisodesVecSql = this.db
          .query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'episodes_vec'`)
          .get() as { sql: string | null } | undefined;

        const factsDim = parseVecDimFromSql(existingFactsVecSql?.sql);
        const episodesDim = parseVecDimFromSql(existingEpisodesVecSql?.sql);

        if (factsDim && factsDim !== desiredDim) {
          this.db.exec('DROP TABLE IF EXISTS facts_vec;');
        }
        if (episodesDim && episodesDim !== desiredDim) {
          this.db.exec('DROP TABLE IF EXISTS episodes_vec;');
        }

        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS facts_vec USING vec0(
            fact_id INTEGER PRIMARY KEY,
            embedding float[${desiredDim}] distance_metric=cosine
          );
          CREATE VIRTUAL TABLE IF NOT EXISTS episodes_vec USING vec0(
            episode_id INTEGER PRIMARY KEY,
            embedding float[${desiredDim}] distance_metric=cosine
          );
        `);

        this.vecEnabled = true;
      } catch {
        // sqlite-vec unavailable in this environment — vector features disabled.
        this.vecEnabled = false;
      }
    }
  }

  public async trackPerson(person: PersonRecord): Promise<void> {
    this.stmts.upsertPerson.run(
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
    const row = this.stmts.selectPersonById.get(id) as
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
    const row = this.stmts.selectPersonByChannelUserId.get(channelUserId) as
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
    const rows = this.stmts.searchPeopleLike.all(q, q) as Array<{
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
    this.stmts.updateRelationshipStage.run(stage, Date.now(), id);
  }

  public async updateFact(id: FactId, content: string): Promise<void> {
    this.stmts.updateFactContent.run(content, id);
    this.stmts.updateFactFtsContent.run(content, id);
  }

  public async deleteFact(id: FactId): Promise<void> {
    this.stmts.deleteFactFts.run(id);
    this.stmts.deleteFact.run(id);
    if (this.vecEnabled) {
      try {
        this.db.query('DELETE FROM facts_vec WHERE fact_id = ?').run(id);
      } catch {
        // vec table may not exist
      }
    }
  }

  public async storeFact(fact: Fact): Promise<void> {
    const res = this.stmts.insertFact.run(
      fact.personId ?? null,
      fact.subject,
      fact.content,
      fact.createdAtMs,
    );

    const factId = Number(res.lastInsertRowid);
    this.stmts.insertFactFts.run(fact.subject, fact.content, factId);

    if (this.embedder && this.vecEnabled && this.vecDim) {
      const vec = await this.embedder.embed(fact.content);
      const normalized = normalizeEmbedding(vec, this.vecDim);
      if (normalized) {
        try {
          this.db
            .query('INSERT OR REPLACE INTO facts_vec (fact_id, embedding) VALUES (?, ?)')
            .run(factId, normalized);
        } catch {
          // vec write failure should not break a turn
        }
      }
    }
  }

  public async getFacts(subject: string): Promise<Fact[]> {
    const rows = this.stmts.selectFactsBySubject.all(subject) as Array<{
      id: number;
      person_id: string | null;
      subject: string;
      content: string;
      created_at_ms: number;
    }>;

    return rows.map((r) => ({
      id: asFactId(r.id),
      ...(r.person_id ? { personId: asPersonId(r.person_id) } : {}),
      subject: r.subject,
      content: r.content,
      createdAtMs: r.created_at_ms,
    }));
  }

  public async getFactsForPerson(personId: PersonId, limit = 200): Promise<Fact[]> {
    const rows = this.stmts.selectFactsByPerson.all(String(personId), limit) as Array<{
      id: number;
      person_id: string | null;
      subject: string;
      content: string;
      created_at_ms: number;
    }>;

    return rows.map((r) => ({
      id: asFactId(r.id),
      ...(r.person_id ? { personId: asPersonId(r.person_id) } : {}),
      subject: r.subject,
      content: r.content,
      createdAtMs: r.created_at_ms,
    }));
  }

  public async searchFacts(query: string, limit = 20): Promise<Fact[]> {
    const safe = safeFtsQueryFromText(query);
    if (!safe) return [];

    const rows = this.stmts.searchFactsFts.all(safe, limit) as Array<{
      id: number;
      person_id: string | null;
      subject: string;
      content: string;
      created_at_ms: number;
    }>;

    return rows.map((r) => ({
      id: asFactId(r.id),
      ...(r.person_id ? { personId: asPersonId(r.person_id) } : {}),
      subject: r.subject,
      content: r.content,
      createdAtMs: r.created_at_ms,
    }));
  }

  public async hybridSearchFacts(query: string, limit = 20): Promise<Fact[]> {
    if (!this.embedder || !this.vecEnabled || !this.vecDim) {
      return this.searchFacts(query, limit);
    }

    const queryVec = await this.embedder.embed(query);
    const normalized = normalizeEmbedding(queryVec, this.vecDim);
    if (!normalized) return this.searchFacts(query, limit);

    const safe = safeFtsQueryFromText(query);
    if (!safe) {
      const rows = this.db
        .query(
          `SELECT f.id, f.person_id, f.subject, f.content, f.created_at_ms
           FROM facts_vec v
           JOIN facts f ON f.id = v.fact_id
           WHERE v.embedding MATCH ? AND k = ?
           ORDER BY distance
           LIMIT ?`,
        )
        .all(normalized, limit, limit) as Array<{
        id: number;
        person_id: string | null;
        subject: string;
        content: string;
        created_at_ms: number;
      }>;

      return rows.map((r) => ({
        id: asFactId(r.id),
        ...(r.person_id ? { personId: asPersonId(r.person_id) } : {}),
        subject: r.subject,
        content: r.content,
        createdAtMs: r.created_at_ms,
      }));
    }

    const rows = this.db
      .query(
        `WITH vec_matches AS (
          SELECT fact_id AS id, row_number() OVER (ORDER BY distance) AS rank_num
          FROM facts_vec WHERE embedding MATCH ? AND k = ?
        ),
        fts_matches AS (
          SELECT fact_id AS id, row_number() OVER (ORDER BY rank) AS rank_num
          FROM facts_fts WHERE facts_fts MATCH ? LIMIT ?
        ),
        all_ids AS (
          SELECT id FROM vec_matches
          UNION
          SELECT id FROM fts_matches
        ),
        scored AS (
          SELECT
            a.id,
            (coalesce(1.0 / (60 + f.rank_num), 0.0) + coalesce(1.0 / (60 + v.rank_num), 0.0)) AS score
          FROM all_ids a
          LEFT JOIN fts_matches f ON f.id = a.id
          LEFT JOIN vec_matches v ON v.id = a.id
        )
        SELECT f.id, f.person_id, f.subject, f.content, f.created_at_ms
        FROM scored s
        JOIN facts f ON f.id = s.id
        ORDER BY s.score DESC
        LIMIT ?`,
      )
      .all(normalized, limit, safe, limit, limit) as Array<{
      id: number;
      person_id: string | null;
      subject: string;
      content: string;
      created_at_ms: number;
    }>;

    return rows.map((r) => ({
      id: asFactId(r.id),
      ...(r.person_id ? { personId: asPersonId(r.person_id) } : {}),
      subject: r.subject,
      content: r.content,
      createdAtMs: r.created_at_ms,
    }));
  }

  public async logEpisode(episode: Episode): Promise<void> {
    const res = this.stmts.insertEpisode.run(
      episode.chatId as unknown as string,
      episode.content,
      episode.createdAtMs,
    );

    const episodeId = Number(res.lastInsertRowid);
    this.stmts.insertEpisodeFts.run(episode.content, episodeId);

    if (this.embedder && this.vecEnabled && this.vecDim) {
      const vec = await this.embedder.embed(episode.content);
      const normalized = normalizeEmbedding(vec, this.vecDim);
      if (normalized) {
        try {
          this.db
            .query('INSERT OR REPLACE INTO episodes_vec (episode_id, embedding) VALUES (?, ?)')
            .run(episodeId, normalized);
        } catch {
          // vec write failure should not break a turn
        }
      }
    }
  }

  public async searchEpisodes(query: string, limit = 20): Promise<Episode[]> {
    const safe = safeFtsQueryFromText(query);
    if (!safe) return [];

    const rows = this.stmts.searchEpisodesFts.all(safe, limit) as Array<{
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

  public async hybridSearchEpisodes(query: string, limit = 20): Promise<Episode[]> {
    if (!this.embedder || !this.vecEnabled || !this.vecDim) {
      return this.searchEpisodes(query, limit);
    }

    const queryVec = await this.embedder.embed(query);
    const normalized = normalizeEmbedding(queryVec, this.vecDim);
    if (!normalized) return this.searchEpisodes(query, limit);

    const safe = safeFtsQueryFromText(query);
    if (!safe) {
      const rows = this.db
        .query(
          `SELECT e.id, e.chat_id, e.content, e.created_at_ms
           FROM episodes_vec v
           JOIN episodes e ON e.id = v.episode_id
           WHERE v.embedding MATCH ? AND k = ?
           ORDER BY distance
           LIMIT ?`,
        )
        .all(normalized, limit, limit) as Array<{
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

    const rows = this.db
      .query(
        `WITH vec_matches AS (
          SELECT episode_id AS id, row_number() OVER (ORDER BY distance) AS rank_num
          FROM episodes_vec WHERE embedding MATCH ? AND k = ?
        ),
        fts_matches AS (
          SELECT episode_id AS id, row_number() OVER (ORDER BY rank) AS rank_num
          FROM episodes_fts WHERE episodes_fts MATCH ? LIMIT ?
        ),
        all_ids AS (
          SELECT id FROM vec_matches
          UNION
          SELECT id FROM fts_matches
        ),
        scored AS (
          SELECT
            a.id,
            (coalesce(1.0 / (60 + f.rank_num), 0.0) + coalesce(1.0 / (60 + v.rank_num), 0.0)) AS score
          FROM all_ids a
          LEFT JOIN fts_matches f ON f.id = a.id
          LEFT JOIN vec_matches v ON v.id = a.id
        )
        SELECT e.id, e.chat_id, e.content, e.created_at_ms
        FROM scored s
        JOIN episodes e ON e.id = s.id
        ORDER BY s.score DESC
        LIMIT ?`,
      )
      .all(normalized, limit, safe, limit, limit) as Array<{
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
    const rows = this.stmts.selectRecentEpisodes.all(chatId as unknown as string, since) as Array<{
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
    this.stmts.insertLesson.run(lesson.category, lesson.content, lesson.createdAtMs);
  }

  public async getLessons(category?: string): Promise<Lesson[]> {
    const rows = category
      ? (this.stmts.selectLessonsByCategory.all(category) as Array<{
          id: number;
          category: string;
          content: string;
          created_at_ms: number;
        }>)
      : (this.stmts.selectLessonsAll.all() as Array<{
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
      this.stmts.deleteFactsByPerson.run(id);
      this.stmts.deletePerson.run(id);
    });
    tx();
  }

  public async exportJson(): Promise<unknown> {
    const people = this.stmts.exportPeople.all();
    const facts = this.stmts.exportFacts.all();
    const episodes = this.stmts.exportEpisodes.all();
    const lessons = this.stmts.exportLessons.all();
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
        this.stmts.importPersonReplace.run(
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
        const res = this.stmts.importFact.run(
          f.person_id ?? null,
          f.subject,
          f.content,
          f.created_at_ms,
        );
        const id = Number(res.lastInsertRowid);
        this.stmts.importFactFts.run(f.subject, f.content, id);
      }
      for (const e of episodes) {
        const res = this.stmts.importEpisode.run(e.chat_id, e.content, e.created_at_ms);
        const id = Number(res.lastInsertRowid);
        this.stmts.importEpisodeFts.run(e.content, id);
      }
      for (const l of lessons) {
        this.stmts.importLesson.run(l.category, l.content, l.created_at_ms);
      }
    });

    tx();
  }
}

function createStatements(db: Database) {
  return {
    upsertPerson: db.query(
      `INSERT INTO people (id, display_name, channel, channel_user_id, relationship_stage, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel, channel_user_id) DO UPDATE SET
         display_name=excluded.display_name,
         updated_at_ms=excluded.updated_at_ms`,
    ),
    selectPersonById: db.query(
      `SELECT id, display_name, channel, channel_user_id, relationship_stage, created_at_ms, updated_at_ms
       FROM people WHERE id = ?`,
    ),
    selectPersonByChannelUserId: db.query(
      `SELECT id, display_name, channel, channel_user_id, relationship_stage, created_at_ms, updated_at_ms
       FROM people WHERE channel_user_id = ? LIMIT 1`,
    ),
    searchPeopleLike: db.query(
      `SELECT id, display_name, channel, channel_user_id, relationship_stage, created_at_ms, updated_at_ms
       FROM people
       WHERE display_name LIKE ? OR channel_user_id LIKE ?
       ORDER BY updated_at_ms DESC
       LIMIT 25`,
    ),
    updateRelationshipStage: db.query(
      `UPDATE people SET relationship_stage = ?, updated_at_ms = ? WHERE id = ?`,
    ),

    updateFactContent: db.query('UPDATE facts SET content = ? WHERE id = ?'),
    updateFactFtsContent: db.query('UPDATE facts_fts SET content = ? WHERE fact_id = ?'),
    deleteFactFts: db.query('DELETE FROM facts_fts WHERE fact_id = ?'),
    deleteFact: db.query('DELETE FROM facts WHERE id = ?'),
    insertFact: db.query(
      `INSERT INTO facts (person_id, subject, content, created_at_ms)
       VALUES (?, ?, ?, ?)`,
    ),
    insertFactFts: db.query(`INSERT INTO facts_fts (subject, content, fact_id) VALUES (?, ?, ?)`),
    selectFactsBySubject: db.query(
      `SELECT id, person_id, subject, content, created_at_ms
       FROM facts
       WHERE subject = ?
       ORDER BY created_at_ms DESC
       LIMIT 200`,
    ),
    selectFactsByPerson: db.query(
      `SELECT id, person_id, subject, content, created_at_ms
       FROM facts
       WHERE person_id = ?
       ORDER BY created_at_ms DESC
       LIMIT ?`,
    ),
    searchFactsFts: db.query(
      `SELECT f.id, f.person_id, f.subject, f.content, f.created_at_ms
       FROM facts_fts
       JOIN facts f ON f.id = facts_fts.fact_id
       WHERE facts_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    ),

    insertEpisode: db.query(
      `INSERT INTO episodes (chat_id, content, created_at_ms) VALUES (?, ?, ?)`,
    ),
    insertEpisodeFts: db.query(`INSERT INTO episodes_fts (content, episode_id) VALUES (?, ?)`),
    searchEpisodesFts: db.query(
      `SELECT e.id, e.chat_id, e.content, e.created_at_ms
       FROM episodes_fts
       JOIN episodes e ON e.id = episodes_fts.episode_id
       WHERE episodes_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    ),
    selectRecentEpisodes: db.query(
      `SELECT id, chat_id, content, created_at_ms
       FROM episodes
       WHERE chat_id = ? AND created_at_ms >= ?
       ORDER BY created_at_ms DESC
       LIMIT 200`,
    ),

    insertLesson: db.query(
      `INSERT INTO lessons (category, content, created_at_ms) VALUES (?, ?, ?)`,
    ),
    selectLessonsByCategory: db.query(
      `SELECT id, category, content, created_at_ms
       FROM lessons
       WHERE category = ?
       ORDER BY created_at_ms DESC
       LIMIT 500`,
    ),
    selectLessonsAll: db.query(
      `SELECT id, category, content, created_at_ms
       FROM lessons
       ORDER BY created_at_ms DESC
       LIMIT 500`,
    ),

    deleteFactsByPerson: db.query(`DELETE FROM facts WHERE person_id = ?`),
    deletePerson: db.query(`DELETE FROM people WHERE id = ?`),

    exportPeople: db.query(`SELECT * FROM people`),
    exportFacts: db.query(`SELECT * FROM facts`),
    exportEpisodes: db.query(`SELECT * FROM episodes`),
    exportLessons: db.query(`SELECT * FROM lessons`),

    importPersonReplace: db.query(
      `INSERT OR REPLACE INTO people (id, display_name, channel, channel_user_id, relationship_stage, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    importFact: db.query(
      `INSERT INTO facts (person_id, subject, content, created_at_ms) VALUES (?, ?, ?, ?)`,
    ),
    importFactFts: db.query(`INSERT INTO facts_fts (subject, content, fact_id) VALUES (?, ?, ?)`),
    importEpisode: db.query(
      `INSERT INTO episodes (chat_id, content, created_at_ms) VALUES (?, ?, ?)`,
    ),
    importEpisodeFts: db.query(`INSERT INTO episodes_fts (content, episode_id) VALUES (?, ?)`),
    importLesson: db.query(
      `INSERT INTO lessons (category, content, created_at_ms) VALUES (?, ?, ?)`,
    ),
  } as const;
}
