import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { closeSqliteBestEffort } from '../util/sqlite-close.js';
import { runSqliteMigrations } from '../util/sqlite-migrations.js';
import { emojiFeedbackScore, isNegativeEmoji } from './scoring.js';
import type { IncomingReactionEvent, IncomingReplyEvent, TrackedOutgoing } from './types.js';

const migrationV1 = `
CREATE TABLE IF NOT EXISTS outgoing_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  is_group INTEGER NOT NULL,
  sent_at_ms INTEGER NOT NULL,
  primary_channel_user_id TEXT,
  text TEXT NOT NULL,

  time_to_first_response_ms INTEGER,
  response_count INTEGER NOT NULL DEFAULT 0,
  reaction_count INTEGER NOT NULL DEFAULT 0,
  negative_reaction_count INTEGER NOT NULL DEFAULT 0,

  sample_replies_json TEXT,
  sample_reactions_json TEXT,

  finalized_at_ms INTEGER,
  score REAL,
  reasons_json TEXT,
  lesson_logged INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outgoing_ref_key ON outgoing_messages(ref_key);
CREATE INDEX IF NOT EXISTS idx_outgoing_chat_pending ON outgoing_messages(chat_id, finalized_at_ms, sent_at_ms);
`;

const migrationV2 = `
CREATE TABLE IF NOT EXISTS outgoing_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outgoing_id INTEGER NOT NULL,
  actor_id TEXT,
  text TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outgoing_replies_outgoing ON outgoing_replies(outgoing_id, created_at_ms);

CREATE TABLE IF NOT EXISTS outgoing_reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outgoing_ref_key TEXT NOT NULL,
  actor_id TEXT,
  emoji TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  removed_at_ms INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outgoing_reactions_uniq
  ON outgoing_reactions(outgoing_ref_key, actor_id, emoji);
CREATE INDEX IF NOT EXISTS idx_outgoing_reactions_active
  ON outgoing_reactions(outgoing_ref_key, removed_at_ms, created_at_ms);
`;

const migrationV3 = `
CREATE TABLE IF NOT EXISTS pending_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reply_to_ref_key TEXT NOT NULL,
  actor_id TEXT,
  text TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_replies_ref
  ON pending_replies(reply_to_ref_key, created_at_ms);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_replies_uniq
  ON pending_replies(reply_to_ref_key, actor_id, text, created_at_ms);

-- Best-effort dedupe for retries/reconnects.
-- If duplicates already exist, remove extras before adding the UNIQUE index.
DELETE FROM outgoing_replies
  WHERE id NOT IN (
    SELECT MIN(id)
      FROM outgoing_replies
      GROUP BY outgoing_id, actor_id, text, created_at_ms
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_outgoing_replies_uniq
  ON outgoing_replies(outgoing_id, actor_id, text, created_at_ms);
`;

const migrationV4 = `
ALTER TABLE outgoing_messages ADD COLUMN refinement INTEGER NOT NULL DEFAULT 0;
`;

export const FEEDBACK_MIGRATIONS: readonly string[] = [
  migrationV1,
  migrationV2,
  migrationV3,
  migrationV4,
];

const writeJsonStringArray = (arr: string[]): string => JSON.stringify(arr);

export interface SqliteFeedbackStoreOptions {
  readonly dbPath: string;
}

export interface PendingOutgoingRow {
  readonly id: number;
  readonly chat_id: string;
  readonly channel: string;
  readonly ref_key: string;
  readonly is_group: number;
  readonly sent_at_ms: number;
  readonly primary_channel_user_id: string | null;
  readonly text: string;
  readonly time_to_first_response_ms: number | null;
  readonly response_count: number;
  readonly reaction_count: number;
  readonly negative_reaction_count: number;
  readonly sample_replies_json: string | null;
  readonly sample_reactions_json: string | null;
  readonly finalized_at_ms: number | null;
  readonly score: number | null;
  readonly reasons_json: string | null;
  readonly lesson_logged: number;
}

export class SqliteFeedbackStore {
  private readonly db: Database;

