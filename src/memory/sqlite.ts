import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import type { ChatId, EpisodeId, FactId, LessonId, PersonId } from '../types/ids.js';
import { asEpisodeId } from '../types/ids.js';
import { fileExists } from '../util/fs.js';
import { errorFields, log } from '../util/logger.js';
import { closeSqliteBestEffort } from '../util/sqlite-close.js';
import { openSqliteStore } from '../util/sqlite-open.js';
import type { Embedder } from './embeddings.js';
import {
  extractGroupCapsuleHumanFromExisting,
  extractGroupNotesFromExisting,
  renderGroupCapsuleMd,
} from './md-mirror/group.js';
import {
  extractPersonCapsuleHumanFromExisting,
  extractPersonNotesFromExisting,
  extractPersonPublicStyleHumanFromExisting,
  renderPersonProfileMd,
} from './md-mirror/person.js';
import { EMPTY_COUNTERS, type ObservationCounters } from './observations.js';
import {
  hybridSearchEpisodes as hybridSearchEpisodesImpl,
  hybridSearchFacts as hybridSearchFactsImpl,
  type RetrievalContext,
  searchEpisodesFts,
  searchFactsFts,
} from './sqlite-retrieval.js';
import { MEMORY_MIGRATIONS } from './sqlite-schema.js';
import { createStatements, type MemoryStatements } from './sqlite-statements.js';
import {
  type FactRow,
  factRowToFact,
  ImportPayloadSchema,
  type LessonRow,
  lessonRowToLesson,
  normalizeEmbedding,
  normalizeStringArrayToJson,
  type PersonRow,
  parseRecordJson,
  parseStringArrayJson,
  parseVecDimFromSql,
  type RetrievalTuning,
  rowToPerson,
  type SqliteMemoryStoreOptions,
} from './sqlite-types.js';
import type { MemoryStore } from './store.js';
import {
  type ChatTrustTier,
  clamp01,
  type Episode,
  type Fact,
  type Lesson,
  type PersonRecord,
} from './types.js';

export type { SqliteMemoryStoreOptions } from './sqlite-types.js';

export class SqliteMemoryStore implements MemoryStore {
  private readonly logger = log.child({ component: 'sqlite_memory' });
  private readonly db: Database;
  private readonly embedder: Embedder | undefined;
  private vecEnabled: boolean;
  private readonly vecDim: number | undefined;
  private readonly stmts: MemoryStatements;
  private readonly retrieval: RetrievalTuning;
  private readonly mdMirrorDir: string;

