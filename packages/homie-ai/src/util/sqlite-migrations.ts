import type { Database } from 'bun:sqlite';

export function runSqliteMigrations(db: Database, migrations: readonly string[]): void {
  const row = db.query('PRAGMA user_version').get() as { user_version: number } | undefined;
  const current = Math.max(0, Number(row?.user_version ?? 0) | 0);

  if (current >= migrations.length) return;

  const tx = db.transaction(() => {
    for (let i = current; i < migrations.length; i += 1) {
      const sql = migrations[i];
      if (sql?.trim()) db.exec(sql);
      db.exec(`PRAGMA user_version = ${i + 1};`);
    }
  });
  tx();
}
