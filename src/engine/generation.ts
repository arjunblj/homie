import { channelUserId, type IncomingMessage } from '../agent/types.js';
import type {
  CompletionStepFinishEvent,
  CompletionToolCallEvent,
  CompletionToolInputDeltaEvent,
  CompletionToolInputEndEvent,
  CompletionToolInputStartEvent,
  CompletionToolResultEvent,
  LLMBackend,
} from '../backend/types.js';
import { checkSlop, enforceMaxLength, slopReasons } from '../behavior/slop.js';
import type { MemoryStore } from '../memory/store.js';
import type { SessionStore } from '../session/types.js';
import type { ToolDef } from '../tools/types.js';
import type { TurnStreamObserver, UsageAcc } from './types.js';

export interface GenerateReplyParams {
  backend: LLMBackend;
  usage: UsageAcc;
  msg: IncomingMessage;
  system: string;
  dataMessagesForModel: Array<{ role: 'user'; content: string }>;
  tools: readonly ToolDef[] | undefined;
  historyForModel: Array<{ role: 'user' | 'assistant'; content: string }>;
  userMessages: Array<{ role: 'user'; content: string }>;
  maxChars: number;
  maxSteps: number;
  maxRegens: number;
  identityAntiPatterns: readonly string[];
  toolServices?:
    | {
        memoryStore?: MemoryStore | undefined;
        sessionStore?: SessionStore | undefined;
      }
    | undefined;
  /**
   * If true, skip slop detection + internal regen loop and return the raw draft
   * (still clipped and group-disciplined). Used when a caller wants to apply
   * its own bounded quality gate (e.g. proactive).
   */
  skipSlopCheck?: boolean | undefined;
  observer?: TurnStreamObserver | undefined;
  signal?: AbortSignal | undefined;
  takeModelToken: (chatId: IncomingMessage['chatId']) => Promise<void>;
  engineSignal?: AbortSignal | undefined;
}

