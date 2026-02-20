import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { asPersonId } from '../types/ids.js';
import { SqliteMemoryStore } from './sqlite.js';

describe('SqliteMemoryStore migrations', () => {
  test('upgrades older dbs missing newer columns', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-mem-mig-'));
    const dbPath = path.join(tmp, 'memory.db');
    try {
      // Simulate an older database missing newer columns (capsule/category/etc).
      const db = new Database(dbPath, { strict: true });
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec(`
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
      `);
      db.exec('PRAGMA user_version = 1;');
      db.close();

      const store = new SqliteMemoryStore({ dbPath });
      const personId = asPersonId('p1');
      await store.trackPerson({
        id: personId,
        displayName: 'Alice',
        channel: 'telegram',
        channelUserId: 'tg:1',
        relationshipScore: 0,
        capsule: 'test capsule',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });

      await store.storeFact({
        personId,
        subject: 'food',
        content: 'Likes sushi',
        category: 'preference',
        evidenceQuote: 'I love sushi.',
        lastAccessedAtMs: Date.now(),
        createdAtMs: Date.now(),
      });

      await store.logLesson({
        type: 'observation',
        category: 'behavioral_feedback',
        content: 'Prefer short replies',
        rule: 'Keep replies short and warm',
        personId,
        episodeRefs: ['ep1'],
        confidence: 0.6,
        timesValidated: 1,
        timesViolated: 0,
        createdAtMs: Date.now(),
      });
      store.close();

      const inspect = new Database(dbPath, { strict: true });
      const peopleCols = (
        inspect.query(`PRAGMA table_info(people)`).all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(peopleCols).toContain('capsule');
      expect(peopleCols).toContain('relationship_score');
      expect(peopleCols).toContain('trust_tier_override');

      const factsCols = (
        inspect.query(`PRAGMA table_info(facts)`).all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(factsCols).toContain('category');
      expect(factsCols).toContain('evidence_quote');
      expect(factsCols).toContain('last_accessed_at_ms');

      const lessonsCols = (
        inspect.query(`PRAGMA table_info(lessons)`).all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(lessonsCols).toContain('type');
      expect(lessonsCols).toContain('rule');
      expect(lessonsCols).toContain('person_id');
      expect(lessonsCols).toContain('episode_refs');
      expect(lessonsCols).toContain('confidence');
      expect(lessonsCols).toContain('times_validated');
      expect(lessonsCols).toContain('times_violated');
      inspect.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('adds lessons.person_id FK with ON DELETE CASCADE', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homie-mem-mig-lessons-fk-'));
    const dbPath = path.join(tmp, 'memory.db');
    try {
      const db = new Database(dbPath, { strict: true });
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS people (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          channel TEXT NOT NULL,
          channel_user_id TEXT NOT NULL,
          relationship_stage TEXT NOT NULL,
          relationship_score REAL NOT NULL DEFAULT 0,
          capsule TEXT,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_people_channel_user_id
          ON people(channel, channel_user_id);
        CREATE TABLE IF NOT EXISTS lessons (
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
          created_at_ms INTEGER NOT NULL
        );
      `);
      db.exec('PRAGMA user_version = 0;');
      db.close();

      const store = new SqliteMemoryStore({ dbPath });
      store.close();

      const inspect = new Database(dbPath, { strict: true });
      const fks = inspect.query(`PRAGMA foreign_key_list(lessons)`).all() as Array<{
        table: string;
        from: string;
        on_delete: string;
      }>;
      const hasExpectedFk = fks.some(
        (fk) =>
          fk.table === 'people' &&
          fk.from === 'person_id' &&
          fk.on_delete.toUpperCase() === 'CASCADE',
      );
      expect(hasExpectedFk).toBe(true);
      inspect.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
