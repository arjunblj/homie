import type { Database } from 'bun:sqlite';

import { errorFields, log } from './logger.js';

export function closeSqliteBestEffort(db: Database, component: string): void {
  const logger = log.child({ component });
  try {
    // Prefer non-strict close first: better operational behavior under contention.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.close(false);
    return;
  } catch (err) {
    logger.debug('sqlite.close.failed', errorFields(err));
  }

  try {
    db.close(true);
  } catch (err) {
    logger.debug('sqlite.close.force_failed', errorFields(err));
  }
}
