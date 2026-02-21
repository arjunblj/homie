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

export interface TurnStreamObserver {
  onPhase?: ((phase: 'thinking' | 'streaming' | 'tool_use') => void) | undefined;
  onTextDelta?: ((delta: string) => void) | undefined;
  onReasoningDelta?: ((delta: string) => void) | undefined;
  onToolCall?: ((event: TurnToolCallEvent) => void) | undefined;
  onToolResult?: ((event: TurnToolResultEvent) => void) | undefined;
  onUsage?: ((event: TurnUsageEvent) => void) | undefined;
  onMeta?: ((message: string) => void) | undefined;
  onReset?: (() => void) | undefined;
}
