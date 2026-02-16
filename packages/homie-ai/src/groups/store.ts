import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { ChatId } from '../types/ids.js';

export interface GroupRecord {
  chatId: ChatId;
  channel: string;
  name: string;
  members: string[];
  createdAtMs: number;
  updatedAtMs: number;
}

const schemaSql = `
CREATE TABLE IF NOT EXISTS groups (
  chat_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  chat_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  joined_at_ms INTEGER NOT NULL,
  PRIMARY KEY (chat_id, member_id),
  FOREIGN KEY(chat_id) REFERENCES groups(chat_id) ON DELETE CASCADE
);
`;

export interface GroupStoreOptions {
  dbPath: string;
}

export class GroupStore {
  private readonly db: Database;

  public constructor(options: GroupStoreOptions) {
    mkdirSync(path.dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA mmap_size = 268435456;');
    this.db.exec(schemaSql);
  }

  public upsertGroup(chatId: ChatId, channel: string, name: string): void {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO groups (chat_id, channel, name, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           name = excluded.name,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(chatId as unknown as string, channel, name, now, now);
  }

  public trackMember(chatId: ChatId, memberId: string): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO group_members (chat_id, member_id, joined_at_ms)
         VALUES (?, ?, ?)`,
      )
      .run(chatId as unknown as string, memberId, Date.now());
  }

  public getMembers(chatId: ChatId): string[] {
    const rows = this.db
      .query(`SELECT member_id FROM group_members WHERE chat_id = ? ORDER BY joined_at_ms`)
      .all(chatId as unknown as string) as Array<{ member_id: string }>;
    return rows.map((r) => r.member_id);
  }

  public getGroup(chatId: ChatId): GroupRecord | null {
    const row = this.db
      .query(
        `SELECT chat_id, channel, name, created_at_ms, updated_at_ms FROM groups WHERE chat_id = ?`,
      )
      .get(chatId as unknown as string) as
      | {
          chat_id: string;
          channel: string;
          name: string;
          created_at_ms: number;
          updated_at_ms: number;
        }
      | undefined;
    if (!row) return null;
    return {
      chatId: row.chat_id as unknown as ChatId,
      channel: row.channel,
      name: row.name,
      members: this.getMembers(chatId),
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    };
  }

  public listGroups(): GroupRecord[] {
    const rows = this.db
      .query(
        `SELECT chat_id, channel, name, created_at_ms, updated_at_ms FROM groups ORDER BY updated_at_ms DESC`,
      )
      .all() as Array<{
      chat_id: string;
      channel: string;
      name: string;
      created_at_ms: number;
      updated_at_ms: number;
    }>;
    return rows.map((r) => ({
      chatId: r.chat_id as unknown as ChatId,
      channel: r.channel,
      name: r.name,
      members: this.getMembers(r.chat_id as unknown as ChatId),
      createdAtMs: r.created_at_ms,
      updatedAtMs: r.updated_at_ms,
    }));
  }
}
