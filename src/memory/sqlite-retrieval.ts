import type { Database } from 'bun:sqlite';
import type { ChatId } from '../types/ids.js';
import { asEpisodeId } from '../types/ids.js';
import type { Embedder } from './embeddings.js';
import type { MemoryStatements } from './sqlite-statements.js';
import {
  type FactRow,
  factRowToFact,
  normalizeEmbedding,
  type RetrievalTuning,
  safeFtsQueryFromText,
} from './sqlite-types.js';
import type { Episode, Fact } from './types.js';

export interface RetrievalContext {
  db: Database;
  stmts: MemoryStatements;
  embedder: Embedder | undefined;
  vecEnabled: boolean;
  vecDim: number | undefined;
  retrieval: RetrievalTuning;
}

export function searchFactsFts(ctx: RetrievalContext, query: string, limit = 20): Fact[] {
  const safe = safeFtsQueryFromText(query);
  if (!safe) return [];
  const fetchLimit = Math.min(200, Math.max(limit, limit * 5));
  const rows = ctx.stmts.searchFactsFts.all(safe, fetchLimit) as FactRow[];
  const nowMs = Date.now();
  const halfLifeMs = ctx.retrieval.halfLifeDays * 24 * 60 * 60_000;
  const ln2 = Math.log(2);
  const weighted = rows
    .map((r, idx) => {
      const base = ctx.retrieval.ftsWeight * (1 / (ctx.retrieval.rrfK + (idx + 1)));
      const t = r.last_accessed_at_ms ?? r.created_at_ms;
      const ageMs = Math.max(0, nowMs - t);
      const recency = Math.exp((-ln2 * ageMs) / halfLifeMs);
      const confidenceBoost =
        r.confidence_tier === 'high' ? 0.04 : r.confidence_tier === 'low' ? -0.04 : 0;
      const score = base * (1 + ctx.retrieval.recencyWeight * recency) * (1 + confidenceBoost);
      return { r, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.r);
  return weighted.map(factRowToFact);
}

export async function hybridSearchFacts(
  ctx: RetrievalContext,
  query: string,
  limit = 20,
): Promise<Fact[]> {
  if (!ctx.embedder || !ctx.vecEnabled || !ctx.vecDim) {
    return searchFactsFts(ctx, query, limit);
  }

  const queryVec = await ctx.embedder.embed(query);
  const normalized = normalizeEmbedding(queryVec, ctx.vecDim);
  if (!normalized) return searchFactsFts(ctx, query, limit);

  const safe = safeFtsQueryFromText(query);
  if (!safe) {
    const fetchLimit = Math.min(200, Math.max(limit, limit * 5));
    const rows = ctx.db
      .query(
        `SELECT f.id, f.person_id, f.subject, f.content, f.category, f.fact_type, f.temporal_scope,
                f.evidence_quote, f.confidence_tier, f.is_current, f.last_accessed_at_ms, f.created_at_ms
         FROM facts_vec v
         JOIN facts f ON f.id = v.fact_id
         WHERE v.embedding MATCH ? AND k = ? AND f.is_current = 1
         ORDER BY distance
         LIMIT ?`,
      )
      .all(normalized, fetchLimit, fetchLimit) as FactRow[];

    const nowMs = Date.now();
    const halfLifeMs = ctx.retrieval.halfLifeDays * 24 * 60 * 60_000;
    const ln2 = Math.log(2);
    const weighted = rows
      .map((r, idx) => {
        const base = ctx.retrieval.vecWeight * (1 / (ctx.retrieval.rrfK + (idx + 1)));
        const t = r.last_accessed_at_ms ?? r.created_at_ms;
        const ageMs = Math.max(0, nowMs - t);
        const recency = Math.exp((-ln2 * ageMs) / halfLifeMs);
        const confidenceBoost =
          r.confidence_tier === 'high' ? 0.04 : r.confidence_tier === 'low' ? -0.04 : 0;
        const score = base * (1 + ctx.retrieval.recencyWeight * recency) * (1 + confidenceBoost);
        return { r, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.r);
    return weighted.map(factRowToFact);
  }

  const fetchLimit = Math.min(200, Math.max(limit, limit * 5));
  const rows = ctx.db
    .query(
      `WITH vec_matches AS (
        SELECT fact_id AS id, row_number() OVER (ORDER BY distance) AS rank_num
        FROM facts_vec WHERE embedding MATCH ? AND k = ?
      ),
      fts_matches AS (
        SELECT fact_id AS id, row_number() OVER (ORDER BY rank) AS rank_num
        FROM facts_fts WHERE facts_fts MATCH ? LIMIT ?
      ),
      all_ids AS (
        SELECT id FROM vec_matches
        UNION
        SELECT id FROM fts_matches
      ),
      scored AS (
        SELECT
          a.id,
          (coalesce(? * 1.0 / (? + f.rank_num), 0.0) + coalesce(? * 1.0 / (? + v.rank_num), 0.0)) AS rrf_score
        FROM all_ids a
        LEFT JOIN fts_matches f ON f.id = a.id
        LEFT JOIN vec_matches v ON v.id = a.id
      )
      SELECT f.id, f.person_id, f.subject, f.content, f.category,
             f.fact_type, f.temporal_scope, f.evidence_quote, f.confidence_tier, f.is_current,
             f.last_accessed_at_ms, f.created_at_ms,
             s.rrf_score
      FROM scored s
      JOIN facts f ON f.id = s.id
      WHERE f.is_current = 1
      ORDER BY s.rrf_score DESC
      LIMIT ?`,
    )
    .all(
      normalized,
      fetchLimit,
      safe,
      fetchLimit,
      ctx.retrieval.ftsWeight,
      ctx.retrieval.rrfK,
      ctx.retrieval.vecWeight,
      ctx.retrieval.rrfK,
      fetchLimit,
    ) as Array<FactRow & { rrf_score: number }>;

  const nowMs = Date.now();
  const halfLifeMs = ctx.retrieval.halfLifeDays * 24 * 60 * 60_000;
  const ln2 = Math.log(2);
  const weighted = rows
    .map((r, idx) => {
      const base = Number.isFinite(r.rrf_score)
        ? r.rrf_score
        : 1 / (ctx.retrieval.rrfK + (idx + 1));
      const t = r.last_accessed_at_ms ?? r.created_at_ms;
      const ageMs = Math.max(0, nowMs - t);
      const recency = Math.exp((-ln2 * ageMs) / halfLifeMs);
      const confidenceBoost =
        r.confidence_tier === 'high' ? 0.04 : r.confidence_tier === 'low' ? -0.04 : 0;
      const score = base * (1 + ctx.retrieval.recencyWeight * recency) * (1 + confidenceBoost);
      return { r, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.r);

  return weighted.map(factRowToFact);
}

export function searchEpisodesFts(ctx: RetrievalContext, query: string, limit = 20): Episode[] {
  const safe = safeFtsQueryFromText(query);
  if (!safe) return [];

  const fetchLimit = Math.min(200, Math.max(limit, limit * 5));
  const rows = ctx.stmts.searchEpisodesFts.all(safe, fetchLimit) as Array<{
    id: number;
    chat_id: string;
    content: string;
    created_at_ms: number;
  }>;

  const nowMs = Date.now();
  const halfLifeMs = ctx.retrieval.halfLifeDays * 24 * 60 * 60_000;
  const ln2 = Math.log(2);
  const weighted = rows
    .map((r, idx) => {
      const base = ctx.retrieval.ftsWeight * (1 / (ctx.retrieval.rrfK + (idx + 1)));
      const ageMs = Math.max(0, nowMs - r.created_at_ms);
      const recency = Math.exp((-ln2 * ageMs) / halfLifeMs);
      const score = base * (1 + ctx.retrieval.recencyWeight * recency);
      return { r, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.r);

  return weighted.map((r) => ({
    id: asEpisodeId(r.id),
    chatId: r.chat_id as unknown as ChatId,
    content: r.content,
    createdAtMs: r.created_at_ms,
  }));
}

export async function hybridSearchEpisodes(
  ctx: RetrievalContext,
  query: string,
  limit = 20,
): Promise<Episode[]> {
  if (!ctx.embedder || !ctx.vecEnabled || !ctx.vecDim) {
    return searchEpisodesFts(ctx, query, limit);
  }

  const queryVec = await ctx.embedder.embed(query);
  const normalized = normalizeEmbedding(queryVec, ctx.vecDim);
  if (!normalized) return searchEpisodesFts(ctx, query, limit);

  const safe = safeFtsQueryFromText(query);
  if (!safe) {
    const fetchLimit = Math.min(200, Math.max(limit, limit * 5));
    const rows = ctx.db
      .query(
        `SELECT e.id, e.chat_id, e.content, e.created_at_ms
         FROM episodes_vec v
         JOIN episodes e ON e.id = v.episode_id
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY distance
         LIMIT ?`,
      )
      .all(normalized, fetchLimit, fetchLimit) as Array<{
      id: number;
      chat_id: string;
      content: string;
      created_at_ms: number;
    }>;

    const nowMs = Date.now();
    const halfLifeMs = ctx.retrieval.halfLifeDays * 24 * 60 * 60_000;
    const ln2 = Math.log(2);
    const weighted = rows
      .map((r, idx) => {
        const base = ctx.retrieval.vecWeight * (1 / (ctx.retrieval.rrfK + (idx + 1)));
        const ageMs = Math.max(0, nowMs - r.created_at_ms);
        const recency = Math.exp((-ln2 * ageMs) / halfLifeMs);
        const score = base * (1 + ctx.retrieval.recencyWeight * recency);
        return { r, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.r);

    return weighted.map((r) => ({
      id: asEpisodeId(r.id),
      chatId: r.chat_id as unknown as ChatId,
      content: r.content,
      createdAtMs: r.created_at_ms,
    }));
  }

  const fetchLimit = Math.min(200, Math.max(limit, limit * 5));
  const rows = ctx.db
    .query(
      `WITH vec_matches AS (
        SELECT episode_id AS id, row_number() OVER (ORDER BY distance) AS rank_num
        FROM episodes_vec WHERE embedding MATCH ? AND k = ?
      ),
      fts_matches AS (
        SELECT episode_id AS id, row_number() OVER (ORDER BY rank) AS rank_num
        FROM episodes_fts WHERE episodes_fts MATCH ? LIMIT ?
      ),
      all_ids AS (
        SELECT id FROM vec_matches
        UNION
        SELECT id FROM fts_matches
      ),
      scored AS (
        SELECT
          a.id,
          (coalesce(? * 1.0 / (? + f.rank_num), 0.0) + coalesce(? * 1.0 / (? + v.rank_num), 0.0)) AS rrf_score
        FROM all_ids a
        LEFT JOIN fts_matches f ON f.id = a.id
        LEFT JOIN vec_matches v ON v.id = a.id
      )
      SELECT e.id, e.chat_id, e.content, e.created_at_ms,
             s.rrf_score
      FROM scored s
      JOIN episodes e ON e.id = s.id
      ORDER BY s.rrf_score DESC
      LIMIT ?`,
    )
    .all(
      normalized,
      fetchLimit,
      safe,
      fetchLimit,
      ctx.retrieval.ftsWeight,
      ctx.retrieval.rrfK,
      ctx.retrieval.vecWeight,
      ctx.retrieval.rrfK,
      fetchLimit,
    ) as Array<{
    id: number;
    chat_id: string;
    content: string;
    created_at_ms: number;
    rrf_score: number;
  }>;

  const nowMs = Date.now();
  const halfLifeMs = ctx.retrieval.halfLifeDays * 24 * 60 * 60_000;
  const ln2 = Math.log(2);
  const weighted = rows
    .map((r, idx) => {
      const base = Number.isFinite(r.rrf_score)
        ? r.rrf_score
        : 1 / (ctx.retrieval.rrfK + (idx + 1));
      const ageMs = Math.max(0, nowMs - r.created_at_ms);
      const recency = Math.exp((-ln2 * ageMs) / halfLifeMs);
      const score = base * (1 + ctx.retrieval.recencyWeight * recency);
      return { r, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.r);

  return weighted.map((r) => ({
    id: asEpisodeId(r.id),
    chatId: r.chat_id as unknown as ChatId,
    content: r.content,
    createdAtMs: r.created_at_ms,
  }));
}
