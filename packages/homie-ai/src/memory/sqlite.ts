import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { z } from 'zod';
import type { ChatId, FactId, PersonId } from '../types/ids.js';
import { asEpisodeId, asFactId, asLessonId, asPersonId } from '../types/ids.js';
import { fileExists } from '../util/fs.js';
import { errorFields, log } from '../util/logger.js';
import { closeSqliteBestEffort } from '../util/sqlite-close.js';
import { runSqliteMigrations } from '../util/sqlite-migrations.js';
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
import type { MemoryStore } from './store.js';
import {
  type ChatTrustTier,
  ChatTrustTierSchema,
  clamp01,
  type Episode,
  type Fact,
  type FactCategory,
  type Lesson,
  type LessonType,
  type PersonRecord,
} from './types.js';

interface FactRow {
  id: number;
  person_id: string | null;
  subject: string;
  content: string;
  category: string | null;
  evidence_quote: string | null;
  last_accessed_at_ms: number | null;
  created_at_ms: number;
}

const VALID_FACT_CATEGORIES = new Set([
  'preference',
  'personal',
  'plan',
  'professional',
  'relationship',
  'misc',
]);

const factRowToFact = (r: FactRow): Fact => ({
  id: asFactId(r.id),
  ...(r.person_id ? { personId: asPersonId(r.person_id) } : {}),
  subject: r.subject,
  content: r.content,
  ...(r.category && VALID_FACT_CATEGORIES.has(r.category)
    ? { category: r.category as FactCategory }
    : {}),
  ...(r.evidence_quote ? { evidenceQuote: r.evidence_quote } : {}),
  ...(r.last_accessed_at_ms != null ? { lastAccessedAtMs: r.last_accessed_at_ms } : {}),
  createdAtMs: r.created_at_ms,
});

interface LessonRow {
  id: number;
  type: string | null;
  category: string;
  content: string;
  rule: string | null;
  alternative: string | null;
  person_id: string | null;
  episode_refs: string | null;
  confidence: number | null;
  times_validated: number | null;
  times_violated: number | null;
  created_at_ms: number;
}

const VALID_LESSON_TYPES = new Set(['observation', 'failure', 'success', 'pattern']);

const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (err) {
    void err;
    return undefined;
  }
};

const parseStringArrayJson = (raw: string): string[] | undefined => {
  const parsed = safeJsonParse(raw);
  if (!Array.isArray(parsed)) return undefined;
  const out = parsed.filter((v) => typeof v === 'string') as string[];
  return out.length ? out : undefined;
};

const parseRecordJson = (raw: string): Record<string, string> | undefined => {
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = v;
      count++;
    }
  }
  return count > 0 ? out : undefined;
};

const normalizeStringArrayToJson = (raw: string): string => {
  const parsed = parseStringArrayJson(raw);
  if (parsed) return JSON.stringify(parsed);
  // If the string isn't a JSON array, treat it as a single ref.
  return JSON.stringify([raw]);
};

const lessonRowToLesson = (r: LessonRow): Lesson => ({
  id: asLessonId(r.id),
  ...(r.type && VALID_LESSON_TYPES.has(r.type) ? { type: r.type as LessonType } : {}),
  category: r.category,
  content: r.content,
  ...(r.rule ? { rule: r.rule } : {}),
  ...(r.alternative ? { alternative: r.alternative } : {}),
  ...(r.person_id ? { personId: asPersonId(r.person_id) } : {}),
  ...(r.episode_refs
    ? (() => {
        const refs = parseStringArrayJson(r.episode_refs);
        return refs ? { episodeRefs: refs } : {};
      })()
    : {}),
  ...(r.confidence != null ? { confidence: r.confidence } : {}),
  ...(r.times_validated != null ? { timesValidated: r.times_validated } : {}),
  ...(r.times_violated != null ? { timesViolated: r.times_violated } : {}),
  createdAtMs: r.created_at_ms,
});

const schemaSql = `
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  channel TEXT NOT NULL,
  channel_user_id TEXT NOT NULL,
  relationship_stage TEXT NOT NULL,
  relationship_score REAL NOT NULL DEFAULT 0,
  trust_tier_override TEXT,
  capsule TEXT,
  public_style_capsule TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_people_channel_user_id
  ON people(channel, channel_user_id);

CREATE TABLE IF NOT EXISTS group_capsules (
  chat_id TEXT PRIMARY KEY,
  capsule TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_capsule_dirty (
  chat_id TEXT PRIMARY KEY,
  dirty_at_ms INTEGER NOT NULL,
  dirty_last_at_ms INTEGER NOT NULL,
  claimed_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS public_style_dirty (
  person_id TEXT PRIMARY KEY,
  dirty_at_ms INTEGER NOT NULL,
  dirty_last_at_ms INTEGER NOT NULL,
  claimed_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT,
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT,
  evidence_quote TEXT,
  last_accessed_at_ms INTEGER,
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
  person_id TEXT,
  is_group INTEGER,
  content TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  content,
  episode_id UNINDEXED
);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  rule TEXT,
  person_id TEXT,
  episode_refs TEXT,
  confidence REAL,
  times_validated INTEGER DEFAULT 0,
  times_violated INTEGER DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);
`;

