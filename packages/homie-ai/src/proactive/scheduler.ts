import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { parseChatId } from '../channels/chatId.js';
import { asChatId, type ChatId } from '../types/ids.js';
import { closeSqliteBestEffort } from '../util/sqlite-close.js';
import { runSqliteMigrations } from '../util/sqlite-migrations.js';
import type { EventKind, ProactiveEvent } from './types.js';

const migrationV1 = `
CREATE TABLE IF NOT EXISTS proactive_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  trigger_at_ms INTEGER NOT NULL,
  recurrence TEXT,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_trigger
  ON proactive_events(trigger_at_ms, delivered);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe
  ON proactive_events(chat_id, kind, subject, trigger_at_ms, recurrence);

CREATE TABLE IF NOT EXISTS proactive_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  sent_at_ms INTEGER NOT NULL,
  responded INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_log_chat_sent
  ON proactive_log(chat_id, sent_at_ms);
`;

const migrationV2 = `
ALTER TABLE proactive_events ADD COLUMN claim_id TEXT;
ALTER TABLE proactive_events ADD COLUMN claim_until_ms INTEGER;

ALTER TABLE proactive_log ADD COLUMN proactive_event_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_events_claim
  ON proactive_events(delivered, claim_until_ms, trigger_at_ms);
`;

const migrationV3 = `
ALTER TABLE proactive_log ADD COLUMN is_group INTEGER;

CREATE INDEX IF NOT EXISTS idx_log_is_group_sent
  ON proactive_log(is_group, sent_at_ms);
`;

const PROACTIVE_MIGRATIONS = [migrationV1, migrationV2, migrationV3] as const;

export interface EventSchedulerOptions {
  readonly dbPath: string;
}

export class EventScheduler {
  private readonly db: Database;
  private readonly stmts: ReturnType<typeof createStatements>;

  public constructor(options: EventSchedulerOptions) {
    mkdirSync(path.dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath, { strict: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    runSqliteMigrations(this.db, PROACTIVE_MIGRATIONS);
    this.stmts = createStatements(this.db);
  }

  public ping(): void {
    this.db.query('SELECT 1').get();
  }

  public close(): void {
    closeSqliteBestEffort(this.db, 'sqlite_proactive');
  }

  public addEvent(event: Omit<ProactiveEvent, 'id' | 'delivered'>): number {
    const result = this.stmts.insertEventIgnore.run(
      event.kind,
      event.subject,
      String(event.chatId),
      event.triggerAtMs,
      event.recurrence,
      event.createdAtMs,
    );
    if (result.changes > 0) return Number(result.lastInsertRowid);

    const row = this.stmts.selectEventId.get(
      String(event.chatId),
      event.kind,
      event.subject,
      event.triggerAtMs,
      event.recurrence,
    ) as { id: number } | undefined;
    return row?.id ?? 0;
  }

  public getPendingEvents(windowMs: number): ProactiveEvent[] {
    const now = Date.now();
    const rows = this.stmts.selectPendingEvents.all(now + windowMs) as Array<{
      id: number;
      kind: string;
      subject: string;
      chat_id: string;
      trigger_at_ms: number;
      recurrence: string | null;
      delivered: number;
      created_at_ms: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as EventKind,
      subject: r.subject,
      chatId: asChatId(r.chat_id),
      triggerAtMs: r.trigger_at_ms,
      recurrence: r.recurrence as 'once' | 'yearly' | null,
      delivered: r.delivered === 1,
      createdAtMs: r.created_at_ms,
    }));
  }

