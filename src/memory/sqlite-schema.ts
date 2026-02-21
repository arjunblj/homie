import type { Database } from 'bun:sqlite';

export const schemaSql = `
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  channel TEXT NOT NULL,
  channel_user_id TEXT NOT NULL,
  relationship_stage TEXT NOT NULL,
  relationship_score REAL NOT NULL DEFAULT 0,
  trust_tier_override TEXT,
  capsule TEXT,
  capsule_updated_at_ms INTEGER,
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
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE
);
`;

export const ensureColumnsMigration = {
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

export const indexSql = `
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

export const ensureColumnsV2Migration = {
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

export const ensureColumnsV3Migration = {
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

export const ensureColumnsV4Migration = {
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

export const ensureColumnsV5Migration = {
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

export const ensureColumnsV6Migration = {
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

export const ensureColumnsV7Migration = {
  name: 'ensure_columns_v7_capsule_updated_at_ms',
  up: (db: Database): void => {
    const hasColumn = (table: string, col: string): boolean => {
      const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return rows.some((r) => r.name === col);
    };
    const addColumn = (table: string, colDef: string, colName: string): void => {
      if (hasColumn(table, colName)) return;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef};`);
    };

    addColumn('people', 'capsule_updated_at_ms INTEGER', 'capsule_updated_at_ms');

    db.exec(`
      UPDATE people
      SET capsule_updated_at_ms = updated_at_ms
      WHERE capsule IS NOT NULL AND capsule_updated_at_ms IS NULL;
    `);
  },
} as const;

export const ensureColumnsV8Migration = {
  name: 'ensure_columns_v8_lessons_person_fk',
  up: (db: Database): void => {
    const fks = db.query(`PRAGMA foreign_key_list(lessons)`).all() as Array<{
      table?: string;
      from?: string;
      on_delete?: string;
    }>;
    const hasCascadeFk = fks.some(
      (fk) =>
        String(fk.table ?? '').toLowerCase() === 'people' &&
        String(fk.from ?? '').toLowerCase() === 'person_id' &&
        String(fk.on_delete ?? '').toUpperCase() === 'CASCADE',
    );
    if (hasCascadeFk) return;

    const tx = db.transaction(() => {
      db.exec(`
        CREATE TABLE lessons_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT,
          category TEXT NOT NULL,
          content TEXT NOT NULL,
          rule TEXT,
          alternative TEXT,
          person_id TEXT,
          episode_refs TEXT,
          confidence REAL,
          times_validated INTEGER DEFAULT 0,
          times_violated INTEGER DEFAULT 0,
          created_at_ms INTEGER NOT NULL,
          FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE
        );
      `);
      db.exec(`
        INSERT INTO lessons_new (
          id, type, category, content, rule, alternative, person_id, episode_refs,
          confidence, times_validated, times_violated, created_at_ms
        )
        SELECT
          id, type, category, content, rule, alternative, person_id, episode_refs,
          confidence, times_validated, times_violated, created_at_ms
        FROM lessons;
      `);
      db.exec(`DROP TABLE lessons;`);
      db.exec(`ALTER TABLE lessons_new RENAME TO lessons;`);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_lessons_category_created
          ON lessons(category, created_at_ms DESC);
        CREATE INDEX IF NOT EXISTS idx_lessons_person_created
          ON lessons(person_id, created_at_ms DESC);
      `);
    });
    tx();
  },
} as const;

export const observationCountersMigration = {
  name: 'observation_counters',
  up: (db: Database): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS observation_counters (
        person_id TEXT PRIMARY KEY,
        avg_response_length REAL NOT NULL DEFAULT 0,
        avg_their_message_length REAL NOT NULL DEFAULT 0,
        active_hours_bitmask INTEGER NOT NULL DEFAULT 0,
        conversation_count INTEGER NOT NULL DEFAULT 0,
        sample_count INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE
      );
    `);
  },
} as const;

export const MEMORY_MIGRATIONS = [
  schemaSql,
  ensureColumnsMigration,
  indexSql,
  ensureColumnsV2Migration,
  ensureColumnsV3Migration,
  ensureColumnsV4Migration,
  ensureColumnsV5Migration,
  ensureColumnsV6Migration,
  ensureColumnsV7Migration,
  ensureColumnsV8Migration,
  observationCountersMigration,
] as const;
