export type TurnKind = 'incoming' | 'proactive';

export interface TurnUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface TurnTelemetryEvent {
  id: string; // correlation / turn id
  kind: TurnKind;
  channel?: string | undefined;
  chatId: string;
  messageId?: string | undefined;
  proactiveKind?: string | undefined;
  proactiveEventId?: number | undefined;
  startedAtMs: number;
  durationMs: number;
  action: string;
  reason?: string | undefined;
  llmCalls: number;
  usage: TurnUsageTotals;
}

export interface ContextCompositionEvent {
  turnId: string;
  kind: TurnKind;
  chatId: string;
  isGroup: boolean;
  trustTier?: string | undefined;
  createdAtMs: number;
  systemTokens: number;
  identityTokens: number;
  sessionNotesTokens: number;
  memoryTokens: number;
  outboundLedgerTokens: number;
  toolOutputTokens: number;
  toolOutputToolCalls: number;
  toolOutputTruncatedCount: number;
  memorySkipped: boolean;
}

export interface UsageSummary {
  windowMs: number;
  turns: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface LlmCallEvent {
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
}

export interface SlopTelemetryEvent {
  chatId: string;
  createdAtMs: number;
  isGroup: boolean;
  action: string;
  score: number;
  categories: readonly string[];
}

export interface TelemetryStore {
  ping(): void;
  close(): void;
  logTurn(event: TurnTelemetryEvent): void;
  logSlop(event: SlopTelemetryEvent): void;
  logLlmCall(event: LlmCallEvent): void;
  logContextComposition(event: ContextCompositionEvent): void;
  getUsageSummary(windowMs: number): UsageSummary;
  getLlmUsageSummary(windowMs: number): UsageSummary;
}