const ensureColumnsMigration = {
  name: 'ensure_columns',
  up: (db: Database): void => {
    const hasColumn = (table: string, col: string): boolean => {
      const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return rows.some((r) => r.name === col);
    };
    const addColumn = (table: string, colDef: string, colName: string): void => {
      if (hasColumn(table, colName)) return;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef};`);
    };

    // Keep DBs created by older schema versions usable.
    addColumn('people', 'capsule TEXT', 'capsule');
    addColumn('people', 'public_style_capsule TEXT', 'public_style_capsule');
    addColumn('people', 'relationship_score REAL NOT NULL DEFAULT 0', 'relationship_score');
    addColumn('people', 'trust_tier_override TEXT', 'trust_tier_override');
    addColumn('facts', 'category TEXT', 'category');
    addColumn('facts', 'evidence_quote TEXT', 'evidence_quote');
    addColumn('facts', 'last_accessed_at_ms INTEGER', 'last_accessed_at_ms');
    addColumn('lessons', 'type TEXT', 'type');
    addColumn('lessons', 'rule TEXT', 'rule');
    addColumn('lessons', 'person_id TEXT', 'person_id');
    addColumn('lessons', 'episode_refs TEXT', 'episode_refs');
    addColumn('lessons', 'confidence REAL', 'confidence');
    addColumn('lessons', 'times_validated INTEGER DEFAULT 0', 'times_validated');
    addColumn('lessons', 'times_violated INTEGER DEFAULT 0', 'times_violated');
  },
} as const;

const indexSql = `
CREATE INDEX IF NOT EXISTS idx_facts_person_created
  ON facts(person_id, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_facts_subject_created
  ON facts(subject, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_facts_last_accessed
  ON facts(last_accessed_at_ms);

CREATE INDEX IF NOT EXISTS idx_episodes_chat_created
  ON episodes(chat_id, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_lessons_category_created
  ON lessons(category, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_lessons_person_created
  ON lessons(person_id, created_at_ms DESC);
`;

const ensureColumnsV2Migration = {
  name: 'ensure_columns_v2',
  up: (db: Database): void => {
    const hasColumn = (table: string, col: string): boolean => {
      const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return rows.some((r) => r.name === col);
    };
    const addColumn = (table: string, colDef: string, colName: string): void => {
      if (hasColumn(table, colName)) return;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef};`);
    };

    addColumn('people', 'public_style_capsule TEXT', 'public_style_capsule');

    db.exec(`
      CREATE TABLE IF NOT EXISTS group_capsules (
        chat_id TEXT PRIMARY KEY,
        capsule TEXT,
        updated_at_ms INTEGER NOT NULL
      );
    `);
  },
} as const;

const ensureColumnsV3Migration = {
  name: 'ensure_columns_v3',
  up: (db: Database): void => {
    const hasColumn = (table: string, col: string): boolean => {
      const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return rows.some((r) => r.name === col);
    };
    const addColumn = (table: string, colDef: string, colName: string): void => {
      if (hasColumn(table, colName)) return;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef};`);
    };

    addColumn('episodes', 'person_id TEXT', 'person_id');
    addColumn('episodes', 'is_group INTEGER', 'is_group');

    db.exec(`
      CREATE TABLE IF NOT EXISTS group_capsule_dirty (
        chat_id TEXT PRIMARY KEY,
        dirty_at_ms INTEGER NOT NULL,
        dirty_last_at_ms INTEGER NOT NULL,
        claimed_at_ms INTEGER
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS public_style_dirty (
        person_id TEXT PRIMARY KEY,
        dirty_at_ms INTEGER NOT NULL,
        dirty_last_at_ms INTEGER NOT NULL,
        claimed_at_ms INTEGER
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_episodes_person_group_created
        ON episodes(person_id, is_group, created_at_ms DESC);
    `);
  },
} as const;

const ensureColumnsV4Migration = {
  name: 'ensure_columns_v4_dirty_claims',
  up: (db: Database): void => {
    const hasColumn = (table: string, col: string): boolean => {
      const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return rows.some((r) => r.name === col);
    };
    const addColumn = (table: string, colDef: string, colName: string): void => {
      if (hasColumn(table, colName)) return;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef};`);
    };

    // Ensure tables exist (older DBs might have missed earlier migrations).
    db.exec(`
      CREATE TABLE IF NOT EXISTS group_capsule_dirty (
        chat_id TEXT PRIMARY KEY,
        dirty_at_ms INTEGER NOT NULL,
        dirty_last_at_ms INTEGER NOT NULL,
        claimed_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS public_style_dirty (
        person_id TEXT PRIMARY KEY,
        dirty_at_ms INTEGER NOT NULL,
        dirty_last_at_ms INTEGER NOT NULL,
        claimed_at_ms INTEGER
      );
    `);

    addColumn('group_capsule_dirty', 'dirty_last_at_ms INTEGER', 'dirty_last_at_ms');
    addColumn('group_capsule_dirty', 'claimed_at_ms INTEGER', 'claimed_at_ms');
    addColumn('public_style_dirty', 'dirty_last_at_ms INTEGER', 'dirty_last_at_ms');
    addColumn('public_style_dirty', 'claimed_at_ms INTEGER', 'claimed_at_ms');

    // Backfill newly-added columns for existing rows.
    db.exec(`
      UPDATE group_capsule_dirty
      SET dirty_last_at_ms = dirty_at_ms
      WHERE dirty_last_at_ms IS NULL;
      UPDATE public_style_dirty
      SET dirty_last_at_ms = dirty_at_ms
      WHERE dirty_last_at_ms IS NULL;
    `);
  },
} as const;

const ensureColumnsV5Migration = {
  name: 'ensure_columns_v5_structured_person',
  up: (db: Database): void => {
    const hasColumn = (table: string, col: string): boolean => {
      const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return rows.some((r) => r.name === col);
    };
    const addColumn = (table: string, colDef: string, colName: string): void => {
      if (hasColumn(table, colName)) return;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef};`);
    };

    addColumn('people', 'current_concerns_json TEXT', 'current_concerns_json');
    addColumn('people', 'goals_json TEXT', 'goals_json');
    addColumn('people', 'preferences_json TEXT', 'preferences_json');
    addColumn('people', 'last_mood_signal TEXT', 'last_mood_signal');
    addColumn('people', 'curiosity_questions_json TEXT', 'curiosity_questions_json');
  },
} as const;

const ensureColumnsV6Migration = {
  name: 'ensure_columns_v6_lesson_alternative',
  up: (db: Database): void => {
    const hasColumn = (table: string, col: string): boolean => {
      const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return rows.some((r) => r.name === col);
    };
    const addColumn = (table: string, colDef: string, colName: string): void => {
      if (hasColumn(table, colName)) return;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef};`);
    };

    addColumn('lessons', 'alternative TEXT', 'alternative');
  },
} as const;

