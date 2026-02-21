export type OutgoingAction =
  | {
      kind: 'silence';
      reason?: string | undefined;
    }
  | {
      kind: 'send_text';
      text: string;
      /** Hint that the user requested a voice/audio reply. Channel adapters may synthesize TTS. */
      ttsHint?: boolean | undefined;
    }
  | {
      kind: 'react';
      emoji: string;
      targetAuthorId: string;
      targetTimestampMs: number;
    };

export interface TurnToolCallEvent {
  toolCallId: string;
  toolName: string;
  input?: unknown;
}

export interface TurnToolInputStartEvent {
  toolCallId: string;
  toolName: string;
}

export interface TurnToolInputDeltaEvent {
  toolCallId: string;
  toolName: string;
  delta: string;
}

export interface TurnToolInputEndEvent {
  toolCallId: string;
  toolName: string;
}

export interface TurnToolResultEvent {
  toolCallId: string;
  toolName: string;
  output?: unknown;
}

export interface TurnUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

export interface TurnUsageEvent {
  llmCalls: number;
  modelId?: string | undefined;
  txHash?: string | undefined;
  usage: TurnUsageTotals;
}

export interface TurnStepFinishEvent {
  index: number;
  finishReason?: string | undefined;
  usage?: TurnUsageTotals | undefined;
}

export interface TurnStreamObserver {
  onPhase?: ((phase: 'thinking' | 'streaming' | 'tool_use') => void) | undefined;
  onTextDelta?: ((delta: string) => void) | undefined;
  onReasoningDelta?: ((delta: string) => void) | undefined;
  onToolCall?: ((event: TurnToolCallEvent) => void) | undefined;
  onToolInputStart?: ((event: TurnToolInputStartEvent) => void) | undefined;
  onToolInputDelta?: ((event: TurnToolInputDeltaEvent) => void) | undefined;
  onToolInputEnd?: ((event: TurnToolInputEndEvent) => void) | undefined;
  onToolResult?: ((event: TurnToolResultEvent) => void) | undefined;
  onStepFinish?: ((event: TurnStepFinishEvent) => void) | undefined;
  onUsage?: ((event: TurnUsageEvent) => void) | undefined;
  onMeta?: ((message: string) => void) | undefined;
  onReset?: (() => void) | undefined;
}

import type { CompletionResult, LLMUsage } from '../backend/types.js';

export interface UsageAcc {
  llmCalls: number;
  lastModelId?: string | undefined;
  lastTxHash?: string | undefined;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    costUsd: number;
  };
  addCompletion(result: CompletionResult): void;
}

export function createUsageAcc(): UsageAcc {
  const acc: UsageAcc = {
    llmCalls: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    },
    addCompletion(result: CompletionResult): void {
      acc.llmCalls += 1;
      if (result.modelId) acc.lastModelId = result.modelId;
      const u: LLMUsage | undefined = result.usage;
      if (!u) return;
      acc.usage.inputTokens += u.inputTokens ?? 0;
      acc.usage.outputTokens += u.outputTokens ?? 0;
      acc.usage.cacheReadTokens += u.cacheReadTokens ?? 0;
      acc.usage.cacheWriteTokens += u.cacheWriteTokens ?? 0;
      acc.usage.reasoningTokens += u.reasoningTokens ?? 0;
      acc.usage.costUsd += u.costUsd ?? 0;
      if (u.txHash) acc.lastTxHash = u.txHash;
    },
  };
  return acc;
}

export function isContextOverflowError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /context(\s|_)?(length|window)|prompt is too long|too many tokens|max tokens/i.test(msg);
}
