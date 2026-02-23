import { errorFields, log } from '../util/logger.js';
import type { InterviewModelClient, InterviewUsage } from './contracts.js';
import {
  buildEnrichmentQueries,
  formatEnrichmentForPrompt,
  runEnrichmentSearches,
} from './enrich.js';
import { extractJsonObject } from './json.js';
import {
  getGenerateIdentityPrompts,
  getInterviewPrompts,
  getRefineIdentityPrompts,
} from './prompts.js';
import { type IdentityDraft, IdentitySchema, interviewQuestionSchema } from './schemas.js';

const MAX_PARSE_RETRIES = 2;
const logger = log.child({ component: 'interview_conductor' });

type UsageCallback = ((usage: InterviewUsage) => void) | undefined;

const completeStructured = async <T>(params: {
  client: InterviewModelClient;
  role: 'fast' | 'default';
  system: string;
  user: string;
  schema: unknown;
  onReasoningDelta?: ((delta: string) => void) | undefined;
  onUsage?: UsageCallback;
}): Promise<T> => {
  if (params.client.completeObject) {
    return await params.client.completeObject<T>({
      role: params.role,
      system: params.system,
      user: params.user,
      schema: params.schema,
      ...(params.onReasoningDelta ? { onReasoningDelta: params.onReasoningDelta } : {}),
      ...(params.onUsage ? { onUsage: params.onUsage } : {}),
    });
  }
  const text = await params.client.complete({
    role: params.role,
    system: params.system,
    user: params.user,
    ...(params.onReasoningDelta ? { onReasoningDelta: params.onReasoningDelta } : {}),
    ...(params.onUsage ? { onUsage: params.onUsage } : {}),
  });
  return extractJsonObject(text) as T;
};

export const nextInterviewQuestion = async (
  client: InterviewModelClient,
  params: {
    friendName: string;
    questionsAsked: number;
    transcript: string;
    operatorContext?: string | undefined;
    onReasoningDelta?: ((delta: string) => void) | undefined;
    onUsage?: UsageCallback;
  },
): Promise<{ done: boolean; question: string }> => {
  const { system, user } = getInterviewPrompts(params);
  let lastError: Error = new Error('No parse attempts completed');
  for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt += 1) {
    try {
      const raw = await completeStructured<unknown>({
        client,
        role: 'fast',
        system,
        user,
        schema: interviewQuestionSchema,
        ...(params.onReasoningDelta ? { onReasoningDelta: params.onReasoningDelta } : {}),
        ...(params.onUsage ? { onUsage: params.onUsage } : {}),
      });
      const parsed = interviewQuestionSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      lastError = new Error(
        `Interview model returned invalid JSON (attempt ${attempt + 1}/${MAX_PARSE_RETRIES + 1}): ${parsed.error.message}`,
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError;
};

export const generateIdentity = async (
  client: InterviewModelClient,
  params: {
    friendName: string;
    timezone: string;
    transcript: string;
    operatorContext?: string | undefined;
    onReasoningDelta?: ((delta: string) => void) | undefined;
    onUsage?: UsageCallback;
    onProgress?: ((msg: string) => void) | undefined;
  },
): Promise<IdentityDraft> => {
  interface EnrichEnv extends NodeJS.ProcessEnv {
    BRAVE_API_KEY?: string;
  }
  const braveKey = (process.env as EnrichEnv).BRAVE_API_KEY?.trim();
  let webResearch: string | undefined;
  if (braveKey) {
    try {
      const queries = buildEnrichmentQueries({
        friendName: params.friendName,
        transcript: params.transcript,
        operatorContext: params.operatorContext,
      });
      if (queries.length > 0) {
        const enrichment = await runEnrichmentSearches(queries, braveKey, params.onProgress);
        const formatted = formatEnrichmentForPrompt(enrichment);
        if (formatted) webResearch = formatted;
      }
    } catch (err) {
      // Web enrichment is best-effort; proceed without it.
      logger.debug('generateIdentity.enrichment_failed', errorFields(err));
    }
  }
  const { system, user } = getGenerateIdentityPrompts({ ...params, webResearch });
  let lastError: Error = new Error('No parse attempts completed');
  for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt += 1) {
    try {
      const raw = await completeStructured<unknown>({
        client,
        role: 'default',
        system,
        user,
        schema: IdentitySchema,
        ...(params.onReasoningDelta ? { onReasoningDelta: params.onReasoningDelta } : {}),
        ...(params.onUsage ? { onUsage: params.onUsage } : {}),
      });
      const parsed = IdentitySchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      lastError = new Error(
        `Identity generation returned invalid JSON (attempt ${attempt + 1}/${MAX_PARSE_RETRIES + 1}): ${parsed.error.message}`,
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError;
};

export const refineIdentity = async (
  client: InterviewModelClient,
  params: {
    feedback: string;
    currentIdentity: IdentityDraft;
    onReasoningDelta?: ((delta: string) => void) | undefined;
    onUsage?: UsageCallback;
  },
): Promise<IdentityDraft> => {
  const { system, user } = getRefineIdentityPrompts({
    feedback: params.feedback,
    currentIdentityJSON: JSON.stringify(params.currentIdentity),
  });
  let lastError: Error = new Error('No parse attempts completed');
  for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt += 1) {
    try {
      const raw = await completeStructured<unknown>({
        client,
        role: 'default',
        system,
        user,
        schema: IdentitySchema,
        ...(params.onReasoningDelta ? { onReasoningDelta: params.onReasoningDelta } : {}),
        ...(params.onUsage ? { onUsage: params.onUsage } : {}),
      });
      const parsed = IdentitySchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      lastError = new Error(
        `Identity refinement returned invalid JSON (attempt ${attempt + 1}/${MAX_PARSE_RETRIES + 1}): ${parsed.error.message}`,
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError;
};
