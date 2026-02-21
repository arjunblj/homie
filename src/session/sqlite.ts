import type { Database } from 'bun:sqlite';
import { z } from 'zod';

import { AttachmentMetaSchema } from '../agent/attachments.js';
import type { ChatId } from '../types/ids.js';
import { log } from '../util/logger.js';
import { closeSqliteBestEffort } from '../util/sqlite-close.js';
import { openSqliteStore } from '../util/sqlite-open.js';
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
  author_id TEXT,
  author_display_name TEXT,
  source_message_id TEXT,
  attachments_json TEXT,
  FOREIGN KEY(chat_id) REFERENCES sessions(chat_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_messages_chat_id_id
  ON session_messages(chat_id, id);
`;

const AttachmentArraySchema = z.array(AttachmentMetaSchema);

const logger = log.child({ component: 'sqlite_session' });

const parseAttachmentsJson = (raw: string | null): SessionMessage['attachments'] => {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = AttachmentArraySchema.safeParse(JSON.parse(trimmed));
    if (parsed.success) return parsed.data;
    logger.debug('attachments_json_invalid', { error: parsed.error.message });
    return undefined;
  } catch (_err) {
    return undefined;
  }
};

const ensureColumnsMigration = {
  name: 'ensure_session_message_columns',
  up: (db: Database): void => {
    const hasColumn = (table: string, col: string): boolean => {
      const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return rows.some((r) => r.name === col);
    };
    const addColumn = (table: string, colDef: string, colName: string): void => {
      if (hasColumn(table, colName)) return;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef};`);
    };

    // Keep DBs created by older schema versions usable.
    addColumn('session_messages', 'author_id TEXT', 'author_id');
    addColumn('session_messages', 'author_display_name TEXT', 'author_display_name');
    addColumn('session_messages', 'source_message_id TEXT', 'source_message_id');
    addColumn('session_messages', 'attachments_json TEXT', 'attachments_json');
  },
} as const;

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
    this.db = openSqliteStore(options.dbPath, [schemaSql, ensureColumnsMigration]);
    this.stmts = createStatements(this.db);
  }

  public ping(): void {
    this.db.query('SELECT 1').get();
  }

  public close(): void {
    closeSqliteBestEffort(this.db, 'sqlite_session');
  }

  public appendMessage(msg: SessionMessage): void {
    const now = msg.createdAtMs;
    const chatId = String(msg.chatId);
    const attachmentsJson =
      msg.attachments && msg.attachments.length > 0 ? JSON.stringify(msg.attachments) : null;

    const tx = this.db.transaction(() => {
      this.stmts.upsertSession.run(chatId, now, now);
      this.stmts.insertMessage.run(
        chatId,
        msg.role,
        msg.content,
        now,
        msg.authorId ?? null,
        msg.authorDisplayName ?? null,
        msg.sourceMessageId ?? null,
        attachmentsJson,
      );
    });
    tx();
  }

  public getMessages(chatId: ChatId, limit = 200): SessionMessage[] {
    const rows = this.stmts.selectMessagesDesc.all(String(chatId), limit) as Array<{
      id: number;
      chat_id: string;
      role: string;
      content: string;
      created_at_ms: number;
      author_id: string | null;
      author_display_name: string | null;
      source_message_id: string | null;
      attachments_json: string | null;
    }>;

    return rows
      .map((r) => ({
        id: r.id,
        chatId: r.chat_id as unknown as ChatId,
        role: r.role as SessionMessage['role'],
        content: r.content,
        createdAtMs: r.created_at_ms,
        authorId: r.author_id ?? undefined,
        authorDisplayName: r.author_display_name ?? undefined,
        sourceMessageId: r.source_message_id ?? undefined,
        attachments: parseAttachmentsJson(r.attachments_json),
      }))
      .reverse();
  }

  public estimateTokens(chatId: ChatId): number {
    const msgs = this.getMessages(chatId, 500);
    return estimateTokens(formatForSummary(msgs));
  }

  public async compactIfNeeded(options: CompactOptions): Promise<boolean> {
    const { chatId, maxTokens, personaReminder, summarize } = options;
    const force = options.force ?? false;

    const msgs = this.getMessages(chatId, 2_000);
    if (msgs.length < 8) return false;

    const totalTokens = estimateTokens(formatForSummary(msgs));
    if (!force) {
      const threshold = Math.floor(maxTokens * 0.8);
      if (totalTokens <= threshold) return false;
    }

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

    const summaryInput = formatForSummary(toSummarize);
    let summary: string;
    try {
      summary = (await summarize(summaryInput)).trim();
    } catch (err) {
      logger.debug('compact.summarize_failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    if (!summary) return false;

    const first = toSummarize.at(0);
    const last = toSummarize.at(-1);
    if (!first || !last) return false;

    const oldestId = first.id;
    const newestId = last.id;
    if (oldestId === undefined || newestId === undefined) return false;

    const now = Date.now();
    const chatIdRaw = String(chatId);

    const tx = this.db.transaction(() => {
      this.stmts.deleteRange.run(chatIdRaw, oldestId, newestId);
      this.stmts.insertSystem.run(chatIdRaw, `=== CONVERSATION SUMMARY ===\n${summary}`, now);
      this.stmts.insertSystem.run(
        chatIdRaw,
        `=== PERSONA REMINDER ===\n${personaReminder}`,
        now + 1,
      );
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
      `INSERT INTO session_messages (chat_id, role, content, created_at_ms, author_id, author_display_name, source_message_id, attachments_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    selectMessagesDesc: db.query(
      `SELECT id, chat_id, role, content, created_at_ms, author_id, author_display_name, source_message_id, attachments_json
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
