export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'meta';
  content: string;
  isStreaming: boolean;
  timestampMs: number;
  kind?: 'default' | 'receipt' | 'alert' | undefined;
  reasoningTrace?: string | undefined;
}

export type ToolCallStatus = 'running' | 'done' | 'error';

export interface ToolCallState {
  id: string;
  name: string;
  status: ToolCallStatus;
  inputSummary?: string | undefined;
  outputSummary?: string | undefined;
}

export interface SessionMetrics {
  turns: number;
  queued: number;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

export type PaymentState =
  | 'ready'
  | 'pending'
  | 'success'
  | 'failed'
  | 'insufficient_funds'
  | 'wrong_network'
  | 'timeout'
  | 'endpoint_unreachable'
  | 'invalid_key_format'
  | 'cancelled'
  | 'unknown';

export interface TurnUsageSummary {
  llmCalls: number;
  modelId?: string | undefined;
  txHash?: string | undefined;
  usage: UsageSummary;
}

export interface ChatAttachmentRef {
  path: string;
  displayName: string;
}

export interface ChatTurnInput {
  text: string;
  attachments?: readonly ChatAttachmentRef[] | undefined;
}

export type ChatPhase = 'idle' | 'thinking' | 'streaming' | 'tool_use';
export type VerbosityMode = 'compact' | 'verbose';

export type ChatTurnResult =
  | {
      kind: 'send_text';
      text: string;
    }
  | {
      kind: 'react';
      emoji: string;
    }
  | {
      kind: 'silence';
      reason?: string | undefined;
    };

export type ChatTurnEvent =
  | { type: 'phase'; phase: Exclude<ChatPhase, 'idle'> }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; input?: unknown }
  | { type: 'tool_result'; toolCallId: string; toolName: string; output?: unknown }
  | { type: 'usage'; summary: TurnUsageSummary }
  | { type: 'meta'; message: string }
  | { type: 'reset_stream' }
  | { type: 'done'; result: ChatTurnResult };

export interface ChatTurnStream {
  events: AsyncIterable<ChatTurnEvent>;
  cancel(): void;
}

export type ChatTurnStreamer = (input: ChatTurnInput) => ChatTurnStream;
