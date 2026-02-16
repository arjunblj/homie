import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { asChatId, type ChatId } from '../types/ids.js';
import type { EventKind, ProactiveEvent } from './types.js';

const schemaSql = `
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

CREATE TABLE IF NOT EXISTS proactive_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  sent_at_ms INTEGER NOT NULL,
  responded INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_log_chat_sent
  ON proactive_log(chat_id, sent_at_ms);
`;

export interface EventSchedulerOptions {
  readonly dbPath: string;
}

export class EventScheduler {
  private readonly db: Database;

  public constructor(options: EventSchedulerOptions) {
    mkdirSync(path.dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath, { strict: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(schemaSql);
  }

  public addEvent(event: Omit<ProactiveEvent, 'id' | 'delivered'>): number {
    const result = this.db
      .query(
        'INSERT INTO proactive_events (kind, subject, chat_id, trigger_at_ms, recurrence, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        event.kind,
        event.subject,
        String(event.chatId),
        event.triggerAtMs,
        event.recurrence,
        event.createdAtMs,
      );
    return Number(result.lastInsertRowid);
  }

  public getPendingEvents(windowMs: number): ProactiveEvent[] {
    const now = Date.now();
    const rows = this.db
      .query(
        'SELECT * FROM proactive_events WHERE delivered = 0 AND trigger_at_ms <= ? ORDER BY trigger_at_ms ASC',
      )
      .all(now + windowMs) as Array<{
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

  public markDelivered(id: number): void {
    this.db.query('UPDATE proactive_events SET delivered = 1 WHERE id = ?').run(id);
  }

  public logProactiveSend(chatId: ChatId): void {
    this.db
      .query('INSERT INTO proactive_log (chat_id, sent_at_ms) VALUES (?, ?)')
      .run(String(chatId), Date.now());
  }

  public markProactiveResponded(chatId: ChatId): void {
    this.db
      .query(
        'UPDATE proactive_log SET responded = 1 WHERE chat_id = ? AND responded = 0 ORDER BY sent_at_ms DESC LIMIT 1',
      )
      .run(String(chatId));
  }

  public countRecentSends(windowMs: number): number {
    const since = Date.now() - windowMs;
    const row = this.db
      .query('SELECT COUNT(*) as count FROM proactive_log WHERE sent_at_ms >= ?')
      .get(since) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  public countIgnoredRecent(chatId: ChatId, limit: number): number {
    const rows = this.db
      .query(
        'SELECT responded FROM proactive_log WHERE chat_id = ? ORDER BY sent_at_ms DESC LIMIT ?',
      )
      .all(String(chatId), limit) as Array<{ responded: number }>;

    let ignored = 0;
    for (const r of rows) {
      if (r.responded === 0) ignored++;
      else break;
    }
    return ignored;
  }
}