  public constructor(options: SqliteMemoryStoreOptions) {
    this.db = openSqliteStore(options.dbPath, MEMORY_MIGRATIONS);
    this.embedder = options.embedder;
    this.vecEnabled = false;
    this.vecDim = this.embedder?.dims;
    this.stmts = createStatements(this.db);

    this.retrieval = {
      rrfK: Math.max(1, Math.floor(options.retrieval?.rrfK ?? 60)),
      ftsWeight: Math.max(0, options.retrieval?.ftsWeight ?? 0.6),
      vecWeight: Math.max(0, options.retrieval?.vecWeight ?? 0.4),
      recencyWeight: Math.max(0, options.retrieval?.recencyWeight ?? 0.2),
      halfLifeDays: Math.max(1, options.retrieval?.halfLifeDays ?? 30),
    };

    this.mdMirrorDir = path.join(path.dirname(options.dbPath), 'md');

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
      } catch (err) {
        this.logger.debug('sqlite_vec.unavailable', errorFields(err));
        this.vecEnabled = false;
      }
    }
  }

  private get retrievalCtx(): RetrievalContext {
    return {
      db: this.db,
      stmts: this.stmts,
      embedder: this.embedder,
      vecEnabled: this.vecEnabled,
      vecDim: this.vecDim,
      retrieval: this.retrieval,
    };
  }

  public ping(): void {
    this.db.query('SELECT 1').get();
  }

  public getStats(): { people: number; facts: number; episodes: number; lessons: number } {
    const people = (this.stmts.countPeople.get() as { c: number } | undefined)?.c ?? 0;
    const facts = (this.stmts.countFacts.get() as { c: number } | undefined)?.c ?? 0;
    const episodes = (this.stmts.countEpisodes.get() as { c: number } | undefined)?.c ?? 0;
    const lessons = (this.stmts.countLessons.get() as { c: number } | undefined)?.c ?? 0;
    return { people, facts, episodes, lessons };
  }

  public close(): void {
    closeSqliteBestEffort(this.db, 'sqlite_memory');
  }

  private legacySafeFileStem(raw: string): string {
    const sanitized = raw.replace(/[^a-zA-Z0-9._-]+/gu, '_').slice(0, 160);
    return sanitized || '_unknown';
  }

  private safeFileStem(raw: string): string {
    const base = raw
      .replace(/[^a-zA-Z0-9._-]+/gu, '_')
      .replace(/^_+|_+$/gu, '')
      .slice(0, 80);
    const hash = createHash('sha256').update(raw).digest('hex').slice(0, 10);
    return `${base || 'id'}--${hash}`;
  }

  private personMdPath(personId: PersonId): string {
    return path.join(this.mdMirrorDir, 'people', `${this.safeFileStem(String(personId))}.md`);
  }

  private legacyPersonMdPath(personId: PersonId): string {
    return path.join(this.mdMirrorDir, 'people', `${this.legacySafeFileStem(String(personId))}.md`);
  }

  private groupMdPath(chatId: ChatId): string {
    return path.join(this.mdMirrorDir, 'groups', `${this.safeFileStem(String(chatId))}.md`);
  }

  private legacyGroupMdPath(chatId: ChatId): string {
    return path.join(this.mdMirrorDir, 'groups', `${this.legacySafeFileStem(String(chatId))}.md`);
  }

  private async migrateMdMirrorPathBestEffort(fromPath: string, toPath: string): Promise<void> {
    try {
      if (fromPath === toPath) return;
      if (!(await fileExists(fromPath))) return;
      if (await fileExists(toPath)) return;
      await mkdir(path.dirname(toPath), { recursive: true });
      await rename(fromPath, toPath);
    } catch (err) {
      this.logger.debug('md_mirror.migrate_failed', {
        fromPath,
        toPath,
        ...errorFields(err),
      });
    }
  }

  private async readTextBestEffort(filePath: string): Promise<string> {
    try {
      if (!(await fileExists(filePath))) return '';
      return await readFile(filePath, 'utf8');
    } catch (err) {
      this.logger.debug('md_mirror.read_failed', { filePath, ...errorFields(err) });
      return '';
    }
  }

  private async writeTextBestEffort(filePath: string, content: string): Promise<void> {
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, 'utf8');
    } catch (err) {
      this.logger.debug('md_mirror.write_failed', { filePath, ...errorFields(err) });
    }
  }

  private async syncPersonMdBestEffort(personId: PersonId): Promise<void> {
    try {
      const person = await this.getPerson(String(personId));
      if (!person) return;

      const filePath = this.personMdPath(person.id);
      await this.migrateMdMirrorPathBestEffort(this.legacyPersonMdPath(person.id), filePath);
      const existing = await this.readTextBestEffort(filePath);
      const notes = existing ? extractPersonNotesFromExisting(existing) : '';
      const capsuleHuman = existing ? extractPersonCapsuleHumanFromExisting(existing) : '';
      const publicStyleHuman = existing ? extractPersonPublicStyleHumanFromExisting(existing) : '';
      const md = renderPersonProfileMd({
        person,
        capsuleHuman,
        capsuleAuto: person.capsule,
        publicStyleHuman,
        publicStyleAuto: person.publicStyleCapsule,
        notes,
      });
      await this.writeTextBestEffort(filePath, md);
    } catch (err) {
      this.logger.debug('md_mirror.sync_person_failed', errorFields(err));
    }
  }

  private async syncGroupMdBestEffort(
    chatId: ChatId,
    capsuleAuto: string | null,
    updatedAtMs: number,
  ): Promise<void> {
    try {
      const filePath = this.groupMdPath(chatId);
      await this.migrateMdMirrorPathBestEffort(this.legacyGroupMdPath(chatId), filePath);
      const existing = await this.readTextBestEffort(filePath);
      const notes = existing ? extractGroupNotesFromExisting(existing) : '';
      const capsuleHuman = existing ? extractGroupCapsuleHumanFromExisting(existing) : '';
      const md = renderGroupCapsuleMd({
        chatId,
        capsuleHuman,
        capsuleAuto: capsuleAuto ?? '',
        updatedAtMs,
        notes,
      });
      await this.writeTextBestEffort(filePath, md);
    } catch (err) {
      this.logger.debug('md_mirror.sync_group_failed', errorFields(err));
    }
  }

  public async trackPerson(person: PersonRecord): Promise<void> {
    this.stmts.upsertPerson.run(
      person.id,
      person.displayName,
      person.channel,
      person.channelUserId,
      'new',
      person.relationshipScore,
      person.trustTierOverride ?? null,
      person.capsule ?? null,
      person.capsuleUpdatedAtMs ?? null,
      person.publicStyleCapsule ?? null,
      person.createdAtMs,
      person.updatedAtMs,
    );
  }

  public async getPerson(id: string): Promise<PersonRecord | null> {
    const row = this.stmts.selectPersonById.get(id) as PersonRow | undefined;
    if (!row) return null;
    return rowToPerson(row);
  }

  public async getPersonByChannelId(channelUserId: string): Promise<PersonRecord | null> {
    const row = this.stmts.selectPersonByChannelUserId.get(channelUserId) as PersonRow | undefined;
    if (!row) return null;
    return rowToPerson(row);
  }

  public async searchPeople(query: string): Promise<PersonRecord[]> {
    const q = `%${query}%`;
    const rows = this.stmts.searchPeopleLike.all(q, q) as PersonRow[];
    return rows.map(rowToPerson);
  }

  public async listPeople(limit = 200, offset = 0): Promise<PersonRecord[]> {
    const rows = this.stmts.listPeoplePaged.all(limit, offset) as PersonRow[];
    return rows.map(rowToPerson);
  }

  public async updateRelationshipScore(id: PersonId, score: number): Promise<void> {
    const s = Number.isFinite(score) ? clamp01(score) : 0;
    this.stmts.updateRelationshipScore.run(s, Date.now(), String(id));
  }

  public async setTrustTierOverride(id: PersonId, tier: ChatTrustTier | null): Promise<void> {
    const t = tier ? String(tier) : null;
    this.stmts.updateTrustTierOverride.run(t, Date.now(), String(id));
  }

  public async updatePersonCapsule(personId: PersonId, capsule: string | null): Promise<void> {
    const now = Date.now();
    this.stmts.updatePersonCapsule.run(capsule, now, now, String(personId));
    await this.syncPersonMdBestEffort(personId);
  }

  public async updatePublicStyleCapsule(personId: PersonId, capsule: string | null): Promise<void> {
    this.stmts.updatePublicStyleCapsule.run(capsule, Date.now(), String(personId));
    await this.syncPersonMdBestEffort(personId);
  }

  public async updateStructuredPersonData(
    personId: PersonId,
    data: {
      currentConcerns?: string[] | undefined;
      goals?: string[] | undefined;
      preferences?: Record<string, string> | undefined;
      lastMoodSignal?: string | undefined;
      curiosityQuestions?: string[] | undefined;
    },
  ): Promise<void> {
    const id = String(personId);
    const existing = this.stmts.selectStructuredPersonData.get(id) as
      | {
          current_concerns_json: string | null;
          goals_json: string | null;
          preferences_json: string | null;
          last_mood_signal: string | null;
          curiosity_questions_json: string | null;
        }
      | undefined;

    const mergeArrays = (incoming: string[] | undefined, raw: string | null): string | null => {
      if (!incoming) return raw;
      const prev = raw ? (parseStringArrayJson(raw) ?? []) : [];
      const merged = Array.from(new Set([...prev, ...incoming])).slice(0, 10);
      return merged.length > 0 ? JSON.stringify(merged) : null;
    };

    const concerns = mergeArrays(data.currentConcerns, existing?.current_concerns_json ?? null);
    const goals = mergeArrays(data.goals, existing?.goals_json ?? null);
    const curiosity = mergeArrays(
      data.curiosityQuestions,
      existing?.curiosity_questions_json ?? null,
    );

    let prefsJson: string | null = existing?.preferences_json ?? null;
    if (data.preferences) {
      const prev = prefsJson ? (parseRecordJson(prefsJson) ?? {}) : {};
      prefsJson = JSON.stringify({ ...prev, ...data.preferences });
    }

    const mood = data.lastMoodSignal ?? existing?.last_mood_signal ?? null;

    this.stmts.updateStructuredPersonData.run(
      concerns,
      goals,
      prefsJson,
      mood,
      curiosity,
      Date.now(),
      id,
    );
  }

  public async getStructuredPersonData(personId: PersonId): Promise<{
    currentConcerns: string[];
    goals: string[];
    preferences: Record<string, string>;
    lastMoodSignal: string | null;
    curiosityQuestions: string[];
  }> {
    const row = this.stmts.selectStructuredPersonData.get(String(personId)) as
      | {
          current_concerns_json: string | null;
          goals_json: string | null;
          preferences_json: string | null;
          last_mood_signal: string | null;
          curiosity_questions_json: string | null;
        }
      | undefined;

    return {
      currentConcerns: row?.current_concerns_json
        ? (parseStringArrayJson(row.current_concerns_json) ?? [])
        : [],
      goals: row?.goals_json ? (parseStringArrayJson(row.goals_json) ?? []) : [],
      preferences: row?.preferences_json ? (parseRecordJson(row.preferences_json) ?? {}) : {},
      lastMoodSignal: row?.last_mood_signal ?? null,
      curiosityQuestions: row?.curiosity_questions_json
        ? (parseStringArrayJson(row.curiosity_questions_json) ?? [])
        : [],
    };
  }

  public async getGroupCapsule(chatId: ChatId): Promise<string | null> {
    const row = this.stmts.selectGroupCapsule.get(String(chatId)) as
      | { capsule: string | null }
      | undefined;
    return row?.capsule ?? null;
  }

  public async upsertGroupCapsule(
    chatId: ChatId,
    capsule: string | null,
    updatedAtMs: number,
  ): Promise<void> {
    this.stmts.upsertGroupCapsule.run(String(chatId), capsule, updatedAtMs);
    await this.syncGroupMdBestEffort(chatId, capsule, updatedAtMs);
  }

  public async markGroupCapsuleDirty(chatId: ChatId, atMs: number): Promise<void> {
    this.stmts.upsertGroupCapsuleDirty.run(String(chatId), atMs, atMs);
  }

  public async claimDirtyGroupCapsules(limit: number): Promise<ChatId[]> {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const nowMs = Date.now();
    const leaseMs = 10 * 60_000;
    const cutoffMs = nowMs - leaseMs;
    const ids = this.stmts.claimDirtyGroupCapsulesAtomic.all(
      nowMs,
      cutoffMs,
      safeLimit,
      cutoffMs,
    ) as Array<{
      chat_id: string;
    }>;
    return ids.map((r) => r.chat_id as unknown as ChatId);
  }

  public async completeDirtyGroupCapsule(chatId: ChatId): Promise<void> {
    const id = String(chatId);
    const tx = this.db.transaction(() => {
      const res = this.stmts.deleteGroupCapsuleDirtyIfClean.run(id) as { changes: number };
      if (Number(res.changes) <= 0) {
        this.stmts.releaseGroupCapsuleDirtyClaim.run(id);
      }
    });
    tx();
  }

  public async markPublicStyleDirty(personId: PersonId, atMs: number): Promise<void> {
    this.stmts.upsertPublicStyleDirty.run(String(personId), atMs, atMs);
  }

  public async claimDirtyPublicStyles(limit: number): Promise<PersonId[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const nowMs = Date.now();
    const leaseMs = 10 * 60_000;
    const cutoffMs = nowMs - leaseMs;
    const ids = this.stmts.claimDirtyPublicStylesAtomic.all(
      nowMs,
      cutoffMs,
      safeLimit,
      cutoffMs,
    ) as Array<{
      person_id: string;
    }>;
    return ids.map((r) => r.person_id as unknown as PersonId);
  }

  public async completeDirtyPublicStyle(personId: PersonId): Promise<void> {
    const id = String(personId);
    const tx = this.db.transaction(() => {
      const res = this.stmts.deletePublicStyleDirtyIfClean.run(id) as { changes: number };
      if (Number(res.changes) <= 0) {
        this.stmts.releasePublicStyleDirtyClaim.run(id);
      }
    });
    tx();
  }

  private async upsertFactVectorBestEffort(id: number, content: string): Promise<void> {
    if (!this.embedder || !this.vecEnabled || !this.vecDim) return;
    const vec = await this.embedder.embed(content);
    const normalized = normalizeEmbedding(vec, this.vecDim);
    if (!normalized) return;
    try {
      this.db
        .query('INSERT OR REPLACE INTO facts_vec (fact_id, embedding) VALUES (?, ?)')
        .run(id, normalized);
    } catch (err) {
      this.logger.debug('facts_vec.insert_failed', errorFields(err));
    }
  }

  private async upsertEpisodeVectorBestEffort(id: number, content: string): Promise<void> {
    if (!this.embedder || !this.vecEnabled || !this.vecDim) return;
    const vec = await this.embedder.embed(content);
    const normalized = normalizeEmbedding(vec, this.vecDim);
    if (!normalized) return;
    try {
      this.db
        .query('INSERT OR REPLACE INTO episodes_vec (episode_id, embedding) VALUES (?, ?)')
        .run(id, normalized);
    } catch (err) {
      this.logger.debug('episodes_vec.insert_failed', errorFields(err));
    }
  }

  public async updateFact(id: FactId, content: string): Promise<void> {
    const tx = this.db.transaction(() => {
      this.stmts.updateFactContent.run(content, id);
      this.stmts.updateFactFtsContent.run(content, id);
    });
    tx();
    await this.upsertFactVectorBestEffort(Number(id), content);
  }

  public async deleteFact(id: FactId): Promise<void> {
    const tx = this.db.transaction(() => {
      this.stmts.deleteFactFts.run(id);
      this.stmts.deleteFact.run(id);
    });
    tx();
    if (this.vecEnabled) {
      try {
        this.db.query('DELETE FROM facts_vec WHERE fact_id = ?').run(id);
      } catch (err) {
        this.logger.debug('facts_vec.delete_failed', errorFields(err));
      }
    }
  }

  public async setFactCurrent(id: FactId, isCurrent: boolean): Promise<void> {
    const v = isCurrent ? 1 : 0;
    this.stmts.setFactIsCurrent.run(v, id);
  }

  public async storeFact(fact: Fact): Promise<void> {
    let factId = 0;
    const tx = this.db.transaction(() => {
      const res = this.stmts.insertFact.run(
        fact.personId ?? null,
        fact.subject,
        fact.content,
        fact.category ?? null,
        fact.factType ?? null,
        fact.temporalScope ?? null,
        fact.evidenceQuote ?? null,
        fact.confidenceTier ?? 'medium',
        fact.isCurrent === false ? 0 : 1,
        fact.lastAccessedAtMs ?? null,
        fact.createdAtMs,
      );

      factId = Number(res.lastInsertRowid);
      this.stmts.insertFactFts.run(fact.subject, fact.content, factId);
    });
    tx();

    await this.upsertFactVectorBestEffort(factId, fact.content);
  }

  public async getFacts(subject: string): Promise<Fact[]> {
    return (this.stmts.selectFactsBySubject.all(subject) as FactRow[]).map(factRowToFact);
  }

  public async getFactsForPerson(personId: PersonId, limit = 200): Promise<Fact[]> {
    return (this.stmts.selectFactsByPerson.all(String(personId), limit) as FactRow[]).map(
      factRowToFact,
    );
  }

  public async searchFacts(query: string, limit = 20): Promise<Fact[]> {
    return searchFactsFts(this.retrievalCtx, query, limit);
  }

  public async hybridSearchFacts(query: string, limit = 20): Promise<Fact[]> {
    return hybridSearchFactsImpl(this.retrievalCtx, query, limit);
  }

  public async touchFacts(ids: readonly FactId[], atMs: number): Promise<void> {
    if (!ids.length) return;
    const uniq = Array.from(new Set(ids.map((id) => String(id))));
    const placeholders = uniq.map(() => '?').join(', ');
    this.db
      .query(`UPDATE facts SET last_accessed_at_ms = ? WHERE id IN (${placeholders})`)
      .run(atMs, ...uniq);
  }

  public async logEpisode(episode: Episode): Promise<EpisodeId> {
    let episodeId = 0;
    const tx = this.db.transaction(() => {
      const isGroup = episode.isGroup === undefined ? null : episode.isGroup === true ? 1 : 0;
      const res = this.stmts.insertEpisode.run(
        String(episode.chatId),
        episode.personId ?? null,
        isGroup,
        episode.content,
        episode.createdAtMs,
      );

      episodeId = Number(res.lastInsertRowid);
      this.stmts.insertEpisodeFts.run(episode.content, episodeId);
    });
    tx();

    if (episode.isGroup) {
      try {
        await this.markGroupCapsuleDirty(episode.chatId, episode.createdAtMs);
        if (episode.personId) {
          await this.markPublicStyleDirty(episode.personId, episode.createdAtMs);
        }
      } catch (err) {
        this.logger.debug('dirty_mark_failed', errorFields(err));
      }
    }

    await this.upsertEpisodeVectorBestEffort(episodeId, episode.content);
    return asEpisodeId(episodeId);
  }

  public async markEpisodeExtracted(id: EpisodeId, atMs: number): Promise<void> {
    this.stmts.markEpisodeExtracted.run(atMs, id);
  }

  public async listEpisodesNeedingExtraction(limit: number): Promise<Episode[]> {
    const safeLimit = Math.max(0, Math.min(500, Math.floor(limit)));
    const rows = this.stmts.selectEpisodesNeedingExtraction.all(safeLimit) as Array<{
      id: number;
      chat_id: string;
      person_id: string | null;
      is_group: number | null;
      content: string;
      created_at_ms: number;
      last_extracted_at_ms: number | null;
    }>;

    return rows.map((r) => ({
      id: asEpisodeId(r.id),
      chatId: r.chat_id as unknown as ChatId,
      personId: r.person_id ? (r.person_id as unknown as PersonId) : undefined,
      isGroup: r.is_group === null ? undefined : Boolean(r.is_group),
      content: r.content,
      lastExtractedAtMs: r.last_extracted_at_ms ?? undefined,
      createdAtMs: r.created_at_ms,
    }));
  }

  public async countEpisodes(chatId: ChatId): Promise<number> {
    const row = this.stmts.countEpisodesByChatId.get(String(chatId)) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  public async searchEpisodes(query: string, limit = 20): Promise<Episode[]> {
    return searchEpisodesFts(this.retrievalCtx, query, limit);
  }

  public async hybridSearchEpisodes(query: string, limit = 20): Promise<Episode[]> {
    return hybridSearchEpisodesImpl(this.retrievalCtx, query, limit);
  }

  public async getRecentEpisodes(chatId: ChatId, hours = 24): Promise<Episode[]> {
    const since = Date.now() - hours * 60 * 60 * 1000;
    const rows = this.stmts.selectRecentEpisodes.all(String(chatId), since) as Array<{
      id: number;
      chat_id: string;
      person_id: string | null;
      is_group: number | null;
      content: string;
      created_at_ms: number;
    }>;

    return rows.map((r) => ({
      id: asEpisodeId(r.id),
      chatId: r.chat_id as unknown as ChatId,
      personId: r.person_id ? (r.person_id as unknown as PersonId) : undefined,
      isGroup: r.is_group === null ? undefined : Boolean(r.is_group),
      content: r.content,
      createdAtMs: r.created_at_ms,
    }));
  }

  public async getRecentGroupEpisodesForPerson(personId: PersonId, hours = 24): Promise<Episode[]> {
    const since = Date.now() - hours * 60 * 60 * 1000;
    const rows = this.stmts.selectRecentGroupEpisodesForPerson.all(
      String(personId),
      since,
    ) as Array<{
      id: number;
      chat_id: string;
      person_id: string | null;
      is_group: number | null;
      content: string;
      created_at_ms: number;
    }>;

    return rows.map((r) => ({
      id: asEpisodeId(r.id),
      chatId: r.chat_id as unknown as ChatId,
      personId: r.person_id ? (r.person_id as unknown as PersonId) : undefined,
      isGroup: r.is_group === null ? undefined : Boolean(r.is_group),
      content: r.content,
      createdAtMs: r.created_at_ms,
    }));
  }

  public async getRecentDmEpisodesForPerson(personId: PersonId, hours = 24): Promise<Episode[]> {
    const since = Date.now() - hours * 60 * 60 * 1000;
    const rows = this.stmts.selectRecentDmEpisodesForPerson.all(String(personId), since) as Array<{
      id: number;
      chat_id: string;
      person_id: string | null;
      is_group: number | null;
      content: string;
      created_at_ms: number;
    }>;

    return rows.map((r) => ({
      id: asEpisodeId(r.id),
      chatId: r.chat_id as unknown as ChatId,
      personId: r.person_id ? (r.person_id as unknown as PersonId) : undefined,
      isGroup: r.is_group === null ? undefined : Boolean(r.is_group),
      content: r.content,
      createdAtMs: r.created_at_ms,
    }));
  }

  public async getObservationCounters(personId: PersonId): Promise<ObservationCounters> {
    const row = this.stmts.selectObservationCounters.get(String(personId)) as
      | {
          avg_response_length: number;
          avg_their_message_length: number;
          active_hours_bitmask: number;
          conversation_count: number;
          sample_count: number;
        }
      | undefined;
    if (!row) return { ...EMPTY_COUNTERS };
    return {
      avgResponseLength: row.avg_response_length,
      avgTheirMessageLength: row.avg_their_message_length,
      activeHoursBitmask: row.active_hours_bitmask,
      conversationCount: row.conversation_count,
      sampleCount: row.sample_count,
    };
  }

  public async updateObservationCounters(
    personId: PersonId,
    counters: ObservationCounters,
  ): Promise<void> {
    const nowMs = Date.now();
    this.stmts.upsertObservationCounters.run(
      String(personId),
      counters.avgResponseLength,
      counters.avgTheirMessageLength,
      counters.activeHoursBitmask,
      counters.conversationCount,
      counters.sampleCount,
      nowMs,
    );
  }

  public async logLesson(lesson: Lesson): Promise<void> {
    let personId: string | null = null;
    if (lesson.personId) {
      const existing = this.stmts.selectPersonById.get(String(lesson.personId)) as
        | PersonRow
        | undefined;
      personId = existing ? String(lesson.personId) : null;
    }

    this.stmts.insertLesson.run(
      lesson.type ?? null,
      lesson.category,
      lesson.content,
      lesson.rule ?? null,
      lesson.alternative ?? null,
      personId,
      lesson.episodeRefs ? JSON.stringify(lesson.episodeRefs) : null,
      lesson.confidence ?? null,
      lesson.timesValidated ?? 0,
      lesson.timesViolated ?? 0,
      lesson.promoted ? 1 : 0,
      lesson.createdAtMs,
    );
  }

  public async setLessonPromoted(id: LessonId, promoted: boolean): Promise<void> {
    this.stmts.setLessonPromoted.run(promoted ? 1 : 0, id);
  }

  public async getLessons(category?: string, limit = 200): Promise<Lesson[]> {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = category
      ? (this.stmts.selectLessonsByCategory.all(category, safeLimit) as LessonRow[])
      : (this.stmts.selectLessonsAll.all(safeLimit) as LessonRow[]);
    return rows.map(lessonRowToLesson);
  }

  public async deletePerson(id: string): Promise<void> {
    const factIds = (this.stmts.selectFactIdsByPerson.all(id) as Array<{ id: number }>).map(
      (r) => r.id,
    );
    const episodeIds = (this.stmts.selectEpisodeIdsByPerson.all(id) as Array<{ id: number }>).map(
      (r) => r.id,
    );

    const tx = this.db.transaction(() => {
      this.stmts.deleteLessonsByPerson.run(id);
      this.stmts.deleteEpisodesByPerson.run(id);
      this.stmts.deleteFactsByPerson.run(id);
      this.stmts.deletePublicStyleDirtyByPerson.run(id);
      this.stmts.deletePerson.run(id);
    });
    tx();

    if (!this.vecEnabled) return;
    try {
      for (const factId of factIds) {
        this.db.query('DELETE FROM facts_vec WHERE fact_id = ?').run(factId);
      }
      for (const episodeId of episodeIds) {
        this.db.query('DELETE FROM episodes_vec WHERE episode_id = ?').run(episodeId);
      }
    } catch (err) {
      this.logger.debug('person_delete_vec_cleanup_failed', errorFields(err));
    }
  }

  public async exportJson(): Promise<unknown> {
    const people = this.stmts.exportPeople.all();
    const facts = this.stmts.exportFacts.all();
    const episodes = this.stmts.exportEpisodes.all();
    const group_capsules = this.stmts.exportGroupCapsules.all();
    const lessons = this.stmts.exportLessons.all();
    return { people, facts, episodes, group_capsules, lessons };
  }

  public async importJson(data: unknown): Promise<void> {
    const parsed = ImportPayloadSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`Invalid import payload: ${parsed.error.message}`);
    }

    const { people, facts, episodes, group_capsules, lessons } = parsed.data;
    const importedFacts: Array<{ id: number; content: string }> = [];
    const importedEpisodes: Array<{ id: number; content: string }> = [];

    const tx = this.db.transaction(() => {
      for (const p of people) {
        this.stmts.importPersonReplace.run(
          p.id,
          p.display_name,
          p.channel,
          p.channel_user_id,
          p.relationship_stage,
          p.relationship_score ?? 0,
          p.trust_tier_override ?? null,
          p.capsule ?? null,
          p.capsule_updated_at_ms ?? null,
          p.public_style_capsule ?? null,
          p.created_at_ms,
          p.updated_at_ms,
        );
      }
      for (const f of facts) {
        const res = this.stmts.importFact.run(
          f.person_id ?? null,
          f.subject,
          f.content,
          f.category ?? null,
          f.fact_type ?? null,
          f.temporal_scope ?? null,
          f.evidence_quote ?? null,
          f.confidence_tier ?? 'medium',
          f.is_current ?? 1,
          f.last_accessed_at_ms ?? null,
          f.created_at_ms,
        );
        const id = Number(res.lastInsertRowid);
        this.stmts.importFactFts.run(f.subject, f.content, id);
        importedFacts.push({ id, content: f.content });
      }
      for (const e of episodes) {
        const res = this.stmts.importEpisode.run(
          e.chat_id,
          e.person_id ?? null,
          e.is_group ?? null,
          e.content,
          e.last_extracted_at_ms ?? null,
          e.created_at_ms,
        );
        const id = Number(res.lastInsertRowid);
        this.stmts.importEpisodeFts.run(e.content, id);
        importedEpisodes.push({ id, content: e.content });
      }
      for (const g of group_capsules) {
        this.stmts.upsertGroupCapsule.run(g.chat_id, g.capsule ?? null, g.updated_at_ms);
      }
      for (const l of lessons) {
        const refs = l.episode_refs;
        const refsJson =
          refs == null
            ? null
            : typeof refs === 'string'
              ? normalizeStringArrayToJson(refs)
              : JSON.stringify(refs);
        this.stmts.importLesson.run(
          l.type ?? null,
          l.category,
          l.content,
          l.rule ?? null,
          l.alternative ?? null,
          l.person_id ?? null,
          refsJson,
          l.confidence ?? null,
          l.times_validated ?? 0,
          l.times_violated ?? 0,
          l.promoted ?? 0,
          l.created_at_ms,
        );
      }
    });

    tx();
    for (const fact of importedFacts) {
      await this.upsertFactVectorBestEffort(fact.id, fact.content);
    }
    for (const episode of importedEpisodes) {
      await this.upsertEpisodeVectorBestEffort(episode.id, episode.content);
    }
  }
}