export async function generateDisciplinedReply(params: GenerateReplyParams): Promise<{
  text?: string;
  reason?: string;
  toolOutput?: { tokensUsed: number; toolCalls: number; truncatedCount: number };
}> {
  const {
    backend,
    usage,
    msg,
    system,
    dataMessagesForModel,
    tools,
    historyForModel,
    userMessages,
    maxChars,
    maxSteps,
    maxRegens,
    identityAntiPatterns,
    toolServices,
    skipSlopCheck,
    observer,
    signal,
    takeModelToken,
    engineSignal,
  } = params;

  const userTextForScan = userMessages.map((m) => m.content).join('\n');
  const verifiedUrls = new Set<string>();
  for (const m of userTextForScan.matchAll(/https?:\/\/[^\s<>()]+/gu)) {
    const raw = m[0]?.trim();
    if (!raw) continue;
    try {
      verifiedUrls.add(new URL(raw).toString());
    } catch (_err) {
      verifiedUrls.add(raw);
    }
  }

  const attachments = msg.attachments;
  const baseToolContext = {
    verifiedUrls,
    chat: {
      chatId: msg.chatId,
      channel: msg.channel,
      channelUserId: channelUserId(msg),
      isGroup: msg.isGroup,
      isOperator: Boolean(msg.isOperator),
    },
    services: toolServices,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(attachments?.some((a) => Boolean(a.getBytes))
      ? {
          getAttachmentBytes: async (attachmentId: string): Promise<Uint8Array> => {
            const a = attachments.find((x) => x.id === attachmentId);
            if (!a) throw new Error('Attachment not found');
            if (!a.getBytes) {
              throw new Error('Attachment bytes unavailable');
            }
            const maxBytes = 25 * 1024 * 1024;
            if (typeof a.sizeBytes === 'number' && a.sizeBytes > maxBytes) {
              throw new Error('Attachment too large');
            }
            const runSignal = signal ?? engineSignal;
            if (runSignal?.aborted) {
              const r = runSignal.reason;
              throw r instanceof Error ? r : new Error(String(r ?? 'Aborted'));
            }
            return await a.getBytes();
          },
        }
      : {}),
  } as const;

  const toolOutputStats = { tokensUsed: 0, toolCalls: 0, truncatedCount: 0 };
  const TOOL_OUTPUT_MAX_TOKENS_TOTAL = 1_200;
  const TOOL_OUTPUT_MAX_TOKENS_PER_TOOL = 900;

  const createToolOutputBudget = () => ({
    remainingTokens: TOOL_OUTPUT_MAX_TOKENS_TOTAL,
    maxTokensPerTool: TOOL_OUTPUT_MAX_TOKENS_PER_TOOL,
    onToolOutput: (event: { toolName: string; tokensUsed: number; truncated: boolean }) => {
      toolOutputStats.toolCalls += 1;
      toolOutputStats.tokensUsed += Math.max(0, Math.floor(event.tokensUsed));
      if (event.truncated) toolOutputStats.truncatedCount += 1;
    },
  });

  const streamOpts = observer
    ? {
        stream: {
          onTextDelta: (delta: string) => {
            if (!delta) return;
            observer.onPhase?.('streaming');
            observer.onTextDelta?.(delta);
          },
          onReasoningDelta: (delta: string) => {
            if (!delta) return;
            observer.onPhase?.('thinking');
            observer.onReasoningDelta?.(delta);
          },
          onToolCall: (event: CompletionToolCallEvent) => {
            observer.onPhase?.('tool_use');
            observer.onToolCall?.(event);
          },
          onToolInputStart: (event: CompletionToolInputStartEvent) => {
            observer.onPhase?.('tool_use');
            observer.onToolInputStart?.(event);
          },
          onToolInputDelta: (event: CompletionToolInputDeltaEvent) => {
            observer.onPhase?.('tool_use');
            observer.onToolInputDelta?.(event);
          },
          onToolInputEnd: (event: CompletionToolInputEndEvent) => {
            observer.onPhase?.('tool_use');
            observer.onToolInputEnd?.(event);
          },
          onToolResult: (event: CompletionToolResultEvent) => {
            observer.onPhase?.('tool_use');
            observer.onToolResult?.(event);
          },
          onStepFinish: (event: CompletionStepFinishEvent) => {
            const usageTotals = event.usage
              ? {
                  inputTokens: event.usage.inputTokens ?? 0,
                  outputTokens: event.usage.outputTokens ?? 0,
                  cacheReadTokens: event.usage.cacheReadTokens ?? 0,
                  cacheWriteTokens: event.usage.cacheWriteTokens ?? 0,
                  reasoningTokens: event.usage.reasoningTokens ?? 0,
                  costUsd: event.usage.costUsd ?? 0,
                }
              : undefined;
            observer.onStepFinish?.({
              index: event.index,
              ...(event.finishReason ? { finishReason: event.finishReason } : {}),
              ...(usageTotals ? { usage: usageTotals } : {}),
            });
          },
          onAbort: () => {
            observer.onMeta?.('request aborted');
          },
          onError: () => {
            observer.onMeta?.('stream error encountered');
          },
        },
      }
    : {};
  const runSignal = signal ?? engineSignal;

  let attempt = 0;
  while (attempt <= maxRegens) {
    attempt += 1;
    await takeModelToken(msg.chatId);

    const toolContext = { ...baseToolContext, toolOutput: createToolOutputBudget() };
    const result = await backend.complete({
      role: 'default',
      maxSteps,
      tools,
      messages: [
        { role: 'system', content: system },
        ...dataMessagesForModel,
        ...historyForModel,
        ...userMessages,
      ],
      signal: runSignal,
      toolContext,
      ...streamOpts,
    });
    usage.addCompletion(result);

    const text = result.text.trim();
    if (!text)
      return {
        reason: attempt > 1 ? 'model_silence_regen' : 'model_silence',
        toolOutput: { ...toolOutputStats },
      };

    const clipped = enforceMaxLength(text, maxChars);
    const disciplined = msg.isGroup ? clipped.replace(/\s*\n+\s*/gu, ' ').trim() : clipped;
    if (skipSlopCheck) return { text: disciplined, toolOutput: { ...toolOutputStats } };
    const slopResult = checkSlop(clipped, identityAntiPatterns);
    if (!slopResult.isSlop) return { text: disciplined, toolOutput: { ...toolOutputStats } };
    if (attempt > maxRegens) break;

    const reasons = slopReasons(slopResult).join(', ');
    observer?.onMeta?.(`rewriting response for clarity (${reasons || 'friend-voice discipline'})`);
    observer?.onReset?.();
    const regenSystem = [
      system,
      '',
      `Rewrite the reply to remove AI slop: ${reasons || 'unknown'}.`,
      'Be specific, casual, and human.',
      'Do not repeat the same phrasing.',
    ].join('\n');
    await takeModelToken(msg.chatId);
    const regenToolContext = { ...baseToolContext, toolOutput: createToolOutputBudget() };
    const regen = await backend.complete({
      role: 'default',
      maxSteps,
      tools,
      messages: [
        { role: 'system', content: regenSystem },
        ...dataMessagesForModel,
        ...historyForModel,
        ...userMessages,
        { role: 'assistant', content: clipped },
        { role: 'user', content: 'Rewrite your last message with a natural friend voice.' },
      ],
      signal: runSignal,
      toolContext: regenToolContext,
      ...streamOpts,
    });
    usage.addCompletion(regen);

    const regenText = regen.text.trim();
    if (!regenText) return { reason: 'model_silence_regen', toolOutput: { ...toolOutputStats } };
    const clippedRegen = enforceMaxLength(regenText, maxChars);
    const disciplinedRegen = msg.isGroup
      ? clippedRegen.replace(/\s*\n+\s*/gu, ' ').trim()
      : clippedRegen;
    const slop2 = checkSlop(clippedRegen, identityAntiPatterns);
    if (!slop2.isSlop) return { text: disciplinedRegen, toolOutput: { ...toolOutputStats } };
  }
  return { reason: 'slop_unresolved', toolOutput: { ...toolOutputStats } };
}
