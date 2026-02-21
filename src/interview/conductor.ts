import type { InterviewModelClient } from './contracts.js';
import { extractJsonObject } from './json.js';
import {
  getGenerateIdentityPrompts,
  getInterviewPrompts,
  getRefineIdentityPrompts,
} from './prompts.js';
import { type IdentityDraft, IdentitySchema, interviewQuestionSchema } from './schemas.js';

const MAX_PARSE_RETRIES = 2;

export const nextInterviewQuestion = async (
  client: InterviewModelClient,
  params: {
    friendName: string;
    questionsAsked: number;
    transcript: string;
    onReasoningDelta?: ((delta: string) => void) | undefined;
  },
): Promise<{ done: boolean; question: string }> => {
  const { system, user } = getInterviewPrompts(params);
  let lastError: Error = new Error('No parse attempts completed');
  for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt += 1) {
    const text = await client.complete({
      role: 'fast',
      system,
      user,
      ...(params.onReasoningDelta ? { onReasoningDelta: params.onReasoningDelta } : {}),
    });
    try {
      const raw = extractJsonObject(text);
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
    onReasoningDelta?: ((delta: string) => void) | undefined;
  },
): Promise<IdentityDraft> => {
  const { system, user } = getGenerateIdentityPrompts(params);
  let lastError: Error = new Error('No parse attempts completed');
  for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt += 1) {
    const text = await client.complete({
      role: 'default',
      system,
      user,
      ...(params.onReasoningDelta ? { onReasoningDelta: params.onReasoningDelta } : {}),
    });
    try {
      const parsed = IdentitySchema.safeParse(extractJsonObject(text));
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
  },
): Promise<IdentityDraft> => {
  const { system, user } = getRefineIdentityPrompts({
    feedback: params.feedback,
    currentIdentityJSON: JSON.stringify(params.currentIdentity),
  });
  let lastError: Error = new Error('No parse attempts completed');
  for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt += 1) {
    const text = await client.complete({
      role: 'default',
      system,
      user,
      ...(params.onReasoningDelta ? { onReasoningDelta: params.onReasoningDelta } : {}),
    });
    try {
      const parsed = IdentitySchema.safeParse(extractJsonObject(text));
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
