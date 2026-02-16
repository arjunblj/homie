import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { ChatId } from '../types/ids.js';
import { runSqliteMigrations } from '../util/sqlite-migrations.js';
import { estimateTokens } from '../util/tokens.js';
import type { CompactOptions, SessionMessage, SessionStore } from './types.js';

const schemaSql = `
CREATE TABLE IF NOT EXISTS sessions (
  chat_id TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(chat_id) REFERENCES sessions(chat_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_messages_chat_id_id
  ON session_messages(chat_id, id);
`;

const formatForSummary = (msgs: SessionMessage[]): string => {
  return msgs
    .map((m) => {
      const role = m.role.toUpperCase();
      return `${role}: ${m.content}`;
    })
    .join('\n');
};

export interface SqliteSessionStoreOptions {
  dbPath: string;
}

export class SqliteSessionStore implements SessionStore {
  private readonly db: Database;
  private readonly stmts: ReturnType<typeof createStatements>;

  public constructor(options: SqliteSessionStoreOptions) {
    mkdirSync(path.dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath, { strict: true });

    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA mmap_size = 268435456;');
    runSqliteMigrations(this.db, [schemaSql]);
    this.stmts = createStatements(this.db);
  }

  public appendMessage(msg: SessionMessage): void {
    const now = msg.createdAtMs;
    const chatId = msg.chatId as unknown as string;

    const tx = this.db.transaction(() => {
      this.stmts.upsertSession.run(chatId, now, now);
      this.stmts.insertMessage.run(chatId, msg.role, msg.content, now);
    });

    tx();
  }

  public getMessages(chatId: ChatId, limit = 200): SessionMessage[] {
    const rows = this.stmts.selectMessagesDesc.all(chatId as unknown as string, limit) as Array<{
      id: number;
      chat_id: string;
      role: string;
      content: string;
      created_at_ms: number;
    }>;

    return rows
      .map((r) => ({
        id: r.id,
        chatId: r.chat_id as unknown as ChatId,
        role: r.role as SessionMessage['role'],
        content: r.content,
        createdAtMs: r.created_at_ms,
      }))
      .reverse();
  }

  public estimateTokens(chatId: ChatId): number {
    const msgs = this.getMessages(chatId, 500);
    return estimateTokens(formatForSummary(msgs));
  }

  public async compactIfNeeded(options: CompactOptions): Promise<boolean> {
    const { chatId, maxTokens, personaReminder, summarize } = options;

    const msgs = this.getMessages(chatId, 2_000);
    if (msgs.length < 8) return false;

    const totalTokens = estimateTokens(formatForSummary(msgs));
    const threshold = Math.floor(maxTokens * 0.8);
    if (totalTokens <= threshold) return false;

    const targetKeepTokens = Math.floor(maxTokens * 0.6);

    let summarizeUntil = 0;
    let remainingTokens = totalTokens;
    for (let i = 0; i < msgs.length; i += 1) {
      if (remainingTokens <= targetKeepTokens) break;
      const m = msgs[i];
      if (!m) break;
      summarizeUntil = i + 1;
      remainingTokens -= estimateTokens(`${m.role}: ${m.content}`);
    }

    if (summarizeUntil <= 0 || summarizeUntil >= msgs.length - 2) return false;

    const toSummarize = msgs.slice(0, summarizeUntil);
    const toKeep = msgs.slice(summarizeUntil);

    const summaryInput = formatForSummary(toSummarize);
    const summary = (await summarize(summaryInput)).trim();
    if (!summary) return false;

    const first = toSummarize.at(0);
    const last = toSummarize.at(-1);
    if (!first || !last) return false;

    const oldestId = first.id;
    const newestId = last.id;
    if (oldestId === undefined || newestId === undefined) return false;

    const now = Date.now();
    const chatIdRaw = chatId as unknown as string;

    const tx = this.db.transaction(() => {
      this.stmts.deleteRange.run(chatIdRaw, oldestId, newestId);
      this.stmts.insertSystem.run(chatIdRaw, `=== CONVERSATION SUMMARY ===\n${summary}`, now);
      this.stmts.insertSystem.run(
        chatIdRaw,
        `=== PERSONA REMINDER ===\n${personaReminder}`,
        now + 1,
      );

      for (const m of toKeep) {
        this.stmts.insertMessage.run(chatIdRaw, m.role, m.content, m.createdAtMs);
      }
    });

    tx();
    return true;
  }
}

function createStatements(db: Database) {
  return {
    upsertSession: db.query(
      `INSERT INTO sessions (chat_id, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET updated_at_ms=excluded.updated_at_ms`,
    ),
    insertMessage: db.query(
      `INSERT INTO session_messages (chat_id, role, content, created_at_ms)
       VALUES (?, ?, ?, ?)`,
    ),
    selectMessagesDesc: db.query(
      `SELECT id, chat_id, role, content, created_at_ms
       FROM session_messages
       WHERE chat_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    ),
    deleteRange: db.query(
      `DELETE FROM session_messages
       WHERE chat_id = ?
         AND id >= ?
         AND id <= ?`,
    ),
    insertSystem: db.query(
      `INSERT INTO session_messages (chat_id, role, content, created_at_ms)
       VALUES (?, 'system', ?, ?)`,
    ),
  } as const;
}