  public constructor(options: SqliteFeedbackStoreOptions) {
    mkdirSync(path.dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath, { strict: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    runSqliteMigrations(this.db, FEEDBACK_MIGRATIONS);
  }

  private refreshReplyAggregates(outgoingId: number, sentAtMs: number): void {
    const rows = this.db
      .query(
        `SELECT text, created_at_ms
         FROM outgoing_replies
         WHERE outgoing_id = ?
         ORDER BY created_at_ms ASC
         LIMIT 50`,
      )
      .all(outgoingId) as Array<{ text: string; created_at_ms: number }>;

    const responseCount = rows.length;
    const first = rows[0]?.created_at_ms;
    const timeToFirst =
      typeof first === 'number' ? Math.max(0, Math.floor(first - sentAtMs)) : null;

    const samples = rows
      .map((r) => r.text.trim().slice(0, 240))
      .filter((t) => Boolean(t))
      .slice(0, 3);

    this.db
      .query(
        `UPDATE outgoing_messages
         SET time_to_first_response_ms = ?,
             response_count = ?,
             sample_replies_json = ?
         WHERE id = ?`,
      )
      .run(
        timeToFirst,
        responseCount,
        samples.length ? writeJsonStringArray(samples) : null,
        outgoingId,
      );
  }

  private refreshReactionAggregates(outgoingRefKey: string, outgoingId: number): void {
    const active = this.db
      .query(
        `SELECT emoji FROM outgoing_reactions
         WHERE outgoing_ref_key = ? AND removed_at_ms IS NULL
         ORDER BY created_at_ms DESC
         LIMIT 25`,
      )
      .all(outgoingRefKey) as Array<{ emoji: string }>;

    const emojis = active.map((r) => r.emoji).filter((e) => Boolean(e));
    const reactionCount = emojis.length;
    const negativeReactionCount = emojis.filter((e) => isNegativeEmoji(e)).length;
    const samples = emojis.slice(0, 5);
    this.db
      .query(
        `UPDATE outgoing_messages
         SET reaction_count = ?,
             negative_reaction_count = ?,
             sample_reactions_json = ?
         WHERE id = ?`,
      )
      .run(
        reactionCount,
        negativeReactionCount,
        samples.length ? writeJsonStringArray(samples) : null,
        outgoingId,
      );
  }

  private attachPendingReplies(outgoingRefKey: string, outgoingId: number): void {
    const pending = this.db
      .query(
        `SELECT id, actor_id, text, created_at_ms
         FROM pending_replies
         WHERE reply_to_ref_key = ?
         ORDER BY created_at_ms ASC
         LIMIT 50`,
      )
      .all(outgoingRefKey) as Array<{
      id: number;
      actor_id: string | null;
      text: string;
      created_at_ms: number;
    }>;
    if (pending.length === 0) return;

    for (const r of pending) {
      this.db
        .query(
          `INSERT OR IGNORE INTO outgoing_replies (outgoing_id, actor_id, text, created_at_ms)
           VALUES (?, ?, ?, ?)`,
        )
        .run(outgoingId, r.actor_id ?? null, r.text, r.created_at_ms);
    }
    this.db.query(`DELETE FROM pending_replies WHERE reply_to_ref_key = ?`).run(outgoingRefKey);
  }

  public registerOutgoing(o: TrackedOutgoing): void {
    const tx = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO outgoing_messages
           (chat_id, channel, ref_key, is_group, sent_at_ms, primary_channel_user_id, text)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(ref_key) DO UPDATE SET
             chat_id = excluded.chat_id,
             channel = excluded.channel,
             is_group = excluded.is_group,
             sent_at_ms = excluded.sent_at_ms,
             primary_channel_user_id = excluded.primary_channel_user_id,
             text = excluded.text`,
        )
        .run(
          String(o.chatId),
          o.channel,
          o.refKey,
          o.isGroup ? 1 : 0,
          o.sentAtMs,
          o.primaryChannelUserId ?? null,
          o.text,
        );

      const row = this.db
        .query(`SELECT * FROM outgoing_messages WHERE ref_key = ? LIMIT 1`)
        .get(o.refKey) as PendingOutgoingRow | undefined;
      if (!row) return;

      this.attachPendingReplies(o.refKey, row.id);
      this.refreshReplyAggregates(row.id, row.sent_at_ms);
      this.refreshReactionAggregates(o.refKey, row.id);
    });
    tx();
  }

  public recordIncomingReply(ev: IncomingReplyEvent): void {
    const tx = this.db.transaction(() => {
      const row = ev.replyToRefKey
        ? (this.db
            .query(
              `SELECT * FROM outgoing_messages
               WHERE ref_key = ? AND finalized_at_ms IS NULL
               LIMIT 1`,
            )
            .get(ev.replyToRefKey) as PendingOutgoingRow | undefined)
        : (this.db
            .query(
              `SELECT * FROM outgoing_messages
               WHERE chat_id = ? AND finalized_at_ms IS NULL
               ORDER BY sent_at_ms DESC
               LIMIT 1`,
            )
            .get(String(ev.chatId)) as PendingOutgoingRow | undefined);

      if (!row) {
        if (ev.replyToRefKey) {
          this.db
            .query(
              `INSERT OR IGNORE INTO pending_replies (reply_to_ref_key, actor_id, text, created_at_ms)
               VALUES (?, ?, ?, ?)`,
            )
            .run(ev.replyToRefKey, ev.authorId ?? null, ev.text, ev.timestampMs);
        }
        return;
      }

      this.db
        .query(
          `INSERT OR IGNORE INTO outgoing_replies (outgoing_id, actor_id, text, created_at_ms)
           VALUES (?, ?, ?, ?)`,
        )
        .run(row.id, ev.authorId ?? null, ev.text, ev.timestampMs);

      this.refreshReplyAggregates(row.id, row.sent_at_ms);
    });
    tx();
  }

  public recordIncomingReaction(ev: IncomingReactionEvent): void {
    // Track current active reactions per (actor, emoji) when possible.
    // This lets us correctly handle removals and avoid double-counting.
    if (ev.authorId) {
      if (ev.isRemove) {
        this.db
          .query(
            `INSERT INTO outgoing_reactions (outgoing_ref_key, actor_id, emoji, created_at_ms, removed_at_ms)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(outgoing_ref_key, actor_id, emoji) DO UPDATE SET
               removed_at_ms = excluded.removed_at_ms`,
          )
          .run(ev.targetRefKey, ev.authorId, ev.emoji, ev.timestampMs, ev.timestampMs);
      } else {
        this.db
          .query(
            `INSERT INTO outgoing_reactions (outgoing_ref_key, actor_id, emoji, created_at_ms, removed_at_ms)
             VALUES (?, ?, ?, ?, NULL)
             ON CONFLICT(outgoing_ref_key, actor_id, emoji) DO UPDATE SET
               created_at_ms = excluded.created_at_ms,
               removed_at_ms = NULL`,
          )
          .run(ev.targetRefKey, ev.authorId, ev.emoji, ev.timestampMs);
      }
    } else {
      // Without an actor_id we can't reconcile add/remove pairs reliably. Keep a raw log.
      this.db
        .query(
          `INSERT INTO outgoing_reactions (outgoing_ref_key, actor_id, emoji, created_at_ms, removed_at_ms)
           VALUES (?, NULL, ?, ?, ?)`,
        )
        .run(ev.targetRefKey, ev.emoji, ev.timestampMs, ev.isRemove ? ev.timestampMs : null);
    }

    const row = this.db
      .query(`SELECT * FROM outgoing_messages WHERE ref_key = ? LIMIT 1`)
      .get(ev.targetRefKey) as PendingOutgoingRow | undefined;
    if (!row) return;

    // Refresh aggregates for status dashboards and fast finalization.
    this.refreshReactionAggregates(ev.targetRefKey, row.id);
  }

  public listDueFinalizations(nowMs: number, finalizeAfterMs: number): PendingOutgoingRow[] {
    const cutoff = nowMs - finalizeAfterMs;
    return this.db
      .query(
        `SELECT * FROM outgoing_messages
         WHERE finalized_at_ms IS NULL AND sent_at_ms <= ?
         ORDER BY sent_at_ms ASC
         LIMIT 100`,
      )
      .all(cutoff) as PendingOutgoingRow[];
  }

  public finalize(id: number, nowMs: number, result: { score: number; reasons: string[] }): void {
    this.db
      .query(
        `UPDATE outgoing_messages
         SET finalized_at_ms = ?,
             score = ?,
             reasons_json = ?
         WHERE id = ?`,
      )
      .run(nowMs, result.score, JSON.stringify(result.reasons), id);
  }

  public markLessonLogged(id: number): void {
    this.db.query(`UPDATE outgoing_messages SET lesson_logged = 1 WHERE id = ?`).run(id);
  }

  public markRefinement(refKey: string): void {
    this.db
      .query(`UPDATE outgoing_messages SET refinement = 1 WHERE ref_key = ? AND finalized_at_ms IS NULL`)
      .run(refKey);
  }

  public getReplySignals(
    outgoingId: number,
    sentAtMs: number,
  ): {
    timeToFirstResponseMs?: number | undefined;
    responseCount: number;
    samples: string[];
  } {
    const rows = this.db
      .query(
        `SELECT text, created_at_ms
         FROM outgoing_replies
         WHERE outgoing_id = ?
         ORDER BY created_at_ms ASC
         LIMIT 50`,
      )
      .all(outgoingId) as Array<{ text: string; created_at_ms: number }>;

    if (rows.length === 0) return { responseCount: 0, samples: [] };
    const first = rows[0]?.created_at_ms;
    const timeToFirstResponseMs =
      typeof first === 'number' ? Math.max(0, first - sentAtMs) : undefined;
    const samples = rows
      .map((r) =>
        String(r.text ?? '')
          .trim()
          .slice(0, 240),
      )
      .filter((t) => Boolean(t))
      .slice(0, 3);
    return { timeToFirstResponseMs, responseCount: rows.length, samples };
  }

  public getReactionSignals(
    refKey: string,
    nowMs: number,
  ): {
    reactionCount: number;
    negativeReactionCount: number;
    reactionNetScore: number;
    samples: string[];
  } {
    const rows = this.db
      .query(
        `SELECT emoji, created_at_ms
         FROM outgoing_reactions
         WHERE outgoing_ref_key = ? AND removed_at_ms IS NULL
         ORDER BY created_at_ms DESC
         LIMIT 50`,
      )
      .all(refKey) as Array<{ emoji: string; created_at_ms: number }>;

    const emojis = rows.map((r) => r.emoji).filter((e) => Boolean(e));
    const negativeReactionCount = emojis.filter((e) => isNegativeEmoji(e)).length;

    // Decay old reactions: they still matter, but less.
    const halfLifeMs = 7 * 24 * 60 * 60_000;
    const ln2 = Math.log(2);
    let net = 0;
    for (const r of rows) {
      const score = emojiFeedbackScore(r.emoji);
      if (!score) continue;
      const ageMs = Math.max(0, nowMs - r.created_at_ms);
      const w = Math.exp((-ln2 * ageMs) / halfLifeMs);
      net += score * w;
    }

    return {
      reactionCount: emojis.length,
      negativeReactionCount,
      reactionNetScore: Math.max(-1, Math.min(1, net)),
      samples: emojis.slice(0, 5),
    };
  }

  public getStats(): { total: number; pending: number } {
    const totalRow = this.db.query(`SELECT COUNT(*) as c FROM outgoing_messages`).get() as
      | { c: number }
      | undefined;
    const pendingRow = this.db
      .query(`SELECT COUNT(*) as c FROM outgoing_messages WHERE finalized_at_ms IS NULL`)
      .get() as { c: number } | undefined;
    return { total: totalRow?.c ?? 0, pending: pendingRow?.c ?? 0 };
  }

  public ping(): void {
    this.db.query('SELECT 1').get();
  }

  public close(): void {
    closeSqliteBestEffort(this.db, 'sqlite_feedback');
  }
}