const MEMORY_MIGRATIONS = [
  schemaSql,
  ensureColumnsMigration,
  indexSql,
  ensureColumnsV2Migration,
  ensureColumnsV3Migration,
  ensureColumnsV4Migration,
  ensureColumnsV5Migration,
  ensureColumnsV6Migration,
] as const;

const normalizeTrustTierOverride = (s: string | null): ChatTrustTier | undefined => {
  if (!s) return undefined;
  const parsed = ChatTrustTierSchema.safeParse(s);
  return parsed.success ? parsed.data : undefined;
};

interface PersonRow {
  id: string;
  display_name: string;
  channel: string;
  channel_user_id: string;
  relationship_stage: string;
  relationship_score: number;
  trust_tier_override: string | null;
  capsule: string | null;
  public_style_capsule: string | null;
  current_concerns_json: string | null;
  goals_json: string | null;
  preferences_json: string | null;
  last_mood_signal: string | null;
  curiosity_questions_json: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

const rowToPerson = (row: PersonRow): PersonRecord => {
  const tier = normalizeTrustTierOverride(row.trust_tier_override);
  const concerns = row.current_concerns_json
    ? parseStringArrayJson(row.current_concerns_json)
    : undefined;
  const goals = row.goals_json ? parseStringArrayJson(row.goals_json) : undefined;
  const prefs = row.preferences_json ? parseRecordJson(row.preferences_json) : undefined;
  const curiosity = row.curiosity_questions_json
    ? parseStringArrayJson(row.curiosity_questions_json)
    : undefined;
  return {
    id: asPersonId(row.id),
    displayName: row.display_name,
    channel: row.channel,
    channelUserId: row.channel_user_id,
    relationshipScore:
      typeof row.relationship_score === 'number' && Number.isFinite(row.relationship_score)
        ? clamp01(row.relationship_score)
        : 0,
    ...(tier ? { trustTierOverride: tier } : {}),
    ...(row.capsule ? { capsule: row.capsule } : {}),
    ...(row.public_style_capsule ? { publicStyleCapsule: row.public_style_capsule } : {}),
    ...(concerns ? { currentConcerns: concerns } : {}),
    ...(goals ? { goals } : {}),
    ...(prefs ? { preferences: prefs } : {}),
    ...(row.last_mood_signal ? { lastMoodSignal: row.last_mood_signal } : {}),
    ...(curiosity ? { curiosityQuestions: curiosity } : {}),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
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
          relationship_score: z.number().optional(),
          trust_tier_override: z.string().nullable().optional(),
          capsule: z.string().nullable().optional(),
          public_style_capsule: z.string().nullable().optional(),
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
          category: z.string().nullable().optional(),
          evidence_quote: z.string().nullable().optional(),
          last_accessed_at_ms: z.number().nullable().optional(),
          created_at_ms: z.number(),
        }),
      )
      .default([]),
    episodes: z
      .array(
        z.object({
          chat_id: z.string(),
          person_id: z.string().nullable().optional(),
          is_group: z.number().nullable().optional(),
          content: z.string(),
          created_at_ms: z.number(),
        }),
      )
      .default([]),
    group_capsules: z
      .array(
        z.object({
          chat_id: z.string().min(1),
          capsule: z.string().nullable().optional(),
          updated_at_ms: z.number(),
        }),
      )
      .default([]),
    lessons: z
      .array(
        z.object({
          type: z.string().nullable().optional(),
          category: z.string(),
          content: z.string(),
          rule: z.string().nullable().optional(),
          alternative: z.string().nullable().optional(),
          person_id: z.string().nullable().optional(),
          episode_refs: z
            .union([z.string(), z.array(z.string())])
            .nullable()
            .optional(),
          confidence: z.number().nullable().optional(),
          times_validated: z.number().nullable().optional(),
          times_violated: z.number().nullable().optional(),
          created_at_ms: z.number(),
        }),
      )
      .default([]),
  })
  .strict();

export interface SqliteMemoryStoreOptions {
  dbPath: string;
  embedder?: Embedder | undefined;
  retrieval?: {
    /** Reciprocal-rank-fusion constant: score = 1 / (k + rank). */
    rrfK?: number | undefined;
    /** Weight applied to the FTS rank contribution. */
    ftsWeight?: number | undefined;
    /** Weight applied to the vector rank contribution. */
    vecWeight?: number | undefined;
    /** Multiplier for the recency boost applied to the base rank score. */
    recencyWeight?: number | undefined;
    /** Half-life used for recency boost (days). */
    halfLifeDays?: number | undefined;
  };
}

type RetrievalTuning = {
  rrfK: number;
  ftsWeight: number;
  vecWeight: number;
  recencyWeight: number;
  halfLifeDays: number;
};

