import { z } from 'zod';
import { asFactId, asLessonId, asPersonId } from '../types/ids.js';
import {
  type ChatTrustTier,
  ChatTrustTierSchema,
  clamp01,
  type Fact,
  type FactCategory,
  type Lesson,
  type LessonType,
  type PersonRecord,
} from './types.js';

export interface FactRow {
  id: number;
  person_id: string | null;
  subject: string;
  content: string;
  category: string | null;
  evidence_quote: string | null;
  last_accessed_at_ms: number | null;
  created_at_ms: number;
}

const VALID_FACT_CATEGORIES = new Set([
  'preference',
  'personal',
  'plan',
  'professional',
  'relationship',
  'misc',
]);

export const factRowToFact = (r: FactRow): Fact => ({
  id: asFactId(r.id),
  ...(r.person_id ? { personId: asPersonId(r.person_id) } : {}),
  subject: r.subject,
  content: r.content,
  ...(r.category && VALID_FACT_CATEGORIES.has(r.category)
    ? { category: r.category as FactCategory }
    : {}),
  ...(r.evidence_quote ? { evidenceQuote: r.evidence_quote } : {}),
  ...(r.last_accessed_at_ms != null ? { lastAccessedAtMs: r.last_accessed_at_ms } : {}),
  createdAtMs: r.created_at_ms,
});

export interface LessonRow {
  id: number;
  type: string | null;
  category: string;
  content: string;
  rule: string | null;
  alternative: string | null;
  person_id: string | null;
  episode_refs: string | null;
  confidence: number | null;
  times_validated: number | null;
  times_violated: number | null;
  created_at_ms: number;
}

const VALID_LESSON_TYPES = new Set(['observation', 'failure', 'success', 'pattern']);

const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (_err) {
    return undefined;
  }
};

export const parseStringArrayJson = (raw: string): string[] | undefined => {
  const parsed = safeJsonParse(raw);
  if (!Array.isArray(parsed)) return undefined;
  const out = parsed.filter((v) => typeof v === 'string') as string[];
  return out.length ? out : undefined;
};

export const parseRecordJson = (raw: string): Record<string, string> | undefined => {
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = v;
      count++;
    }
  }
  return count > 0 ? out : undefined;
};

export const normalizeStringArrayToJson = (raw: string): string => {
  const parsed = parseStringArrayJson(raw);
  if (parsed) return JSON.stringify(parsed);
  return JSON.stringify([raw]);
};

export const lessonRowToLesson = (r: LessonRow): Lesson => ({
  id: asLessonId(r.id),
  ...(r.type && VALID_LESSON_TYPES.has(r.type) ? { type: r.type as LessonType } : {}),
  category: r.category,
  content: r.content,
  ...(r.rule ? { rule: r.rule } : {}),
  ...(r.alternative ? { alternative: r.alternative } : {}),
  ...(r.person_id ? { personId: asPersonId(r.person_id) } : {}),
  ...(r.episode_refs
    ? (() => {
        const refs = parseStringArrayJson(r.episode_refs);
        return refs ? { episodeRefs: refs } : {};
      })()
    : {}),
  ...(r.confidence != null ? { confidence: r.confidence } : {}),
  ...(r.times_validated != null ? { timesValidated: r.times_validated } : {}),
  ...(r.times_violated != null ? { timesViolated: r.times_violated } : {}),
  createdAtMs: r.created_at_ms,
});

const normalizeTrustTierOverride = (s: string | null): ChatTrustTier | undefined => {
  if (!s) return undefined;
  const parsed = ChatTrustTierSchema.safeParse(s);
  return parsed.success ? parsed.data : undefined;
};

