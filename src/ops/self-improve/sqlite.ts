import type { Database } from 'bun:sqlite';
import crypto from 'node:crypto';

import { openSqliteStore } from '../../util/sqlite-open.js';
import type {
  SelfImproveClassification,
  SelfImproveItem,
  SelfImproveItemDraft,
  SelfImproveItemStatus,
} from './types.js';

const migrations = [
  {
    name: 'self_improve_v1',
    up: `
      CREATE TABLE IF NOT EXISTS self_improve_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL,
        classification TEXT NOT NULL,
        scope TEXT NOT NULL,
        confidence REAL NOT NULL,
        title TEXT NOT NULL,
        why TEXT NOT NULL,
        proposal TEXT NOT NULL,
        files_hint_json TEXT,
        search_terms_json TEXT,
        source_lessons_json TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        started_at_ms INTEGER,
        completed_at_ms INTEGER,
        deferred_at_ms INTEGER,
        deferred_reason TEXT,
        pr_url TEXT,
        claim_id TEXT,
        claim_until_ms INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS self_improve_items_dedupe_key ON self_improve_items(dedupe_key);
      CREATE INDEX IF NOT EXISTS self_improve_items_status ON self_improve_items(status, classification, confidence);
      CREATE INDEX IF NOT EXISTS self_improve_items_claim ON self_improve_items(claim_until_ms, claim_id);

      CREATE TABLE IF NOT EXISTS self_improve_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `,
  },
] as const;

type Row = {
  id: number;
  status: string;
  classification: string;
  scope: string;
  confidence: number;
  title: string;
  why: string;
  proposal: string;
  files_hint_json: string | null;
  search_terms_json: string | null;
  source_lessons_json: string;
  dedupe_key: string;
  created_at_ms: number;
  updated_at_ms: number;
  started_at_ms: number | null;
  completed_at_ms: number | null;
  deferred_at_ms: number | null;
  deferred_reason: string | null;
  pr_url: string | null;
  claim_id: string | null;
  claim_until_ms: number | null;
};

const nowMs = (): number => Date.now();

const normalizeForKey = (s: string): string => s.trim().toLowerCase().replace(/\s+/gu, ' ');

export const computeDedupeKey = (
  draft: Pick<SelfImproveItemDraft, 'title' | 'proposal'>,
): string => {
  const h = crypto.createHash('sha256');
  h.update(`${normalizeForKey(draft.title)}\n${normalizeForKey(draft.proposal)}`);
  return h.digest('hex');
};

const parseJsonArray = (raw: string | null): string[] | undefined => {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return undefined;
    return v.map((x) => String(x)).filter((s) => s.trim().length > 0);
  } catch (_err) {
    return undefined;
  }
};

const rowToItem = (r: Row): SelfImproveItem => {
  return {
    id: r.id,
    status: r.status as SelfImproveItemStatus,
    classification: r.classification as SelfImproveClassification,
    scope: r.scope as SelfImproveItem['scope'],
    confidence: r.confidence,
    title: r.title,
    why: r.why,
    proposal: r.proposal,
    filesHint: parseJsonArray(r.files_hint_json),
    searchTerms: parseJsonArray(r.search_terms_json),
    sourceLessons: JSON.parse(r.source_lessons_json) as SelfImproveItem['sourceLessons'],
    dedupeKey: r.dedupe_key,
    createdAtMs: r.created_at_ms,
    updatedAtMs: r.updated_at_ms,
    startedAtMs: r.started_at_ms ?? undefined,
    completedAtMs: r.completed_at_ms ?? undefined,
    deferredAtMs: r.deferred_at_ms ?? undefined,
    deferredReason: r.deferred_reason ?? undefined,
    prUrl: r.pr_url ?? undefined,
    claimId: r.claim_id ?? undefined,
    claimUntilMs: r.claim_until_ms ?? undefined,
  };
};

export interface SelfImproveSqliteStoreOptions {
  dbPath: string;
}

export class SelfImproveSqliteStore {
  private readonly db: Database;

  public constructor(opts: SelfImproveSqliteStoreOptions) {
    this.db = openSqliteStore(opts.dbPath, migrations);
  }

  public close(): void {
    this.db.close();
  }