export class SqliteMemoryStore implements MemoryStore {
  private readonly logger = log.child({ component: 'sqlite_memory' });
  private readonly db: Database;
  private readonly embedder: Embedder | undefined;
  private readonly vecEnabled: boolean;
  private readonly vecDim: number | undefined;
  private readonly stmts: ReturnType<typeof createStatements>;
  private readonly retrieval: RetrievalTuning;
  private readonly mdMirrorDir: string;

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
    runSqliteMigrations(this.db, MEMORY_MIGRATIONS);
    this.stmts = createStatements(this.db);

    this.retrieval = {
      rrfK: Math.max(1, Math.floor(options.retrieval?.rrfK ?? 60)),
      ftsWeight: Math.max(0, options.retrieval?.ftsWeight ?? 0.6),
      vecWeight: Math.max(0, options.retrieval?.vecWeight ?? 0.4),
      recencyWeight: Math.max(0, options.retrieval?.recencyWeight ?? 0.2),
      halfLifeDays: Math.max(1, options.retrieval?.halfLifeDays ?? 30),
    };

    // Markdown mirror lives alongside the SQLite DB files inside dataDir.
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
        // sqlite-vec unavailable in this environment — vector features disabled.
        this.logger.debug('sqlite_vec.unavailable', errorFields(err));
        this.vecEnabled = false;
      }
    }
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
    this.stmts.updatePersonCapsule.run(capsule, Date.now(), String(personId));
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
      const prev = raw ? parseStringArrayJson(raw) ?? [] : [];
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
      const prev = prefsJson ? parseRecordJson(prefsJson) ?? {} : {};
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
    // Coalesce bursts: keep earliest dirty_at_ms and latest dirty_last_at_ms.
    this.stmts.upsertGroupCapsuleDirty.run(String(chatId), atMs, atMs);
  }

  public async claimDirtyGroupCapsules(limit: number): Promise<ChatId[]> {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const nowMs = Date.now();
    const leaseMs = 10 * 60_000;
    const cutoffMs = nowMs - leaseMs;
    const ids = this.stmts.selectDirtyGroupCapsules.all(cutoffMs, safeLimit) as Array<{
      chat_id: string;
    }>;
    if (ids.length === 0) return [];

    const tx = this.db.transaction(() => {
      for (const r of ids) this.stmts.claimGroupCapsuleDirty.run(nowMs, r.chat_id);
    });
    tx();

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
    const ids = this.stmts.selectDirtyPublicStyles.all(cutoffMs, safeLimit) as Array<{
      person_id: string;
    }>;
    if (ids.length === 0) return [];

    const tx = this.db.transaction(() => {
      for (const r of ids) this.stmts.claimPublicStyleDirty.run(nowMs, r.person_id);
    });
    tx();

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

  public async updateFact(id: FactId, content: string): Promise<void> {
    const tx = this.db.transaction(() => {
      this.stmts.updateFactContent.run(content, id);
      this.stmts.updateFactFtsContent.run(content, id);
    });
    tx();
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
        // vec table may not exist
        this.logger.debug('facts_vec.delete_failed', errorFields(err));
      }
    }
  }

  public async storeFact(fact: Fact): Promise<void> {
    let factId = 0;
    const tx = this.db.transaction(() => {
      const res = this.stmts.insertFact.run(
        fact.personId ?? null,
        fact.subject,
        fact.content,
        fact.category ?? null,
        fact.evidenceQuote ?? null,
        fact.lastAccessedAtMs ?? null,
        fact.createdAtMs,
      );

      factId = Number(res.lastInsertRowid);
      this.stmts.insertFactFts.run(fact.subject, fact.content, factId);
    });
    tx();

    if (this.embedder && this.vecEnabled && this.vecDim) {
      const vec = await this.embedder.embed(fact.content);
      const normalized = normalizeEmbedding(vec, this.vecDim);
      if (normalized) {
        try {
          this.db
            .query('INSERT OR REPLACE INTO facts_vec (fact_id, embedding) VALUES (?, ?)')
            .run(factId, normalized);
        } catch (err) {
          // vec write failure should not break a turn
          this.logger.debug('facts_vec.insert_failed', errorFields(err));
        }
      }
    }
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
    const safe = safeFtsQueryFromText(query);
    if (!safe) return [];
    const fetchLimit = Math.min(200, Math.max(limit, limit * 5));
    const rows = this.stmts.searchFactsFts.all(safe, fetchLimit) as FactRow[];
    const nowMs = Date.now();
    const halfLifeMs = this.retrieval.halfLifeDays * 24 * 60 * 60_000;
    const ln2 = Math.log(2);
    const weighted = rows
      .map((r, idx) => {
        const base = this.retrieval.ftsWeight * (1 / (this.retrieval.rrfK + (idx + 1)));
        const t = r.last_accessed_at_ms ?? r.created_at_ms;
        const ageMs = Math.max(0, nowMs - t);
        const recency = Math.exp((-ln2 * ageMs) / halfLifeMs);
        const score = base * (1 + this.retrieval.recencyWeight * recency);
        return { r, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.r);
    return weighted.map(factRowToFact);
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
      const fetchLimit = Math.min(200, Math.max(limit, limit * 5));
      const rows = this.db
        .query(
          `SELECT f.id, f.person_id, f.subject, f.content, f.category,
                  f.evidence_quote, f.last_accessed_at_ms, f.created_at_ms
           FROM facts_vec v
           JOIN facts f ON f.id = v.fact_id
           WHERE v.embedding MATCH ? AND k = ?
           ORDER BY distance
           LIMIT ?`,
        )
        .all(normalized, fetchLimit, fetchLimit) as FactRow[];

      const nowMs = Date.now();
      const halfLifeMs = this.retrieval.halfLifeDays * 24 * 60 * 60_000;
      const ln2 = Math.log(2);
      const weighted = rows
        .map((r, idx) => {
          const base = this.retrieval.vecWeight * (1 / (this.retrieval.rrfK + (idx + 1)));
          const t = r.last_accessed_at_ms ?? r.created_at_ms;
          const ageMs = Math.max(0, nowMs - t);
          const recency = Math.exp((-ln2 * ageMs) / halfLifeMs);
          const score = base * (1 + this.retrieval.recencyWeight * recency);
          return { r, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => x.r);
      return weighted.map(factRowToFact);
    }

    const fetchLimit = Math.min(200, Math.max(limit, limit * 5));
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
            (coalesce(? * 1.0 / (? + f.rank_num), 0.0) + coalesce(? * 1.0 / (? + v.rank_num), 0.0)) AS rrf_score
          FROM all_ids a
          LEFT JOIN fts_matches f ON f.id = a.id
          LEFT JOIN vec_matches v ON v.id = a.id
        )
        SELECT f.id, f.person_id, f.subject, f.content, f.category,
               f.evidence_quote, f.last_accessed_at_ms, f.created_at_ms,
               s.rrf_score
        FROM scored s
        JOIN facts f ON f.id = s.id
        ORDER BY s.rrf_score DESC
        LIMIT ?`,
      )
      .all(
        normalized,
        fetchLimit,
        safe,
        fetchLimit,
        this.retrieval.ftsWeight,
        this.retrieval.rrfK,
        this.retrieval.vecWeight,
        this.retrieval.rrfK,
        fetchLimit,
      ) as Array<FactRow & { rrf_score: number }>;

    const nowMs = Date.now();
    const halfLifeMs = this.retrieval.halfLifeDays * 24 * 60 * 60_000;
    const ln2 = Math.log(2);
    const weighted = rows
      .map((r, idx) => {
        const base = Number.isFinite(r.rrf_score)
          ? r.rrf_score
          : 1 / (this.retrieval.rrfK + (idx + 1));
        const t = r.last_accessed_at_ms ?? r.created_at_ms;
        const ageMs = Math.max(0, nowMs - t);
        const recency = Math.exp((-ln2 * ageMs) / halfLifeMs);
        const score = base * (1 + this.retrieval.recencyWeight * recency);
        return { r, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.r);

    return weighted.map(factRowToFact);
  }

  public async touchFacts(ids: readonly FactId[], atMs: number): Promise<void> {
    if (!ids.length) return;
    const uniq = Array.from(new Set(ids.map((id) => String(id))));
    const placeholders = uniq.map(() => '?').join(', ');
    this.db
      .query(`UPDATE facts SET last_accessed_at_ms = ? WHERE id IN (${placeholders})`)
      .run(atMs, ...uniq);
  }

  public async logEpisode(episode: Episode): Promise<void> {
    let episodeId = 0;
    const tx = this.db.transaction(() => {
      const isGroup = episode.isGroup === undefined ? null : episode.isGroup === true ? 1 : 0;
      const res = this.stmts.insertEpisode.run(
        episode.chatId as unknown as string,
        episode.personId ?? null,
        isGroup,
        episode.content,
        episode.createdAtMs,
      );

      episodeId = Number(res.lastInsertRowid);
      this.stmts.insertEpisodeFts.run(episode.content, episodeId);
    });
    tx();

    // Mark downstream consolidation work based strictly on group episodes.
    if (episode.isGroup) {
      try {
        await this.markGroupCapsuleDirty(episode.chatId, episode.createdAtMs);
        if (episode.personId) {
          await this.markPublicStyleDirty(episode.personId, episode.createdAtMs);
        }
      } catch (err) {
        // Best-effort; never block a turn due to consolidation bookkeeping.
        this.logger.debug('dirty_mark_failed', errorFields(err));
      }
    }

    if (this.embedder && this.vecEnabled && this.vecDim) {
      const vec = await this.embedder.embed(episode.content);
      const normalized = normalizeEmbedding(vec, this.vecDim);
      if (normalized) {
        try {
          this.db
            .query('INSERT OR REPLACE INTO episodes_vec (episode_id, embedding) VALUES (?, ?)')
            .run(episodeId, normalized);
        } catch (err) {
          // vec write failure should not break a turn
          this.logger.debug('episodes_vec.insert_failed', errorFields(err));
        }
      }
    }
  }

  public async countEpisodes(chatId: ChatId): Promise<number> {
    const row = this.stmts.countEpisodesByChatId.get(chatId as unknown as string) as
      | { c: number }
      | undefined;
    return row?.c ?? 0;
  }

  public async searchEpisodes(query: string, limit = 20): Promise<Episode[]> {
    const safe = safeFtsQueryFromText(query);
    if (!safe) return [];

    const fetchLimit = Math.min(200, Math.max(limit, limit * 5));
    const rows = this.stmts.searchEpisodesFts.all(safe, fetchLimit) as Array<{
      id: number;
      chat_id: string;
      content: string;
      created_at_ms: number;
    }>;

    const nowMs = Date.now();
    const halfLifeMs = this.retrieval.halfLifeDays * 24 * 60 * 60_000;
    const ln2 = Math.log(2);
    const weighted = rows
      .map((r, idx) => {
        const base = this.retrieval.ftsWeight * (1 / (this.retrieval.rrfK + (idx + 1)));
        const ageMs = Math.max(0, nowMs - r.created_at_ms);
        const recency = Math.exp((-ln2 * ageMs) / halfLifeMs);
        const score = base * (1 + this.retrieval.recencyWeight * recency);
        return { r, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.r);

    return weighted.map((r) => ({
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
      const fetchLimit = Math.min(200, Math.max(limit, limit * 5));
      const rows = this.db
        .query(
          `SELECT e.id, e.chat_id, e.content, e.created_at_ms
           FROM episodes_vec v
           JOIN episodes e ON e.id = v.episode_id
           WHERE v.embedding MATCH ? AND k = ?
           ORDER BY distance
           LIMIT ?`,
        )
        .all(normalized, fetchLimit, fetchLimit) as Array<{
        id: number;
        chat_id: string;
        content: string;
        created_at_ms: number;
      }>;

      const nowMs = Date.now();
      const halfLifeMs = this.retrieval.halfLifeDays * 24 * 60 * 60_000;
      const ln2 = Math.log(2);
      const weighted = rows
        .map((r, idx) => {
          const base = this.retrieval.vecWeight * (1 / (this.retrieval.rrfK + (idx + 1)));
          const ageMs = Math.max(0, nowMs - r.created_at_ms);
          const recency = Math.exp((-ln2 * ageMs) / halfLifeMs);
          const score = base * (1 + this.retrieval.recencyWeight * recency);
          return { r, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => x.r);

      return weighted.map((r) => ({
        id: asEpisodeId(r.id),
        chatId: r.chat_id as unknown as ChatId,
        content: r.content,
        createdAtMs: r.created_at_ms,
      }));
    }

    const fetchLimit = Math.min(200, Math.max(limit, limit * 5));
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
            (coalesce(? * 1.0 / (? + f.rank_num), 0.0) + coalesce(? * 1.0 / (? + v.rank_num), 0.0)) AS rrf_score
          FROM all_ids a
          LEFT JOIN fts_matches f ON f.id = a.id
          LEFT JOIN vec_matches v ON v.id = a.id
        )
        SELECT e.id, e.chat_id, e.content, e.created_at_ms,
               s.rrf_score
        FROM scored s
        JOIN episodes e ON e.id = s.id
        ORDER BY s.rrf_score DESC
        LIMIT ?`,
      )
      .all(
        normalized,
        fetchLimit,
        safe,
        fetchLimit,
        this.retrieval.ftsWeight,
        this.retrieval.rrfK,
        this.retrieval.vecWeight,
        this.retrieval.rrfK,
        fetchLimit,
      ) as Array<{
      id: number;
      chat_id: string;
      content: string;
      created_at_ms: number;
      rrf_score: number;
    }>;

    const nowMs = Date.now();
    const halfLifeMs = this.retrieval.halfLifeDays * 24 * 60 * 60_000;
    const ln2 = Math.log(2);
    const weighted = rows
      .map((r, idx) => {
        const base = Number.isFinite(r.rrf_score)
          ? r.rrf_score
          : 1 / (this.retrieval.rrfK + (idx + 1));
        const ageMs = Math.max(0, nowMs - r.created_at_ms);
        const recency = Math.exp((-ln2 * ageMs) / halfLifeMs);
        const score = base * (1 + this.retrieval.recencyWeight * recency);
        return { r, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.r);

    return weighted.map((r) => ({
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

  public async logLesson(lesson: Lesson): Promise<void> {
    this.stmts.insertLesson.run(
      lesson.type ?? null,
      lesson.category,
      lesson.content,
      lesson.rule ?? null,
      lesson.alternative ?? null,
      lesson.personId ?? null,
      lesson.episodeRefs ? JSON.stringify(lesson.episodeRefs) : null,
      lesson.confidence ?? null,
      lesson.timesValidated ?? 0,
      lesson.timesViolated ?? 0,
      lesson.createdAtMs,
    );
  }

  public async getLessons(category?: string, limit = 200): Promise<Lesson[]> {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = category
      ? (this.stmts.selectLessonsByCategory.all(category, safeLimit) as LessonRow[])
      : (this.stmts.selectLessonsAll.all(safeLimit) as LessonRow[]);
    return rows.map(lessonRowToLesson);
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
          f.evidence_quote ?? null,
          f.last_accessed_at_ms ?? null,
          f.created_at_ms,
        );
        const id = Number(res.lastInsertRowid);
        this.stmts.importFactFts.run(f.subject, f.content, id);
      }
      for (const e of episodes) {
        const res = this.stmts.importEpisode.run(
          e.chat_id,
          e.person_id ?? null,
          e.is_group ?? null,
          e.content,
          e.created_at_ms,
        );
        const id = Number(res.lastInsertRowid);
        this.stmts.importEpisodeFts.run(e.content, id);
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
          l.created_at_ms,
        );
      }
    });

    tx();
  }
}

function createStatements(db: Database) {
  return {
    upsertPerson: db.query(
      `INSERT INTO people (
         id,
         display_name,
         channel,
         channel_user_id,
         relationship_stage,
         relationship_score,
         trust_tier_override,
         capsule,
         public_style_capsule,
         created_at_ms,
         updated_at_ms
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel, channel_user_id) DO UPDATE SET
         display_name=excluded.display_name,
         relationship_score=max(relationship_score, excluded.relationship_score),
         trust_tier_override=coalesce(excluded.trust_tier_override, trust_tier_override),
         capsule=coalesce(excluded.capsule, capsule),
         public_style_capsule=coalesce(excluded.public_style_capsule, public_style_capsule),
         updated_at_ms=excluded.updated_at_ms`,
    ),
    selectPersonById: db.query(
      `SELECT id, display_name, channel, channel_user_id, relationship_stage, relationship_score, trust_tier_override, capsule, public_style_capsule, current_concerns_json, goals_json, preferences_json, last_mood_signal, curiosity_questions_json, created_at_ms, updated_at_ms
       FROM people WHERE id = ?`,
    ),
    selectPersonByChannelUserId: db.query(
      `SELECT id, display_name, channel, channel_user_id, relationship_stage, relationship_score, trust_tier_override, capsule, public_style_capsule, current_concerns_json, goals_json, preferences_json, last_mood_signal, curiosity_questions_json, created_at_ms, updated_at_ms
       FROM people WHERE channel_user_id = ? LIMIT 1`,
    ),
    searchPeopleLike: db.query(
      `SELECT id, display_name, channel, channel_user_id, relationship_stage, relationship_score, trust_tier_override, capsule, public_style_capsule, current_concerns_json, goals_json, preferences_json, last_mood_signal, curiosity_questions_json, created_at_ms, updated_at_ms
       FROM people
       WHERE display_name LIKE ? OR channel_user_id LIKE ?
       ORDER BY updated_at_ms DESC
       LIMIT 25`,
    ),
    listPeoplePaged: db.query(
      `SELECT id, display_name, channel, channel_user_id, relationship_stage, relationship_score, trust_tier_override, capsule, public_style_capsule, current_concerns_json, goals_json, preferences_json, last_mood_signal, curiosity_questions_json, created_at_ms, updated_at_ms
       FROM people
       ORDER BY updated_at_ms DESC
       LIMIT ? OFFSET ?`,
    ),
    updateRelationshipScore: db.query(
      `UPDATE people SET relationship_score = ?, updated_at_ms = ? WHERE id = ?`,
    ),
    updateTrustTierOverride: db.query(
      `UPDATE people SET trust_tier_override = ?, updated_at_ms = ? WHERE id = ?`,
    ),
    updatePersonCapsule: db.query(`UPDATE people SET capsule = ?, updated_at_ms = ? WHERE id = ?`),
    updatePublicStyleCapsule: db.query(
      `UPDATE people SET public_style_capsule = ?, updated_at_ms = ? WHERE id = ?`,
    ),

    selectStructuredPersonData: db.query(
      `SELECT current_concerns_json, goals_json, preferences_json, last_mood_signal, curiosity_questions_json
       FROM people WHERE id = ?`,
    ),
    updateStructuredPersonData: db.query(
      `UPDATE people SET
         current_concerns_json = ?,
         goals_json = ?,
         preferences_json = ?,
         last_mood_signal = ?,
         curiosity_questions_json = ?,
         updated_at_ms = ?
       WHERE id = ?`,
    ),

    selectGroupCapsule: db.query(`SELECT capsule FROM group_capsules WHERE chat_id = ? LIMIT 1`),
    upsertGroupCapsule: db.query(
      `INSERT INTO group_capsules (chat_id, capsule, updated_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         capsule=excluded.capsule,
         updated_at_ms=excluded.updated_at_ms`,
    ),

    updateFactContent: db.query('UPDATE facts SET content = ? WHERE id = ?'),
    updateFactFtsContent: db.query('UPDATE facts_fts SET content = ? WHERE fact_id = ?'),
    deleteFactFts: db.query('DELETE FROM facts_fts WHERE fact_id = ?'),
    deleteFact: db.query('DELETE FROM facts WHERE id = ?'),
    insertFact: db.query(
      `INSERT INTO facts (person_id, subject, content, category, evidence_quote, last_accessed_at_ms, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertFactFts: db.query(`INSERT INTO facts_fts (subject, content, fact_id) VALUES (?, ?, ?)`),
    selectFactsBySubject: db.query(
      `SELECT id, person_id, subject, content, category, evidence_quote, last_accessed_at_ms, created_at_ms
       FROM facts
       WHERE subject = ?
       ORDER BY created_at_ms DESC
       LIMIT 200`,
    ),
    selectFactsByPerson: db.query(
      `SELECT id, person_id, subject, content, category, evidence_quote, last_accessed_at_ms, created_at_ms
       FROM facts
       WHERE person_id = ?
       ORDER BY created_at_ms DESC
       LIMIT ?`,
    ),
    searchFactsFts: db.query(
      `SELECT f.id, f.person_id, f.subject, f.content, f.category, f.evidence_quote, f.last_accessed_at_ms, f.created_at_ms
       FROM facts_fts
       JOIN facts f ON f.id = facts_fts.fact_id
       WHERE facts_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    ),

    insertEpisode: db.query(
      `INSERT INTO episodes (chat_id, person_id, is_group, content, created_at_ms) VALUES (?, ?, ?, ?, ?)`,
    ),
    insertEpisodeFts: db.query(`INSERT INTO episodes_fts (content, episode_id) VALUES (?, ?)`),
    countEpisodesByChatId: db.query(`SELECT COUNT(*) as c FROM episodes WHERE chat_id = ?`),
    searchEpisodesFts: db.query(
      `SELECT e.id, e.chat_id, e.content, e.created_at_ms
       FROM episodes_fts
       JOIN episodes e ON e.id = episodes_fts.episode_id
       WHERE episodes_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    ),
    selectRecentEpisodes: db.query(
      `SELECT id, chat_id, person_id, is_group, content, created_at_ms
       FROM episodes
       WHERE chat_id = ? AND created_at_ms >= ?
       ORDER BY created_at_ms DESC
       LIMIT 200`,
    ),

    selectRecentGroupEpisodesForPerson: db.query(
      `SELECT id, chat_id, person_id, is_group, content, created_at_ms
       FROM episodes
       WHERE person_id = ? AND is_group = 1 AND created_at_ms >= ?
       ORDER BY created_at_ms DESC
       LIMIT 200`,
    ),

    upsertGroupCapsuleDirty: db.query(
      `INSERT INTO group_capsule_dirty (chat_id, dirty_at_ms, dirty_last_at_ms, claimed_at_ms)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(chat_id) DO UPDATE SET
         dirty_at_ms = MIN(group_capsule_dirty.dirty_at_ms, excluded.dirty_at_ms),
         dirty_last_at_ms = MAX(COALESCE(group_capsule_dirty.dirty_last_at_ms, group_capsule_dirty.dirty_at_ms), excluded.dirty_last_at_ms)`,
    ),
    selectDirtyGroupCapsules: db.query(
      `SELECT chat_id
       FROM group_capsule_dirty
       WHERE claimed_at_ms IS NULL OR claimed_at_ms < ?
       ORDER BY dirty_at_ms ASC
       LIMIT ?`,
    ),
    claimGroupCapsuleDirty: db.query(
      `UPDATE group_capsule_dirty
       SET claimed_at_ms = ?
       WHERE chat_id = ?`,
    ),
    deleteGroupCapsuleDirtyIfClean: db.query(
      `DELETE FROM group_capsule_dirty
       WHERE chat_id = ?
         AND COALESCE(dirty_last_at_ms, dirty_at_ms) <= claimed_at_ms`,
    ),
    releaseGroupCapsuleDirtyClaim: db.query(
      `UPDATE group_capsule_dirty
       SET claimed_at_ms = NULL
       WHERE chat_id = ?`,
    ),

    upsertPublicStyleDirty: db.query(
      `INSERT INTO public_style_dirty (person_id, dirty_at_ms, dirty_last_at_ms, claimed_at_ms)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(person_id) DO UPDATE SET
         dirty_at_ms = MIN(public_style_dirty.dirty_at_ms, excluded.dirty_at_ms),
         dirty_last_at_ms = MAX(COALESCE(public_style_dirty.dirty_last_at_ms, public_style_dirty.dirty_at_ms), excluded.dirty_last_at_ms)`,
    ),
    selectDirtyPublicStyles: db.query(
      `SELECT person_id
       FROM public_style_dirty
       WHERE claimed_at_ms IS NULL OR claimed_at_ms < ?
       ORDER BY dirty_at_ms ASC
       LIMIT ?`,
    ),
    claimPublicStyleDirty: db.query(
      `UPDATE public_style_dirty
       SET claimed_at_ms = ?
       WHERE person_id = ?`,
    ),
    deletePublicStyleDirtyIfClean: db.query(
      `DELETE FROM public_style_dirty
       WHERE person_id = ?
         AND COALESCE(dirty_last_at_ms, dirty_at_ms) <= claimed_at_ms`,
    ),
    releasePublicStyleDirtyClaim: db.query(
      `UPDATE public_style_dirty
       SET claimed_at_ms = NULL
       WHERE person_id = ?`,
    ),

    insertLesson: db.query(
      `INSERT INTO lessons (type, category, content, rule, alternative, person_id, episode_refs, confidence, times_validated, times_violated, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    selectLessonsByCategory: db.query(
      `SELECT id, type, category, content, rule, alternative, person_id, episode_refs, confidence, times_validated, times_violated, created_at_ms
       FROM lessons
       WHERE category = ?
       ORDER BY created_at_ms DESC
       LIMIT ?`,
    ),
    selectLessonsAll: db.query(
      `SELECT id, type, category, content, rule, alternative, person_id, episode_refs, confidence, times_validated, times_violated, created_at_ms
       FROM lessons
       ORDER BY created_at_ms DESC
       LIMIT ?`,
    ),

    deleteFactsByPerson: db.query(`DELETE FROM facts WHERE person_id = ?`),
    deletePerson: db.query(`DELETE FROM people WHERE id = ?`),

    countPeople: db.query(`SELECT COUNT(*) as c FROM people`),
    countFacts: db.query(`SELECT COUNT(*) as c FROM facts`),
    countEpisodes: db.query(`SELECT COUNT(*) as c FROM episodes`),
    countLessons: db.query(`SELECT COUNT(*) as c FROM lessons`),

    exportPeople: db.query(`SELECT * FROM people`),
    exportFacts: db.query(`SELECT * FROM facts`),
    exportEpisodes: db.query(`SELECT * FROM episodes`),
    exportGroupCapsules: db.query(`SELECT * FROM group_capsules`),
    exportLessons: db.query(`SELECT * FROM lessons`),

    importPersonReplace: db.query(
      `INSERT OR REPLACE INTO people (
         id,
         display_name,
         channel,
         channel_user_id,
         relationship_stage,
         relationship_score,
         trust_tier_override,
         capsule,
         public_style_capsule,
         created_at_ms,
         updated_at_ms
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    importFact: db.query(
      `INSERT INTO facts (person_id, subject, content, category, evidence_quote, last_accessed_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    importFactFts: db.query(`INSERT INTO facts_fts (subject, content, fact_id) VALUES (?, ?, ?)`),
    importEpisode: db.query(
      `INSERT INTO episodes (chat_id, person_id, is_group, content, created_at_ms) VALUES (?, ?, ?, ?, ?)`,
    ),
    importEpisodeFts: db.query(`INSERT INTO episodes_fts (content, episode_id) VALUES (?, ?)`),
    importLesson: db.query(
      `INSERT INTO lessons (type, category, content, rule, alternative, person_id, episode_refs, confidence, times_validated, times_violated, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
  } as const;
}
