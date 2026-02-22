import type { Database } from 'bun:sqlite';
import type { ChatId, PersonId } from '../types/ids.js';
import { closeSqliteBestEffort } from '../util/sqlite-close.js';
import { openSqliteStore } from '../util/sqlite-open.js';

export type OutboundMessageType = 'reactive' | 'proactive';

export interface OutboundLedgerRow {
  readonly id: number;
  readonly chatId: ChatId;
  readonly personId?: PersonId | undefined;
  readonly contentPreview: string;
  readonly messageType: OutboundMessageType;
  readonly sentAtMs: number;
  readonly gotReply: boolean;
}

const schemaSql = `
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

const preview = (s: string): string => {
  const oneLine = s.replace(/\s*\n+\s*/gu, ' ').trim();
  if (oneLine.length <= 120) return oneLine;
  return `${oneLine.slice(0, 120).trim()}…`;
};

export class SqliteOutboundLedger implements OutboundLedger {
  private readonly db: Database;
  private readonly stmts: ReturnType<typeof createStatements>;

  public constructor(options: { dbPath: string }) {
    this.db = openSqliteStore(options.dbPath, [schemaSql]);
    this.stmts = createStatements(this.db);
  }

  public ping(): void {
    this.db.query('SELECT 1').get();
  }

  public close(): void {
    closeSqliteBestEffort(this.db, 'sqlite_outbound_ledger');
  }

  public recordSend(opts: {
    chatId: ChatId;
    personId?: PersonId | undefined;
    text: string;
    messageType: OutboundMessageType;
    sentAtMs: number;
  }): void {
    const chatId = String(opts.chatId);
    const tx = this.db.transaction(() => {
      this.stmts.insert.run(
        chatId,
        opts.personId ? String(opts.personId) : null,
        preview(opts.text),
        opts.messageType,
        opts.sentAtMs,
      );
      // Keep only the most recent 10 per chat.
      this.stmts.prune.run(chatId, chatId, 10);
    });
    tx();
  }

  public markGotReply(opts: { chatId: ChatId; atMs: number }): void {
    const chatId = String(opts.chatId);
    // Mark the newest outstanding send as replied.
    this.stmts.markGotReply.run(chatId, opts.atMs);
  }

  public listRecent(chatId: ChatId, limit = 10): OutboundLedgerRow[] {
    const rows = this.stmts.listRecent.all(
      String(chatId),
      Math.max(0, Math.floor(limit)),
    ) as Array<{
      id: number;
      chat_id: string;
      person_id: string | null;
      content_preview: string;
      message_type: string;
      sent_at_ms: number;
      got_reply: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      chatId: r.chat_id as unknown as ChatId,
      personId: (r.person_id ?? undefined) as unknown as PersonId | undefined,
      contentPreview: r.content_preview,
      messageType: (r.message_type === 'proactive'
        ? 'proactive'
        : 'reactive') as OutboundMessageType,
      sentAtMs: r.sent_at_ms,
      gotReply: r.got_reply === 1,
    }));
  }
}

export interface OutboundLedger {
  ping(): void;
  close(): void;
  recordSend(opts: {
    chatId: ChatId;
    personId?: PersonId | undefined;
    text: string;
    messageType: OutboundMessageType;
    sentAtMs: number;
  }): void;
  markGotReply(opts: { chatId: ChatId; atMs: number }): void;
  listRecent(chatId: ChatId, limit?: number): OutboundLedgerRow[];
}

function createStatements(db: Database) {
  return {
    insert: db.query(
      `INSERT INTO outbound_ledger (
        chat_id, person_id, content_preview, message_type, sent_at_ms, got_reply
      ) VALUES (?, ?, ?, ?, ?, 0)`,
    ),
    prune: db.query(
      `DELETE FROM outbound_ledger
       WHERE chat_id = ?
         AND id NOT IN (
           SELECT id FROM outbound_ledger
           WHERE chat_id = ?
           ORDER BY sent_at_ms DESC, id DESC
           LIMIT ?
         )`,
    ),
    markGotReply: db.query(
      `UPDATE outbound_ledger
       SET got_reply = 1
       WHERE id = (
         SELECT id FROM outbound_ledger
         WHERE chat_id = ? AND got_reply = 0 AND sent_at_ms <= ?
         ORDER BY sent_at_ms DESC, id DESC
         LIMIT 1
       )`,
    ),
    listRecent: db.query(
      `SELECT id, chat_id, person_id, content_preview, message_type, sent_at_ms, got_reply
       FROM outbound_ledger
       WHERE chat_id = ?
       ORDER BY sent_at_ms DESC, id DESC
       LIMIT ?`,
    ),
  } as const;
}