export interface PersonRow {
  id: string;
  display_name: string;
  channel: string;
  channel_user_id: string;
  relationship_stage: string;
  relationship_score: number;
  trust_tier_override: string | null;
  capsule: string | null;
  capsule_updated_at_ms: number | null;
  public_style_capsule: string | null;
  current_concerns_json: string | null;
  goals_json: string | null;
  preferences_json: string | null;
  last_mood_signal: string | null;
  curiosity_questions_json: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export const rowToPerson = (row: PersonRow): PersonRecord => {
  const tier = normalizeTrustTierOverride(row.trust_tier_override);
  const concerns = row.current_concerns_json
    ? parseStringArrayJson(row.current_concerns_json)
    : undefined;
  const goals = row.goals_json ? parseStringArrayJson(row.goals_json) : undefined;
  const prefs = row.preferences_json ? parseRecordJson(row.preferences_json) : undefined;
  const curiosity = row.curiosity_questions_json
    ? parseStringArrayJson(row.curiosity_questions_json)
    : undefined;
  return {
    id: asPersonId(row.id),
    displayName: row.display_name,
    channel: row.channel,
    channelUserId: row.channel_user_id,
    relationshipScore:
      typeof row.relationship_score === 'number' && Number.isFinite(row.relationship_score)
        ? clamp01(row.relationship_score)
        : 0,
    ...(tier ? { trustTierOverride: tier } : {}),
    ...(row.capsule ? { capsule: row.capsule } : {}),
    ...(typeof row.capsule_updated_at_ms === 'number'
      ? { capsuleUpdatedAtMs: row.capsule_updated_at_ms }
      : {}),
    ...(row.public_style_capsule ? { publicStyleCapsule: row.public_style_capsule } : {}),
    ...(concerns ? { currentConcerns: concerns } : {}),
    ...(goals ? { goals } : {}),
    ...(prefs ? { preferences: prefs } : {}),
    ...(row.last_mood_signal ? { lastMoodSignal: row.last_mood_signal } : {}),
    ...(curiosity ? { curiosityQuestions: curiosity } : {}),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
};

export function safeFtsQueryFromText(raw: string): string | null {
  const tokens =
    raw
      .toLowerCase()
      .match(/[a-z0-9]+/gu)
      ?.filter((t) => t.length >= 2) ?? [];
  const uniq = Array.from(new Set(tokens)).slice(0, 10);
  if (uniq.length === 0) return null;
  return uniq.map((t) => `"${t}"`).join(' OR ');
}

export function parseVecDimFromSql(createSql: string | null | undefined): number | null {
  if (!createSql) return null;
  const m = createSql.match(/embedding\s+float\[(\d+)\]/u);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizeEmbedding(vec: Float32Array, dim: number): Float32Array | null {
  if (!Number.isFinite(dim) || dim <= 0) return null;
  if (vec.length === dim) return vec;

  if (vec.length < dim) {
    const padded = new Float32Array(dim);
    padded.set(vec, 0);
    return padded;
  }

  return null;
}

export const ImportPayloadSchema = z
  .object({
    people: z
      .array(
        z.object({
          id: z.string().min(1),
          display_name: z.string(),
          channel: z.string(),
          channel_user_id: z.string(),
          relationship_stage: z.string(),
          relationship_score: z.number().optional(),
          trust_tier_override: z.string().nullable().optional(),
          capsule: z.string().nullable().optional(),
          capsule_updated_at_ms: z.number().nullable().optional(),
          public_style_capsule: z.string().nullable().optional(),
          created_at_ms: z.number(),
          updated_at_ms: z.number(),
        }),
      )
      .default([]),
    facts: z
      .array(
        z.object({
          person_id: z.string().nullable().optional(),
          subject: z.string(),
          content: z.string(),
          category: z.string().nullable().optional(),
          evidence_quote: z.string().nullable().optional(),
          last_accessed_at_ms: z.number().nullable().optional(),
          created_at_ms: z.number(),
        }),
      )
      .default([]),
    episodes: z
      .array(
        z.object({
          chat_id: z.string(),
          person_id: z.string().nullable().optional(),
          is_group: z.number().nullable().optional(),
          content: z.string(),
          created_at_ms: z.number(),
        }),
      )
      .default([]),
    group_capsules: z
      .array(
        z.object({
          chat_id: z.string().min(1),
          capsule: z.string().nullable().optional(),
          updated_at_ms: z.number(),
        }),
      )
      .default([]),
    lessons: z
      .array(
        z.object({
          type: z.string().nullable().optional(),
          category: z.string(),
          content: z.string(),
          rule: z.string().nullable().optional(),
          alternative: z.string().nullable().optional(),
          person_id: z.string().nullable().optional(),
          episode_refs: z
            .union([z.string(), z.array(z.string())])
            .nullable()
            .optional(),
          confidence: z.number().nullable().optional(),
          times_validated: z.number().nullable().optional(),
          times_violated: z.number().nullable().optional(),
          created_at_ms: z.number(),
        }),
      )
      .default([]),
  })
  .strict();

export interface SqliteMemoryStoreOptions {
  dbPath: string;
  embedder?: import('./embeddings.js').Embedder | undefined;
  retrieval?: {
    rrfK?: number | undefined;
    ftsWeight?: number | undefined;
    vecWeight?: number | undefined;
    recencyWeight?: number | undefined;
    halfLifeDays?: number | undefined;
  };
}

export type RetrievalTuning = {
  rrfK: number;
  ftsWeight: number;
  vecWeight: number;
  recencyWeight: number;
  halfLifeDays: number;
};
