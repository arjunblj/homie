import type { Database } from 'bun:sqlite';
import { z } from 'zod';

import { AttachmentMetaSchema } from '../agent/attachments.js';
import type { ChatId } from '../types/ids.js';
import { log } from '../util/logger.js';
import { closeSqliteBestEffort } from '../util/sqlite-close.js';
import { openSqliteStore } from '../util/sqlite-open.js';
import { estimateTokens } from '../util/tokens.js';
import type {
  CompactOptions,
  SessionMessage,
  SessionNote,
  SessionStore,
  UpsertSessionNoteResult,
} from './types.js';

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

-- Compaction-proof per-chat scratchpad notes.
CREATE TABLE IF NOT EXISTS session_notes (
  chat_id TEXT NOT NULL,
  note_key TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (chat_id, note_key),
  FOREIGN KEY(chat_id) REFERENCES sessions(chat_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_notes_chat_id_updated_at_ms
  ON session_notes(chat_id, updated_at_ms DESC);

-- Compaction-proof record of what we sent recently (used as data-only context).
CREATE TABLE IF NOT EXISTS outbound_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  person_id TEXT,
  content_preview TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'reactive',
  sent_at_ms INTEGER NOT NULL,
  got_reply INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_outbound_ledger_chat_id_sent_at_ms
  ON outbound_ledger(chat_id, sent_at_ms DESC);
`;

const AttachmentArraySchema = z.array(AttachmentMetaSchema);

const logger = log.child({ component: 'sqlite_session' });

const SESSION_NOTES_MAX_KEYS_PER_CHAT = 64;
const SESSION_NOTES_MAX_BYTES_PER_KEY = 24 * 1024;

const truncateUtf8Bytes = (
  input: string,
  maxBytes: number,
): { text: string; truncated: boolean } => {
  const bytes = new TextEncoder().encode(input);
  if (bytes.byteLength <= maxBytes) return { text: input, truncated: false };
  const truncated = bytes.slice(0, maxBytes);
  return { text: new TextDecoder().decode(truncated), truncated: true };
};

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

    // Notes table may not exist in older DBs (schemaSql may not run when user_version is set).
    db.exec(`
CREATE TABLE IF NOT EXISTS session_notes (
  chat_id TEXT NOT NULL,
  note_key TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (chat_id, note_key),
  FOREIGN KEY(chat_id) REFERENCES sessions(chat_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_notes_chat_id_updated_at_ms
  ON session_notes(chat_id, updated_at_ms DESC);
`);
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

  public listChatIds(limit = 200, offset = 0): ChatId[] {
    const lim = Math.max(0, Math.floor(limit));
    const off = Math.max(0, Math.floor(offset));
    const rows = this.stmts.selectChatIds.all(lim, off) as Array<{ chat_id: string }>;
    return rows.map((r) => r.chat_id as unknown as ChatId);
  }

  public upsertNote(opts: {
    chatId: ChatId;
    key: string;
    content: string;
    nowMs: number;
  }): UpsertSessionNoteResult {
    const chatIdRaw = String(opts.chatId);
    const key = opts.key.trim();
    const nowMs = Math.floor(opts.nowMs);
    const { text: content, truncated } = truncateUtf8Bytes(
      opts.content,
      SESSION_NOTES_MAX_BYTES_PER_KEY,
    );

    if (!key) {
      const fallback: SessionNote = {
        chatId: opts.chatId,
        key: '',
        content: '',
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      return { note: fallback, truncated: false };
    }

    const existing = this.stmts.selectNote.get(chatIdRaw, key) as
      | { note_key: string; content: string; created_at_ms: number; updated_at_ms: number }
      | undefined;
    const isNewKey = !existing;
    let evictedKey: string | undefined;

    if (isNewKey) {
      const row = this.stmts.countNotes.get(chatIdRaw) as { c: number } | undefined;
      const count = row?.c ?? 0;
      if (count >= SESSION_NOTES_MAX_KEYS_PER_CHAT) {
        const oldest = this.stmts.selectOldestNoteKey.get(chatIdRaw) as
          | { note_key: string }
          | undefined;
        if (oldest?.note_key) {
          this.stmts.deleteNote.run(chatIdRaw, oldest.note_key);
          evictedKey = oldest.note_key;
        }
      }
    }

    // Ensure a sessions(chat_id) row exists for foreign key integrity.
    this.stmts.upsertSession.run(chatIdRaw, nowMs, nowMs);

    this.stmts.upsertNote.run(chatIdRaw, key, content, nowMs, nowMs);
    const noteRow = this.stmts.selectNote.get(chatIdRaw, key) as
      | { note_key: string; content: string; created_at_ms: number; updated_at_ms: number }
      | undefined;
    const note: SessionNote = {
      chatId: opts.chatId,
      key,
      content: noteRow?.content ?? content,
      createdAtMs: noteRow?.created_at_ms ?? nowMs,
      updatedAtMs: noteRow?.updated_at_ms ?? nowMs,
    };
    return { note, truncated, ...(evictedKey ? { evictedKey } : {}) };
  }

  public getNote(chatId: ChatId, key: string): SessionNote | null {
    const chatIdRaw = String(chatId);
    const k = key.trim();
    if (!k) return null;
    const row = this.stmts.selectNote.get(chatIdRaw, k) as
      | { note_key: string; content: string; created_at_ms: number; updated_at_ms: number }
      | undefined;
    if (!row) return null;
    return {
      chatId,
      key: row.note_key,
      content: row.content,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    };
  }

  public listNotes(chatId: ChatId, limit = 50): SessionNote[] {
    const chatIdRaw = String(chatId);
    const capped = Math.max(0, Math.min(200, Math.floor(limit)));
    const rows = this.stmts.selectNotesDesc.all(chatIdRaw, capped) as Array<{
      note_key: string;
      content: string;
      created_at_ms: number;
      updated_at_ms: number;
    }>;
    return rows.map((r) => ({
      chatId,
      key: r.note_key,
      content: r.content,
      createdAtMs: r.created_at_ms,
      updatedAtMs: r.updated_at_ms,
    }));
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

    if (options.onCompaction) {
      try {
        await options.onCompaction({ chatId, transcript: toSummarize, summary });
      } catch (err) {
        logger.debug('compact.onCompaction_failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

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
    selectChatIds: db.query(
      `SELECT chat_id
       FROM sessions
       ORDER BY updated_at_ms DESC
       LIMIT ?
       OFFSET ?`,
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
    upsertNote: db.query(
      `INSERT INTO session_notes (chat_id, note_key, content, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, note_key) DO UPDATE SET
         content=excluded.content,
         updated_at_ms=excluded.updated_at_ms`,
    ),
    selectNote: db.query(
      `SELECT note_key, content, created_at_ms, updated_at_ms
       FROM session_notes
       WHERE chat_id = ?
         AND note_key = ?`,
    ),
    selectNotesDesc: db.query(
      `SELECT note_key, content, created_at_ms, updated_at_ms
       FROM session_notes
       WHERE chat_id = ?
       ORDER BY updated_at_ms DESC
       LIMIT ?`,
    ),
    countNotes: db.query(
      `SELECT COUNT(*) AS c
       FROM session_notes
       WHERE chat_id = ?`,
    ),
    selectOldestNoteKey: db.query(
      `SELECT note_key
       FROM session_notes
       WHERE chat_id = ?
       ORDER BY updated_at_ms ASC
       LIMIT 1`,
    ),
    deleteNote: db.query(
      `DELETE FROM session_notes
       WHERE chat_id = ?
         AND note_key = ?`,
    ),
  } as const;
}
