import type { Database } from 'bun:sqlite';

export type SqliteMigration =
  | string
  | {
      name?: string | undefined;
      up: string | ((db: Database) => void);
    };

export function runSqliteMigrations(db: Database, migrations: readonly SqliteMigration[]): void {
  const row = db.query('PRAGMA user_version').get() as { user_version: number } | undefined;
  const current = Math.max(0, Number(row?.user_version ?? 0) | 0);

  if (current >= migrations.length) return;

  const tx = db.transaction(() => {
    for (let i = current; i < migrations.length; i += 1) {
      const migration = migrations[i];
      if (!migration) continue;
      if (typeof migration === 'string') {
        if (migration.trim()) db.exec(migration);
      } else {
        if (typeof migration.up === 'string') {
          if (migration.up.trim()) db.exec(migration.up);
        } else {
          migration.up(db);
        }
      }
      db.exec(`PRAGMA user_version = ${i + 1};`);
    }
  });
  // BEGIN IMMEDIATE to avoid concurrent writers during boot.
  tx.immediate();
}
