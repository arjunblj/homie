import type { ModelRole } from '../config/types.js';
import type { ToolContext, ToolDef } from '../tools/types.js';

export type { ModelRole };

// Keep this to the roles we actually pass into the LLM call.
// Tool-call messages are managed by the backend's tool loop implementation.
export type LLMMessageRole = 'system' | 'user' | 'assistant';

export interface LLMMessage {
  role: LLMMessageRole;
  content: string;
}

export interface TurnStep {
  type: 'llm' | 'tool';
  text?: string | undefined;
  toolName?: string | undefined;
}

export interface LLMUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  reasoningTokens?: number | undefined;
}

export interface CompleteParams {
  role: ModelRole;
  messages: LLMMessage[];
  tools?: readonly ToolDef[] | undefined;
  maxSteps: number;
  signal?: AbortSignal | undefined;
  toolContext?: Omit<ToolContext, 'now' | 'signal'> | undefined;
}

export interface CompletionResult {
  text: string;
  steps: TurnStep[];
  usage?: LLMUsage | undefined;
  /** Provider-specific model identifier used for the completion (best-effort). */
  modelId?: string | undefined;
}

export interface LLMBackend {
  complete(params: CompleteParams): Promise<CompletionResult>;
}
