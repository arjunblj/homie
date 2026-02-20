import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { runSqliteMigrations, type SqliteMigration } from './sqlite-migrations.js';

export function openSqliteStore(dbPath: string, migrations: readonly SqliteMigration[]): Database {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { strict: true });

  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA mmap_size = 268435456;');

  runSqliteMigrations(db, migrations);
  return db;
}
