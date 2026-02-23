import type { ModelRole } from '../config/types.js';
import type { ToolContext, ToolDef } from '../tools/types.js';

export type { ModelRole };

// Keep this to the roles we actually pass into the LLM call.
// Tool-call messages are managed by the backend's tool loop implementation.
export type LLMMessageRole = 'system' | 'user' | 'assistant';

export type LLMContentPart =
  | { type: 'text'; text: string }
  // AI SDK-compatible shape (best-effort) for multimodal inputs.
  | { type: 'image'; image: Uint8Array | string | URL; mediaType?: string | undefined }
  | { type: 'file'; data: Uint8Array | string | URL; mediaType: string };

export type LLMContent = string | readonly LLMContentPart[];

export type LLMMessage =
  | { role: 'system'; content: LLMContent }
  | { role: 'user'; content: LLMContent }
  | { role: 'assistant'; content: LLMContent };

export const llmContentToText = (content: LLMContent): string => {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const p of content) {
    if (p.type === 'text') parts.push(p.text);
    else if (p.type === 'image') parts.push('[image]');
    else if (p.type === 'file') parts.push(`[file:${p.mediaType}]`);
    else parts.push('[part]');
  }
  return parts.join('\n').trim();
};

export type TurnStep =
  | { type: 'llm'; text: string; toolName?: undefined }
  | { type: 'tool'; toolName: string; text?: string | undefined };

export interface LLMUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  costUsd?: number | undefined;
  txHash?: string | undefined;
}

export interface CompleteParams {
  role: ModelRole;
  messages: LLMMessage[];
  tools?: readonly ToolDef[] | undefined;
  maxSteps: number;
  signal?: AbortSignal | undefined;
  toolContext?: Omit<ToolContext, 'now' | 'signal'> | undefined;
  stream?: CompletionStreamObserver | undefined;
}

export interface CompleteObjectParams<_T> {
  role: ModelRole;
  messages: LLMMessage[];
  schema: unknown;
  signal?: AbortSignal | undefined;
}

export interface CompletionResult {
  text: string;
  steps: TurnStep[];
  usage?: LLMUsage | undefined;
  /** Provider-specific model identifier used for the completion (best-effort). */
  modelId?: string | undefined;
}

export interface CompletionObjectResult<T> {
  output: T;
  usage?: LLMUsage | undefined;
  /** Provider-specific model identifier used for the completion (best-effort). */
  modelId?: string | undefined;
}

export interface CompletionToolCallEvent {
  toolCallId: string;
  toolName: string;
  input?: unknown;
}

export interface CompletionToolResultEvent {
  toolCallId: string;
  toolName: string;
  output?: unknown;
}

export interface CompletionToolInputStartEvent {
  toolCallId: string;
  toolName: string;
}

export interface CompletionToolInputDeltaEvent {
  toolCallId: string;
  toolName: string;
  delta: string;
}

export interface CompletionToolInputEndEvent {
  toolCallId: string;
  toolName: string;
}

export interface CompletionStepFinishEvent {
  index: number;
  finishReason?: string | undefined;
  usage?: LLMUsage | undefined;
}

export interface CompletionStreamObserver {
  onTextDelta?: ((delta: string) => void) | undefined;
  onReasoningDelta?: ((delta: string) => void) | undefined;
  onToolCall?: ((event: CompletionToolCallEvent) => void) | undefined;
  onToolInputStart?: ((event: CompletionToolInputStartEvent) => void) | undefined;
  onToolInputDelta?: ((event: CompletionToolInputDeltaEvent) => void) | undefined;
  onToolInputEnd?: ((event: CompletionToolInputEndEvent) => void) | undefined;
  onToolResult?: ((event: CompletionToolResultEvent) => void) | undefined;
  onStepFinish?: ((event: CompletionStepFinishEvent) => void) | undefined;
  onError?: ((error: unknown) => void) | undefined;
  onAbort?: (() => void) | undefined;
  onFinish?: (() => void) | undefined;
}

export interface LLMBackend {
  complete(params: CompleteParams): Promise<CompletionResult>;
  completeObject?<T>(params: CompleteObjectParams<T>): Promise<CompletionObjectResult<T>>;
}