  public getMeta(key: string): string | undefined {
    const row = this.db.query('SELECT value FROM self_improve_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  public setMeta(key: string, value: string): void {
    const t = nowMs();
    this.db
      .query(
        `
        INSERT INTO self_improve_meta (key, value, updated_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms
        `,
      )
      .run(key, value, t);
  }

  public insertDraft(
    draft: SelfImproveItemDraft,
  ): { ok: true; id: number } | { ok: false; reason: string } {
    const t = nowMs();
    const dedupeKey = computeDedupeKey(draft);
    try {
      const res = this.db
        .query(
          `
          INSERT INTO self_improve_items (
            status, classification, scope, confidence, title, why, proposal,
            files_hint_json, search_terms_json, source_lessons_json, dedupe_key,
            created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'pending',
          draft.classification,
          draft.scope,
          draft.confidence,
          draft.title,
          draft.why,
          draft.proposal,
          draft.filesHint?.length ? JSON.stringify(draft.filesHint) : null,
          draft.searchTerms?.length ? JSON.stringify(draft.searchTerms) : null,
          JSON.stringify(draft.sourceLessons),
          dedupeKey,
          t,
          t,
        );
      return { ok: true, id: Number(res.lastInsertRowid) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('unique') && msg.includes('dedupe_key')) {
        return { ok: false, reason: 'duplicate' };
      }
      return { ok: false, reason: msg };
    }
  }

  public list(opts?: {
    status?: SelfImproveItemStatus | undefined;
    limit?: number | undefined;
  }): SelfImproveItem[] {
    const status = opts?.status;
    const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? 50)));
    const rows = status
      ? (this.db
          .query(
            `
            SELECT * FROM self_improve_items
            WHERE status = ?
            ORDER BY created_at_ms DESC
            LIMIT ?
            `,
          )
          .all(status, limit) as Row[])
      : (this.db
          .query(
            `
            SELECT * FROM self_improve_items
            ORDER BY created_at_ms DESC
            LIMIT ?
            `,
          )
          .all(limit) as Row[]);
    return rows.map(rowToItem);
  }

  public claimNext(opts: {
    claimId: string;
    leaseMs: number;
    minConfidence: number;
  }): SelfImproveItem | null {
    const leaseMs = Math.max(5_000, Math.min(60 * 60_000, Math.floor(opts.leaseMs)));
    const t = nowMs();
    const until = t + leaseMs;
    const minConfidence = Math.max(0, Math.min(1, opts.minConfidence));

    const tx = this.db.transaction(() => {
      // Expire old claims first.
      this.db
        .query(
          `
          UPDATE self_improve_items
          SET claim_id = NULL, claim_until_ms = NULL, updated_at_ms = ?
          WHERE claim_until_ms IS NOT NULL AND claim_until_ms <= ?
          `,
        )
        .run(t, t);

      const row = this.db
        .query(
          `
          SELECT * FROM self_improve_items
          WHERE status = 'pending'
            AND confidence >= ?
            AND (claim_until_ms IS NULL OR claim_until_ms <= ?)
          ORDER BY
            CASE classification WHEN 'thorn' THEN 0 ELSE 1 END ASC,
            confidence DESC,
            created_at_ms DESC
          LIMIT 1
          `,
        )
        .get(minConfidence, t) as Row | undefined;

      if (!row) return null;
      const id = row.id;
      this.db
        .query(
          `
          UPDATE self_improve_items
          SET
            status = 'in_progress',
            started_at_ms = COALESCE(started_at_ms, ?),
            claim_id = ?,
            claim_until_ms = ?,
            updated_at_ms = ?
          WHERE id = ?
          `,
        )
        .run(t, opts.claimId, until, t, id);

      const updated = this.db.query('SELECT * FROM self_improve_items WHERE id = ?').get(id) as Row;
      return rowToItem(updated);
    });

    return tx.immediate();
  }

  public complete(opts: { id: number; prUrl?: string | undefined }): void {
    const t = nowMs();
    this.db
      .query(
        `
        UPDATE self_improve_items
        SET
          status = 'completed',
          completed_at_ms = ?,
          pr_url = ?,
          claim_id = NULL,
          claim_until_ms = NULL,
          updated_at_ms = ?
        WHERE id = ?
        `,
      )
      .run(t, opts.prUrl ?? null, t, opts.id);
  }

  public defer(opts: { id: number; reason: string }): void {
    const t = nowMs();
    this.db
      .query(
        `
        UPDATE self_improve_items
        SET
          status = 'deferred',
          deferred_at_ms = ?,
          deferred_reason = ?,
          claim_id = NULL,
          claim_until_ms = NULL,
          updated_at_ms = ?
        WHERE id = ?
        `,
      )
      .run(t, opts.reason.trim().slice(0, 800), t, opts.id);
  }
}
