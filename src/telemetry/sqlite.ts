import type { Database } from 'bun:sqlite';

import { errorFields, log } from '../util/logger.js';
import { openSqliteStore } from '../util/sqlite-open.js';
import type {
  SlopTelemetryEvent,
  TelemetryStore,
  TurnTelemetryEvent,
  UsageSummary,
} from './types.js';

const schemaSql = `
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  channel TEXT,
  chat_id TEXT NOT NULL,
  message_id TEXT,
  proactive_kind TEXT,
  proactive_event_id INTEGER,
  started_at_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  llm_calls INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turns_started_at_ms ON turns(started_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_turns_chat_id_started_at_ms ON turns(chat_id, started_at_ms DESC);
`;

const llmCallsSql = `
CREATE TABLE IF NOT EXISTS llm_calls (
  id TEXT PRIMARY KEY,
  correlation_id TEXT,
  caller TEXT NOT NULL,
  role TEXT NOT NULL,
  model_id TEXT,
  started_at_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  err_name TEXT,
  err_msg TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_calls_started_at_ms ON llm_calls(started_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_llm_calls_correlation_id ON llm_calls(correlation_id);
`;

const slopSql = `
CREATE TABLE IF NOT EXISTS slop_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  is_group INTEGER NOT NULL,
  action TEXT NOT NULL,
  score REAL NOT NULL,
  categories_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_slop_events_created_at_ms ON slop_events(created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_slop_events_chat_id_created_at_ms
  ON slop_events(chat_id, created_at_ms DESC);
`;

export class SqliteTelemetryStore implements TelemetryStore {
  private readonly logger = log.child({ component: 'telemetry' });
  private readonly db: Database;
  private readonly stmts: ReturnType<typeof createStatements>;

  public constructor(options: { dbPath: string }) {
    this.db = openSqliteStore(options.dbPath, [schemaSql, llmCallsSql, slopSql]);
    this.stmts = createStatements(this.db);
  }

  public ping(): void {
    this.db.query('SELECT 1').get();
  }

  public close(): void {
    try {
      // If we're in WAL mode, checkpointing avoids some Bun/SQLite close edge cases.
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      this.db.close(false);
    } catch (err) {
      // Telemetry should never make shutdown fail.
      this.logger.debug('close.failed', errorFields(err));
      try {
        this.db.close(true);
      } catch (err2) {
        this.logger.debug('close.force_failed', errorFields(err2));
      }
    }
  }

  public logTurn(event: TurnTelemetryEvent): void {
    try {
      this.stmts.insertTurn.run(
        event.id,
        event.kind,
        event.channel ?? null,
        event.chatId,
        event.messageId ?? null,
        event.proactiveKind ?? null,
        event.proactiveEventId ?? null,
        event.startedAtMs,
        event.durationMs,
        event.action,
        event.reason ?? null,
        event.llmCalls,
        event.usage.inputTokens,
        event.usage.outputTokens,
        event.usage.cacheReadTokens,
        event.usage.cacheWriteTokens,
        event.usage.reasoningTokens,
      );
    } catch (err) {
      // Never fail turns due to telemetry IO.
      this.logger.debug('logTurn.failed', errorFields(err));
    }
  }

  public logSlop(event: SlopTelemetryEvent): void {
    try {
      this.stmts.insertSlop.run(
        event.chatId,
        event.createdAtMs,
        event.isGroup ? 1 : 0,
        event.action,
        event.score,
        JSON.stringify(event.categories),
      );
    } catch (err) {
      this.logger.debug('logSlop.failed', errorFields(err));
    }
  }

  public logLlmCall(event: {
    id: string;
    correlationId?: string | undefined;
    caller: string;
    role: string;
    modelId?: string | undefined;
    startedAtMs: number;
    durationMs: number;
    ok: boolean;
    errName?: string | undefined;
    errMsg?: string | undefined;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  }): void {
    try {
      this.stmts.insertLlmCall.run(
        event.id,
        event.correlationId ?? null,
        event.caller,
        event.role,
        event.modelId ?? null,
        event.startedAtMs,
        event.durationMs,
        event.ok ? 1 : 0,
        event.errName ?? null,
        event.errMsg ?? null,
        event.inputTokens,
        event.outputTokens,
        event.cacheReadTokens,
        event.cacheWriteTokens,
        event.reasoningTokens,
      );
    } catch (err) {
      this.logger.debug('logLlmCall.failed', errorFields(err));
    }
  }

  public getUsageSummary(windowMs: number): UsageSummary {
    const safeWindow = Math.max(1, Math.floor(windowMs));
    const since = Date.now() - safeWindow;
    const row = this.stmts.sumSince.get(since) as
      | {
          turns: number;
          llm_calls: number;
          input_tokens: number;
          output_tokens: number;
          cache_read_tokens: number;
          cache_write_tokens: number;
          reasoning_tokens: number;
        }
      | undefined;
    return {
      windowMs: safeWindow,
      turns: row?.turns ?? 0,
      llmCalls: row?.llm_calls ?? 0,
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      cacheReadTokens: row?.cache_read_tokens ?? 0,
      cacheWriteTokens: row?.cache_write_tokens ?? 0,
      reasoningTokens: row?.reasoning_tokens ?? 0,
    };
  }

  public getLlmUsageSummary(windowMs: number): UsageSummary {
    const safeWindow = Math.max(1, Math.floor(windowMs));
    const since = Date.now() - safeWindow;
    const row = this.stmts.sumLlmSince.get(since) as
      | {
          calls: number;
          input_tokens: number;
          output_tokens: number;
          cache_read_tokens: number;
          cache_write_tokens: number;
          reasoning_tokens: number;
        }
      | undefined;
    return {
      windowMs: safeWindow,
      turns: 0,
      llmCalls: row?.calls ?? 0,
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      cacheReadTokens: row?.cache_read_tokens ?? 0,
      cacheWriteTokens: row?.cache_write_tokens ?? 0,
      reasoningTokens: row?.reasoning_tokens ?? 0,
    };
  }
}

function createStatements(db: Database) {
  return {
    insertTurn: db.query(
      `INSERT OR REPLACE INTO turns (
        id, kind, channel, chat_id, message_id, proactive_kind, proactive_event_id,
        started_at_ms, duration_ms, action, reason, llm_calls,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    sumSince: db.query(
      `SELECT
        COUNT(*) as turns,
        COALESCE(SUM(llm_calls), 0) as llm_calls,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
        COALESCE(SUM(reasoning_tokens), 0) as reasoning_tokens
       FROM turns
       WHERE started_at_ms >= ?`,
    ),
    insertLlmCall: db.query(
      `INSERT OR REPLACE INTO llm_calls (
        id, correlation_id, caller, role, model_id, started_at_ms, duration_ms, ok, err_name, err_msg,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    sumLlmSince: db.query(
      `SELECT
        COUNT(*) as calls,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
        COALESCE(SUM(reasoning_tokens), 0) as reasoning_tokens
       FROM llm_calls
       WHERE started_at_ms >= ?`,
    ),
    insertSlop: db.query(
      `INSERT INTO slop_events (chat_id, created_at_ms, is_group, action, score, categories_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
  } as const;
}