  public claimPendingEvents(options: {
    readonly windowMs: number;
    readonly limit: number;
    readonly leaseMs: number;
    readonly claimId: string;
  }): ProactiveEvent[] {
    const now = Date.now();
    const until = now + Math.max(1, Math.floor(options.leaseMs));
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit)));
    const rows: Array<{
      id: number;
      kind: string;
      subject: string;
      chat_id: string;
      trigger_at_ms: number;
      recurrence: string | null;
      delivered: number;
      created_at_ms: number;
    }> = [];

    const tx = this.db.transaction(() => {
      const candidates = this.stmts.selectClaimableEvents.all(
        now + options.windowMs,
        now,
        limit,
      ) as typeof rows;
      for (const r of candidates) {
        const res = this.stmts.claimEvent.run(options.claimId, until, r.id, now);
        if (res.changes > 0) rows.push(r);
      }
    });
    // BEGIN IMMEDIATE: claim must be atomic across processes.
    tx.immediate();

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as EventKind,
      subject: r.subject,
      chatId: asChatId(r.chat_id),
      triggerAtMs: r.trigger_at_ms,
      recurrence: r.recurrence as 'once' | 'yearly' | null,
      delivered: r.delivered === 1,
      createdAtMs: r.created_at_ms,
    }));
  }

  public releaseClaim(id: number, claimId: string): void {
    this.stmts.releaseClaim.run(id, claimId);
  }

  public markDelivered(id: number, claimId: string): void {
    this.stmts.markDelivered.run(id, claimId);
  }

  public cancelEvent(id: number): void {
    this.stmts.deleteEvent.run(id);
  }

  public logProactiveSend(chatId: ChatId, proactiveEventId?: number | undefined): void {
    const kind = parseChatId(chatId)?.kind;
    const isGroup = kind === 'group' ? 1 : 0;
    this.stmts.insertLog.run(String(chatId), Date.now(), proactiveEventId ?? null, isGroup);
  }

  public markProactiveResponded(chatId: ChatId): void {
    this.stmts.markResponded.run(String(chatId));
  }

  public countRecentSends(windowMs: number): number {
    const since = Date.now() - windowMs;
    const row = this.stmts.countSince.get(since) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  public countRecentSendsForScope(isGroup: boolean, windowMs: number): number {
    const since = Date.now() - windowMs;
    const row = this.stmts.countSinceForScope.get(isGroup ? 1 : 0, since) as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  }

  public countRecentSendsForChat(chatId: ChatId, windowMs: number): number {
    const since = Date.now() - windowMs;
    const row = this.stmts.countSinceForChat.get(String(chatId), since) as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  }

  public countIgnoredRecent(chatId: ChatId, limit: number): number {
    const rows = this.stmts.selectRecentResponded.all(String(chatId), limit) as Array<{
      responded: number;
    }>;

    let ignored = 0;
    for (const r of rows) {
      if (r.responded === 0) ignored++;
      else break;
    }
    return ignored;
  }
}

function createStatements(db: Database) {
  return {
    insertEventIgnore: db.query(
      'INSERT OR IGNORE INTO proactive_events (kind, subject, chat_id, trigger_at_ms, recurrence, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    selectEventId: db.query(
      'SELECT id FROM proactive_events WHERE chat_id = ? AND kind = ? AND subject = ? AND trigger_at_ms = ? AND recurrence IS ? LIMIT 1',
    ),
    selectPendingEvents: db.query(
      'SELECT * FROM proactive_events WHERE delivered = 0 AND trigger_at_ms <= ? ORDER BY trigger_at_ms ASC',
    ),
    selectClaimableEvents: db.query(
      'SELECT * FROM proactive_events WHERE delivered = 0 AND trigger_at_ms <= ? AND (claim_until_ms IS NULL OR claim_until_ms <= ?) ORDER BY trigger_at_ms ASC LIMIT ?',
    ),
    claimEvent: db.query(
      'UPDATE proactive_events SET claim_id = ?, claim_until_ms = ? WHERE id = ? AND delivered = 0 AND (claim_until_ms IS NULL OR claim_until_ms <= ?)',
    ),
    releaseClaim: db.query(
      'UPDATE proactive_events SET claim_id = NULL, claim_until_ms = NULL WHERE id = ? AND claim_id = ? AND delivered = 0',
    ),
    markDelivered: db.query(
      'UPDATE proactive_events SET delivered = 1, claim_id = NULL, claim_until_ms = NULL WHERE id = ? AND claim_id = ?',
    ),
    deleteEvent: db.query('DELETE FROM proactive_events WHERE id = ?'),
    insertLog: db.query(
      'INSERT INTO proactive_log (chat_id, sent_at_ms, proactive_event_id, is_group) VALUES (?, ?, ?, ?)',
    ),
    markResponded: db.query(
      'UPDATE proactive_log SET responded = 1 WHERE chat_id = ? AND responded = 0 ORDER BY sent_at_ms DESC LIMIT 1',
    ),
    countSince: db.query('SELECT COUNT(*) as count FROM proactive_log WHERE sent_at_ms >= ?'),
    countSinceForScope: db.query(
      'SELECT COUNT(*) as count FROM proactive_log WHERE is_group = ? AND sent_at_ms >= ?',
    ),
    countSinceForChat: db.query(
      'SELECT COUNT(*) as count FROM proactive_log WHERE chat_id = ? AND sent_at_ms >= ?',
    ),
    selectRecentResponded: db.query(
      'SELECT responded FROM proactive_log WHERE chat_id = ? ORDER BY sent_at_ms DESC LIMIT ?',
    ),
  } as const;
}
