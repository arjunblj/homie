import { describeAttachmentForModel, sanitizeAttachmentsForSession } from '../agent/attachments.js';
import { PerKeyLock } from '../agent/lock.js';
import { channelUserId, type IncomingMessage } from '../agent/types.js';
import type {
  CompletionResult,
  CompletionStepFinishEvent,
  CompletionToolCallEvent,
  CompletionToolInputDeltaEvent,
  CompletionToolInputEndEvent,
  CompletionToolInputStartEvent,
  CompletionToolResultEvent,
  LLMBackend,
  LLMUsage,
} from '../backend/types.js';
import { BehaviorEngine, type EngagementDecision } from '../behavior/engine.js';
import { checkSlop, enforceMaxLength, slopReasons } from '../behavior/slop.js';
import { isInSleepWindow, sampleHumanDelayMs } from '../behavior/timing.js';
import { measureVelocity } from '../behavior/velocity.js';
import { userRequestedVoiceNote } from '../behavior/voiceHint.js';
import { parseChatId } from '../channels/chatId.js';
import type { OpenhomieConfig } from '../config/types.js';
import type { MemoryExtractor } from '../memory/extractor.js';
import { updateCounters } from '../memory/observations.js';
import type { MemoryStore } from '../memory/store.js';
import { type ChatTrustTier, deriveTrustTierForPerson, scoreFromSignals } from '../memory/types.js';
import type { EventScheduler } from '../proactive/scheduler.js';
import type { ProactiveEvent } from '../proactive/types.js';
import { buildPromptSkillsSection } from '../prompt-skills/loader.js';
import type { PromptSkillIndex } from '../prompt-skills/parse.js';
import { scanPromptInjection } from '../security/contentSanitizer.js';
import type { SessionStore } from '../session/types.js';
import type { TelemetryStore } from '../telemetry/types.js';
import { buildToolGuidance, filterToolsForMessage } from '../tools/policy.js';
import type { ToolDef } from '../tools/types.js';
import type { ChatId } from '../types/ids.js';
import { asMessageId, asPersonId } from '../types/ids.js';
import { errorFields, log, newCorrelationId, withLogContext } from '../util/logger.js';
import { PerKeyRateLimiter } from '../util/perKeyRateLimiter.js';
import { TokenBucket } from '../util/tokenBucket.js';
import type { AgentRuntimeWallet } from '../wallet/types.js';
import { MessageAccumulator } from './accumulator.js';
import { ContextBuilder, renderGroupUserContent } from './contextBuilder.js';
import type { OutgoingAction, TurnStreamObserver } from './types.js';

export interface TurnEngineOptions {
  config: OpenhomieConfig;
  backend: LLMBackend;
  tools?: readonly ToolDef[] | undefined;
  promptSkills?: readonly PromptSkillIndex[] | undefined;
  sessionStore?: SessionStore | undefined;
  memoryStore?: MemoryStore | undefined;
  extractor?: MemoryExtractor | undefined;
  eventScheduler?: EventScheduler | undefined;
  maxContextTokens?: number | undefined;
  behaviorEngine?: BehaviorEngine | undefined;
  accumulator?: MessageAccumulator | undefined;
  signal?: AbortSignal | undefined;
  trackBackground?: (<T>(promise: Promise<T>) => Promise<T>) | undefined;
  onSuccessfulTurn?: (() => void) | undefined;
  telemetry?: TelemetryStore | undefined;
  hasChannelsConfigured?: boolean | undefined;
  agentRuntimeWallet?: AgentRuntimeWallet | undefined;
}

/**
 * Deterministic pre-filter for platform protocol artifacts.
 * These are not real user messages — they're read receipts, typing indicators,
 * profile updates, etc. that bridge adapters sometimes surface as text.
 * Silenced mechanically: no reasoning, no LLM call, no exceptions.
 */
const PLATFORM_ARTIFACT_PATTERNS = [
  /^<media:unknown>\s*$/iu,
  /^(?:<media:unknown>\s*){2,}$/iu,
  /^\[read receipt\]/iu,
  /^\[typing indicator\]/iu,
  /^\[profile update\]/iu,
  /^\[story (?:view|reply|update)\]/iu,
  /^\[contact card\]/iu,
] as const;

const isPlatformArtifact = (text: string): boolean => {
  const t = text.trim();
  if (!t) return false;
  return PLATFORM_ARTIFACT_PATTERNS.some((p) => p.test(t));
};

const summarizeAttachmentsForUserText = (msg: IncomingMessage): string => {
  const atts = msg.attachments ?? [];
  if (!atts.length) return '';
  return atts
    .map((a) => describeAttachmentForModel(a))
    .join('\n')
    .trim();
};

const COMPACTION_SUMMARY_SYSTEM = [
  'Summarize the conversation so far for a FRIEND agent.',
  'Preserve: emotional content, promises/commitments, durable relationship facts, inside jokes.',
  'Discard: redundant greetings, mechanical details, and anything already captured as facts.',
  'Return a concise summary (no bullet lists unless necessary).',
].join('\n');

const inferProactiveRecipientMessage = (event: ProactiveEvent): IncomingMessage | null => {
  const parsed = parseChatId(event.chatId);
  const nowMs = Date.now();

  if (parsed?.channel === 'signal' && parsed.kind === 'dm') {
    const authorId = parsed.id;
    return {
      channel: 'signal',
      chatId: event.chatId,
      messageId: asMessageId(`proactive:${event.id}:${nowMs}`),
      authorId,
      authorDisplayName: undefined,
      text: '',
      isGroup: false,
      isOperator: false,
      timestampMs: nowMs,
    };
  }
  if (parsed?.channel === 'signal' && parsed.kind === 'group') {
    return {
      channel: 'signal',
      chatId: event.chatId,
      messageId: asMessageId(`proactive:${event.id}:${nowMs}`),
      authorId: `group:${parsed.id}`,
      authorDisplayName: undefined,
      text: '',
      isGroup: true,
      isOperator: false,
      mentioned: false,
      timestampMs: nowMs,
    };
  }
  if (parsed?.channel === 'telegram' && parsed.kind === 'dm') {
    const authorId = parsed.id;
    return {
      channel: 'telegram',
      chatId: event.chatId,
      messageId: asMessageId(`proactive:${event.id}:${nowMs}`),
      authorId,
      authorDisplayName: undefined,
      text: '',
      isGroup: false,
      isOperator: false,
      timestampMs: nowMs,
    };
  }
  if (parsed?.channel === 'telegram' && parsed.kind === 'group') {
    return {
      channel: 'telegram',
      chatId: event.chatId,
      messageId: asMessageId(`proactive:${event.id}:${nowMs}`),
      authorId: `group:${parsed.id}`,
      authorDisplayName: undefined,
      text: '',
      isGroup: true,
      isOperator: false,
      mentioned: false,
      timestampMs: nowMs,
    };
  }
  if (parsed?.channel === 'cli') {
    return {
      channel: 'cli',
      chatId: event.chatId,
      messageId: asMessageId(`proactive:${event.id}:${nowMs}`),
      authorId: 'operator',
      authorDisplayName: 'operator',
      text: '',
      isGroup: false,
      isOperator: true,
      timestampMs: nowMs,
    };
  }
  return null;
};

interface UsageAcc {
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

type LockedIncomingResult =
  | { kind: 'final'; action: OutgoingAction }
  | {
      kind: 'draft_send_text';
      userText: string;
      draftText: string;
    }
  | {
      kind: 'draft_react';
      userText: string;
      emoji: string;
    };

const createUsageAcc = (): UsageAcc => {
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
};

const INCOMING_MESSAGE_DEDUPE_TTL_MS = 10 * 60_000;
const INCOMING_MESSAGE_DEDUPE_MAX_KEYS = 10_000;
const RESPONSE_SEQ_MAX_KEYS = 10_000;

export class TurnEngine {
  private readonly logger = log.child({ component: 'turn_engine' });
  private readonly lock = new PerKeyLock<ChatId>();
  private readonly globalLimiter: TokenBucket;
  private readonly perChatLimiter: PerKeyRateLimiter<ChatId>;
  private readonly behavior: BehaviorEngine;
  private readonly contextBuilder: ContextBuilder;
  private readonly accumulator: MessageAccumulator;
  private readonly seenIncoming = new Map<string, number>();
  private readonly responseSeq = new Map<string, number>();

  public constructor(private readonly options: TurnEngineOptions) {
    this.globalLimiter = new TokenBucket(options.config.engine.limiter);
    this.perChatLimiter = new PerKeyRateLimiter<ChatId>(options.config.engine.perChatLimiter);

    this.behavior =
      options.behaviorEngine ??
      new BehaviorEngine({
        behavior: options.config.behavior,
        backend: options.backend,
      });

    const indexed = options.promptSkills;
    const promptSkillsSection =
      indexed && indexed.length > 0
        ? (sOpts: { msg: IncomingMessage; query: string }) =>
            buildPromptSkillsSection({
              indexed,
              msg: sOpts.msg,
              query: sOpts.query,
              maxTokens: options.config.engine.context.promptSkillsMaxTokens,
            })
        : undefined;

    this.contextBuilder = new ContextBuilder({
      config: options.config,
      sessionStore: options.sessionStore,
      memoryStore: options.memoryStore,
      ...(promptSkillsSection ? { promptSkillsSection } : {}),
      hasChannelsConfigured: options.hasChannelsConfigured,
      agentRuntimeWallet: options.agentRuntimeWallet,
    });

    this.accumulator = options.accumulator ?? new MessageAccumulator();
  }

  private async summarizeForCompaction(
    msg: IncomingMessage,
    usage: UsageAcc,
    input: string,
  ): Promise<string> {
    const { backend } = this.options;
    await this.takeModelToken(msg.chatId);
    const res = await backend.complete({
      role: 'fast',
      maxSteps: 2,
      messages: [
        { role: 'system', content: COMPACTION_SUMMARY_SYSTEM },
        { role: 'user', content: input },
      ],
      signal: this.options.signal,
    });
    usage.addCompletion(res);
    return res.text;
  }

  public async handleIncomingMessage(
    msg: IncomingMessage,
    observer?: TurnStreamObserver,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<OutgoingAction> {
    const started = Date.now();
    const turnId = newCorrelationId();
    const chatKey = String(msg.chatId);
    const nextSeq = (this.responseSeq.get(chatKey) ?? 0) + 1;
    if (this.responseSeq.has(chatKey)) this.responseSeq.delete(chatKey);
    this.responseSeq.set(chatKey, nextSeq);
    this.evictResponseSeqIfNeeded();
    return withLogContext(
      {
        turnId,
        turnKind: 'incoming',
        channel: msg.channel,
        chatId: String(msg.chatId),
        messageId: String(msg.messageId),
      },
      async () => {
        const usage = createUsageAcc();
        const runSignal = opts?.signal ?? this.options.signal;
        if (runSignal?.aborted) {
          return { kind: 'silence', reason: 'shutting_down' };
        }

        const nowMs = Date.now();
        const incomingKey = this.incomingDedupeKey(msg);
        if (this.isDuplicateIncoming(incomingKey, nowMs)) {
          this.logger.debug('turn.duplicate_message');
          return { kind: 'silence', reason: 'duplicate_message' };
        }

        const text = msg.text.trim();

        if (isPlatformArtifact(text)) {
          this.markIncomingSeen(incomingKey, nowMs);
          return { kind: 'silence', reason: 'platform_artifact' };
        }

        const attSummary = summarizeAttachmentsForUserText(msg);
        const userText = [text, attSummary]
          .filter((s) => Boolean(s?.trim()))
          .join('\n')
          .trim();
        if (!userText) {
          this.markIncomingSeen(incomingKey, nowMs);
          return { kind: 'silence', reason: 'empty_input' };
        }

        // Mark early so duplicate deliveries don't create duplicate rows.
        this.markIncomingSeen(incomingKey, nowMs);

        // Persist the user's message immediately for crash-safety and for stable batching.
        // We intentionally use the channel-provided timestamp so bursts stay ordered even if
        // multiple inbound handlers run concurrently.
        this.options.sessionStore?.appendMessage({
          chatId: msg.chatId,
          role: 'user',
          content: userText,
          createdAtMs: msg.timestampMs,
          authorId: msg.authorId,
          authorDisplayName: msg.authorDisplayName,
          sourceMessageId: String(msg.messageId),
          attachments: sanitizeAttachmentsForSession(msg.attachments),
        });
        this.options.eventScheduler?.markProactiveResponded(msg.chatId);

        // If adapters explicitly tell us we weren't mentioned in a group chat, don't burn tokens.
        if (msg.isGroup && msg.mentioned === false) {
          return { kind: 'silence', reason: 'not_mentioned' };
        }

        // Accumulating debounce: collect multi-message bursts before processing.
        // Each new message resets the timer for this chat. Stale-discard still
        // provides correctness — only the latest message proceeds past the lock.
        const debounceMs = this.accumulator.pushAndGetDebounceMs({ msg, nowMs });
        if (debounceMs > 0) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, debounceMs);
            runSignal?.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                resolve();
              },
              { once: true },
            );
          });
          if (runSignal?.aborted) return { kind: 'silence', reason: 'shutting_down' };
        }

        if (this.isStale(msg.chatId, nextSeq)) {
          return { kind: 'silence', reason: 'stale_discard' };
        }

        // Rapid-dialogue gate: when multiple people are actively chatting in a
        // group, stay out of it entirely. The accumulating debounce handles
        // single-sender bursts and continuations; this handles multi-party velocity.
        if (msg.isGroup) {
          const velocity = measureVelocity({
            sessionStore: this.options.sessionStore,
            chatId: msg.chatId,
          });
          if (velocity.isRapidDialogue) {
            // Drop any queued burst so we don't re-surface it later.
            this.accumulator.clear(msg.chatId);
            return { kind: 'silence', reason: 'velocity_skip' };
          }
        }

        this.logger.info('turn.start', {
          isGroup: msg.isGroup,
          isOperator: msg.isOperator,
          textLen: msg.text.length,
          debounceMs,
        });
        observer?.onPhase?.('thinking');
        try {
          const locked = await this.lock.runExclusive(msg.chatId, async () =>
            this.handleIncomingMessageLockedDraft(msg, usage, nextSeq, observer, runSignal),
          );

          let out: OutgoingAction;
          if (locked.kind === 'final') {
            out = locked.action;
          } else {
            // Human-like delay is applied after drafting but before committing the outgoing action.
            // We re-acquire the per-chat lock and re-check staleness before persisting/sending,
            // so delayed replies don't create "ghost" assistant messages.
            const { minDelayMs, maxDelayMs } = this.options.config.behavior;
            const isQuestion = /\?\s*$/u.test(locked.userText.trimEnd());
            const delayMs = sampleHumanDelayMs({
              minMs: minDelayMs,
              maxMs: maxDelayMs,
              kind: locked.kind === 'draft_react' ? 'react' : 'send_text',
              textLen: locked.kind === 'draft_send_text' ? locked.draftText.length : 1,
              isQuestion,
            });

            if (delayMs > 0) {
              await new Promise<void>((resolve) => {
                const t = setTimeout(resolve, delayMs);
                runSignal?.addEventListener(
                  'abort',
                  () => {
                    clearTimeout(t);
                    resolve();
                  },
                  { once: true },
                );
              });
              if (runSignal?.aborted) return { kind: 'silence', reason: 'shutting_down' };
            }

            out = await this.lock.runExclusive(msg.chatId, async () =>
              this.commitIncomingDraft(msg, nextSeq, locked),
            );
          }
          if (usage.llmCalls > 0) {
            observer?.onUsage?.({
              llmCalls: usage.llmCalls,
              ...(usage.lastModelId ? { modelId: usage.lastModelId } : {}),
              ...(usage.lastTxHash ? { txHash: usage.lastTxHash } : {}),
              usage: { ...usage.usage },
            });
          }
          this.options.onSuccessfulTurn?.();
          try {
            this.options.telemetry?.logTurn({
              id: turnId,
              kind: 'incoming',
              channel: msg.channel,
              chatId: String(msg.chatId),
              messageId: String(msg.messageId),
              startedAtMs: started,
              durationMs: Date.now() - started,
              action: out.kind,
              ...(out.kind === 'silence' && out.reason ? { reason: out.reason } : {}),
              llmCalls: usage.llmCalls,
              usage: usage.usage,
            });
          } catch (err) {
            this.logger.debug('telemetry.logTurn_failed', errorFields(err));
          }
          this.logger.info('turn.end', {
            ms: Date.now() - started,
            action: out.kind,
            ...(out.kind === 'silence' && out.reason ? { reason: out.reason } : {}),
          });
          return out;
        } catch (err) {
          this.logger.error('turn.error', { ms: Date.now() - started, ...errorFields(err) });
          throw err;
        }
      },
    );
  }

  public async handleProactiveEvent(event: ProactiveEvent): Promise<OutgoingAction> {
    const started = Date.now();
    const turnId = newCorrelationId();
    return withLogContext(
      {
        turnId,
        turnKind: 'proactive',
        chatId: String(event.chatId),
        proactiveEventId: event.id,
        proactiveKind: event.kind,
      },
      async () => {
        const usage = createUsageAcc();
        if (this.options.signal?.aborted) {
          return { kind: 'silence', reason: 'shutting_down' };
        }
        this.logger.info('proactive.start', { subjectLen: event.subject.length });
        try {
          // Heartbeat-triggered proactive turns share the same per-chat lock as incoming turns,
          // so proactive delivery naturally defers while a chat is busy.
          const out = await this.lock.runExclusive(event.chatId, async () =>
            this.handleProactiveEventLocked(event, usage),
          );
          this.options.onSuccessfulTurn?.();
          try {
            this.options.telemetry?.logTurn({
              id: turnId,
              kind: 'proactive',
              channel: String(event.chatId).split(':')[0] ?? undefined,
              chatId: String(event.chatId),
              proactiveKind: event.kind,
              proactiveEventId: event.id,
              startedAtMs: started,
              durationMs: Date.now() - started,
              action: out.kind,
              ...(out.kind === 'silence' && out.reason ? { reason: out.reason } : {}),
              llmCalls: usage.llmCalls,
              usage: usage.usage,
            });
          } catch (err) {
            this.logger.debug('telemetry.logTurn_failed', errorFields(err));
          }
          this.logger.info('proactive.end', {
            ms: Date.now() - started,
            action: out.kind,
            ...(out.kind === 'silence' && out.reason ? { reason: out.reason } : {}),
          });
          return out;
        } catch (err) {
          this.logger.error('proactive.error', { ms: Date.now() - started, ...errorFields(err) });
          throw err;
        }
      },
    );
  }

  public async drain(): Promise<void> {
    await this.lock.drain();
  }

  private incomingDedupeKey(msg: IncomingMessage): string {
    return `${String(msg.chatId)}|${String(msg.messageId)}`;
  }

  private isDuplicateIncoming(key: string, nowMs: number): boolean {
    const exp = this.seenIncoming.get(key);
    if (typeof exp === 'number' && exp > nowMs) return true;
    if (typeof exp === 'number') this.seenIncoming.delete(key);
    return false;
  }

  private markIncomingSeen(key: string, nowMs: number): void {
    this.seenIncoming.set(key, nowMs + INCOMING_MESSAGE_DEDUPE_TTL_MS);

    if (this.seenIncoming.size <= INCOMING_MESSAGE_DEDUPE_MAX_KEYS) return;

    for (const [k, exp] of this.seenIncoming.entries()) {
      if (exp <= nowMs) this.seenIncoming.delete(k);
    }

    const extra = this.seenIncoming.size - INCOMING_MESSAGE_DEDUPE_MAX_KEYS;
    if (extra <= 0) return;

    let removed = 0;
    for (const k of this.seenIncoming.keys()) {
      this.seenIncoming.delete(k);
      removed += 1;
      if (removed >= extra) break;
    }
  }

  private async takeModelToken(chatId: ChatId): Promise<void> {
    await this.perChatLimiter.take(chatId, 1);
    await this.globalLimiter.take(1);
  }

  private async resolveTrustTier(msg: IncomingMessage): Promise<ChatTrustTier> {
    if (msg.isOperator) return 'close_friend';
    const store = this.options.memoryStore;
    if (!store) return 'new_contact';
    if (msg.isGroup) {
      // Group chats don't have a single per-person relationship signal yet; default conservative.
      return 'new_contact';
    }
    try {
      const person = await store.getPersonByChannelId(channelUserId(msg));
      return deriveTrustTierForPerson(person);
    } catch (err) {
      this.logger.debug('trust.resolve_failed', errorFields(err));
      return 'new_contact';
    }
  }

  private toolsForMessage(
    msg: IncomingMessage,
    tools: readonly ToolDef[] | undefined,
  ): readonly ToolDef[] | undefined {
    return filterToolsForMessage(tools, msg, this.options.config.tools);
  }

  private isContextOverflowError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /context(\s|_)?(length|window)|prompt is too long|too many tokens|max tokens/i.test(msg);
  }

  private async handleProactiveEventLocked(
    event: ProactiveEvent,
    usage: UsageAcc,
  ): Promise<OutgoingAction> {
    // Proactive must be conservatively routable. If we can't infer chat identity, skip safely.
    const msg = inferProactiveRecipientMessage(event);
    if (!msg) {
      this.logger.warn('proactive.unroutable', {
        chatId: String(event.chatId),
        proactiveEventId: event.id,
        proactiveKind: event.kind,
      });
      return { kind: 'silence', reason: 'proactive_unroutable' };
    }

    const { config, tools, sessionStore } = this.options;
    const nowMs = Date.now();

    if (isInSleepWindow(new Date(nowMs), config.behavior.sleep) && !msg.isOperator) {
      return { kind: 'silence', reason: 'sleep_mode' };
    }

    const { identityPrompt, personaReminder, behaviorOverride, identityAntiPatterns } =
      await this.contextBuilder.buildIdentityContext();

    // Relationship-aware compaction still applies (no new user message is appended).
    const maxContextTokens =
      this.options.maxContextTokens ?? config.engine.context.maxTokensDefault;
    const summarize = (input: string): Promise<string> =>
      this.summarizeForCompaction(msg, usage, input);
    if (sessionStore) {
      await sessionStore.compactIfNeeded({
        chatId: msg.chatId,
        maxTokens: maxContextTokens,
        personaReminder,
        summarize,
      });
    }

    const trustTier = await this.resolveTrustTier(msg);
    if (trustTier === 'new_contact' && event.kind !== 'reminder' && event.kind !== 'birthday') {
      return { kind: 'silence', reason: 'proactive_safe_mode' };
    }
    if (trustTier === 'getting_to_know' && event.kind !== 'reminder' && event.kind !== 'birthday') {
      const dailySent = this.options.eventScheduler?.countRecentSendsForChat(
        event.chatId,
        86_400_000,
      );
      if ((dailySent ?? 0) >= 1) {
        return { kind: 'silence', reason: 'proactive_warming_throttle' };
      }
    }

    const buildAndGenerate = async (): Promise<{ text?: string; reason?: string }> => {
      const ctx = await this.contextBuilder.buildProactiveModelContext({
        msg,
        event,
        tools,
        toolsForMessage: this.toolsForMessage.bind(this),
        toolGuidance: buildToolGuidance,
        identityPrompt,
        behaviorOverride,
      });

      return await this.generateDisciplinedReply({
        usage,
        msg,
        system: ctx.system,
        dataMessagesForModel: ctx.dataMessagesForModel,
        tools: ctx.toolsForModel,
        historyForModel: ctx.historyForModel,
        userMessages: [{ role: 'user', content: 'Send the proactive message now.' }],
        maxChars: ctx.maxChars,
        maxSteps: config.engine.generation.proactiveMaxSteps,
        maxRegens: config.engine.generation.maxRegens,
        identityAntiPatterns,
      });
    };

    let reply: { text?: string; reason?: string };
    try {
      reply = await buildAndGenerate();
    } catch (err) {
      if (this.isContextOverflowError(err) && sessionStore) {
        await sessionStore.compactIfNeeded({
          chatId: msg.chatId,
          maxTokens: maxContextTokens,
          personaReminder,
          summarize,
          force: true,
        });
        reply = await buildAndGenerate();
      } else {
        throw err;
      }
    }

    const trimmed = reply.text?.trim() ?? '';
    if (!trimmed || trimmed === 'HEARTBEAT_OK') {
      return { kind: 'silence', reason: reply.reason ?? 'proactive_model_silence' };
    }

    return await this.persistAndReturnProactiveAction(msg, event, trimmed, nowMs);
  }

  private async handleIncomingMessageLockedDraft(
    msg: IncomingMessage,
    usage: UsageAcc,
    seq: number,
    observer?: TurnStreamObserver,
    turnSignal?: AbortSignal | undefined,
  ): Promise<LockedIncomingResult> {
    const { config, tools, sessionStore, memoryStore } = this.options;
    const nowMs = Date.now();

    if (this.isStale(msg.chatId, seq)) {
      return { kind: 'final', action: { kind: 'silence', reason: 'stale_discard' } };
    }

    const batch = this.accumulator.drain(msg.chatId);
    const messages = batch.length > 0 ? batch : [msg];
    const last = messages.at(-1) ?? msg;

    const effectiveMentioned = (() => {
      if (messages.some((m) => m.mentioned === true)) return true;
      if (messages.every((m) => m.mentioned === false)) return false;
      return undefined;
    })();

    const effectiveMsg: IncomingMessage = {
      ...last,
      ...(typeof effectiveMentioned === 'boolean' ? { mentioned: effectiveMentioned } : {}),
    };

    const batchUserTexts = messages
      .map((m) => {
        const t = m.text.trim();
        const a = summarizeAttachmentsForUserText(m);
        const u = [t, a]
          .filter((s) => Boolean(s?.trim()))
          .join('\n')
          .trim();
        return u;
      })
      .filter((u) => Boolean(u?.trim()));

    const userText = batchUserTexts.join('\n').trim();
    if (!userText) {
      return { kind: 'final', action: { kind: 'silence', reason: 'empty_input' } };
    }

    if (effectiveMsg.isGroup && effectiveMsg.mentioned === false) {
      return { kind: 'final', action: { kind: 'silence', reason: 'not_mentioned' } };
    }

    const { identityPrompt, personaReminder, behaviorOverride, identityAntiPatterns } =
      await this.contextBuilder.buildIdentityContext();

    if (memoryStore) {
      const cid = channelUserId(effectiveMsg);
      try {
        const existing = await memoryStore.getPersonByChannelId(cid);
        await memoryStore.trackPerson({
          id: existing?.id ?? asPersonId(`person:${cid}`),
          displayName: effectiveMsg.authorDisplayName ?? effectiveMsg.authorId,
          channel: effectiveMsg.channel,
          channelUserId: cid,
          relationshipScore: existing?.relationshipScore ?? 0,
          ...(existing?.trustTierOverride ? { trustTierOverride: existing.trustTierOverride } : {}),
          ...(existing?.capsule ? { capsule: existing.capsule } : {}),
          createdAtMs: existing?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
        });
      } catch (err) {
        // Best-effort; never crash a turn due to memory bookkeeping.
        this.logger.debug('memory.track_person_failed', {
          channelUserId: cid,
          ...errorFields(err),
        });
      }
    }

    // Pre-draft behavior gate: sleep mode + group send/react/silence + random skip.
    const pre = await this.behavior.decidePreDraft(effectiveMsg, userText, {
      sessionStore,
      signal: turnSignal ?? this.options.signal,
      onCompletion: (res) => usage.addCompletion(res),
    });
    if (pre.kind !== 'send') {
      if (pre.kind === 'react') {
        return {
          kind: 'draft_react',
          userText,
          emoji: pre.emoji,
        };
      }

      const out = await this.persistSilenceDecision(effectiveMsg, userText, pre);
      return { kind: 'final', action: out };
    }

    const injectionFindings = scanPromptInjection(userText);
    const suppressToolsForInjection =
      !effectiveMsg.isOperator &&
      injectionFindings.some((f) => f.severity === 'critical' || f.severity === 'high');
    if (suppressToolsForInjection && tools && tools.length > 0) {
      const patterns = [
        ...new Set(
          injectionFindings
            .filter((f) => f.severity === 'critical' || f.severity === 'high')
            .map((f) => f.patternName),
        ),
      ].slice(0, 10);
      this.logger.debug('security.tools_suppressed_for_injection', { patterns });
    }

    // Relationship-aware compaction: preserve emotional content, promises, relationship facts.
    const maxContextTokens =
      this.options.maxContextTokens ?? config.engine.context.maxTokensDefault;
    const summarize = (input: string): Promise<string> =>
      this.summarizeForCompaction(effectiveMsg, usage, input);
    if (sessionStore) {
      await sessionStore.compactIfNeeded({
        chatId: effectiveMsg.chatId,
        maxTokens: maxContextTokens,
        personaReminder,
        summarize,
      });
    }

    const buildAndGenerate = async (): Promise<{ text?: string; reason?: string }> => {
      const excludeSourceMessageIds = messages.map((m) => String(m.messageId));
      const userMessagesForModel = messages.flatMap((m) => {
        const t = m.text.trim();
        const a = summarizeAttachmentsForUserText(m);
        const u = [t, a]
          .filter((s) => Boolean(s?.trim()))
          .join('\n')
          .trim();
        if (!u) return [];
        const content = effectiveMsg.isGroup
          ? renderGroupUserContent({
              authorDisplayName: m.authorDisplayName,
              authorId: m.authorId,
              content: u,
            })
          : u;
        return [{ role: 'user' as const, content }];
      });

      const ctx = await this.contextBuilder.buildReactiveModelContext({
        msg: effectiveMsg,
        excludeSourceMessageIds,
        query: userText,
        tools: suppressToolsForInjection ? undefined : tools,
        toolsForMessage: this.toolsForMessage.bind(this),
        toolGuidance: buildToolGuidance,
        identityPrompt,
        behaviorOverride,
      });

      return await this.generateDisciplinedReply({
        usage,
        msg: effectiveMsg,
        system: ctx.system,
        dataMessagesForModel: ctx.dataMessagesForModel,
        tools: ctx.toolsForModel,
        historyForModel: ctx.historyForModel,
        userMessages: userMessagesForModel,
        maxChars: ctx.maxChars,
        maxSteps: config.engine.generation.reactiveMaxSteps,
        maxRegens: config.engine.generation.maxRegens,
        identityAntiPatterns,
        observer,
        signal: turnSignal,
      });
    };

    let reply: { text?: string; reason?: string };
    try {
      reply = await buildAndGenerate();
    } catch (err) {
      if (this.isContextOverflowError(err) && sessionStore) {
        await sessionStore.compactIfNeeded({
          chatId: msg.chatId,
          maxTokens: maxContextTokens,
          personaReminder,
          summarize,
          force: true,
        });
        reply = await buildAndGenerate();
      } else {
        throw err;
      }
    }

    if (!reply.text) {
      const out: OutgoingAction = { kind: 'silence', reason: reply.reason ?? 'model_silence' };
      return { kind: 'final', action: out };
    }

    // Stale discard: if a newer message arrived mid-generation, do not react/send.
    if (this.isStale(effectiveMsg.chatId, seq)) {
      return { kind: 'final', action: { kind: 'silence', reason: 'stale_discard' } };
    }

    return {
      kind: 'draft_send_text',
      userText,
      draftText: reply.text,
    };
  }

  private async commitIncomingDraft(
    msg: IncomingMessage,
    seq: number,
    draft: Exclude<LockedIncomingResult, { kind: 'final' }>,
  ): Promise<OutgoingAction> {
    // Stale discard: if a newer message arrived while we were in the post-draft delay, skip commit.
    if (this.isStale(msg.chatId, seq)) return { kind: 'silence', reason: 'stale_discard' };

    if (draft.kind === 'draft_send_text') {
      return await this.persistAndReturnAction(msg, draft.userText, draft.draftText);
    }

    return await this.persistAndReturnReaction(msg, draft.userText, draft.emoji);
  }

  private isStale(chatId: ChatId, seq: number): boolean {
    const cur = this.responseSeq.get(String(chatId));
    if (cur === undefined) return false;
    return cur !== seq;
  }

  private evictResponseSeqIfNeeded(): void {
    if (this.responseSeq.size <= RESPONSE_SEQ_MAX_KEYS) return;
    const extra = this.responseSeq.size - RESPONSE_SEQ_MAX_KEYS;
    let removed = 0;
    for (const k of this.responseSeq.keys()) {
      this.responseSeq.delete(k);
      removed += 1;
      if (removed >= extra) break;
    }
  }

  private trackBackgroundBestEffort<T>(promise: Promise<T>, task: string): void {
    const tracker = this.options.trackBackground;
    if (!tracker) {
      void promise;
      return;
    }

    try {
      void tracker(promise).catch((err) => {
        this.logger.debug('background.track_failed', { task, ...errorFields(err) });
      });
    } catch (err) {
      this.logger.debug('background.track_threw', { task, ...errorFields(err) });
      void promise;
    }
  }

  private updateObservationsBestEffort(msg: IncomingMessage, responseText: string): void {
    const { memoryStore } = this.options;
    if (!memoryStore || msg.isGroup) return;

    const pid = asPersonId(`person:${channelUserId(msg)}`);
    const hourOfDay = new Date().getHours();

    const p = (async () => {
      const current = await memoryStore.getObservationCounters(pid);
      const updated = updateCounters(current, {
        responseLength: responseText.length,
        theirMessageLength: msg.text.length,
        hourOfDay,
        isNewConversation: current.sampleCount === 0,
      });
      await memoryStore.updateObservationCounters(pid, updated);
    })().catch((err) => {
      this.logger.debug('memory.observations_update_failed', errorFields(err));
    });

    this.trackBackgroundBestEffort(p, 'observations_update');
  }
  private async generateDisciplinedReply(options: {
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
    observer?: TurnStreamObserver | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<{ text?: string; reason?: string }> {
    const { backend } = this.options;
    const {
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
      observer,
      signal,
    } = options;

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
    const toolContext = {
      verifiedUrls,
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
              const runSignal = signal ?? this.options.signal;
              if (runSignal?.aborted) {
                const r = runSignal.reason;
                throw r instanceof Error ? r : new Error(String(r ?? 'Aborted'));
              }
              return await a.getBytes();
            },
          }
        : {}),
    };

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
    const runSignal = signal ?? this.options.signal;

    let attempt = 0;
    while (attempt <= maxRegens) {
      attempt += 1;
      await this.takeModelToken(msg.chatId);

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
      if (!text) return { reason: attempt > 1 ? 'model_silence_regen' : 'model_silence' };

      const clipped = enforceMaxLength(text, maxChars);
      const disciplined = msg.isGroup ? clipped.replace(/\s*\n+\s*/gu, ' ').trim() : clipped;
      const slopResult = checkSlop(clipped, identityAntiPatterns);
      if (!slopResult.isSlop) return { text: disciplined };
      if (attempt > maxRegens) break;

      const reasons = slopReasons(slopResult).join(', ');
      observer?.onMeta?.(
        `rewriting response for clarity (${reasons || 'friend-voice discipline'})`,
      );
      observer?.onReset?.();
      const regenSystem = [
        system,
        '',
        `Rewrite the reply to remove AI slop: ${reasons || 'unknown'}.`,
        'Be specific, casual, and human.',
        'Do not repeat the same phrasing.',
      ].join('\n');
      await this.takeModelToken(msg.chatId);
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
        toolContext,
        ...streamOpts,
      });
      usage.addCompletion(regen);

      const regenText = regen.text.trim();
      if (!regenText) return { reason: 'model_silence_regen' };
      const clippedRegen = enforceMaxLength(regenText, maxChars);
      const disciplinedRegen = msg.isGroup
        ? clippedRegen.replace(/\s*\n+\s*/gu, ' ').trim()
        : clippedRegen;
      const slop2 = checkSlop(clippedRegen, identityAntiPatterns);
      if (!slop2.isSlop) return { text: disciplinedRegen };
    }
    return { reason: 'slop_unresolved' };
  }

  private runExtractionBestEffort(
    msg: IncomingMessage,
    userText: string,
    assistantText?: string,
  ): void {
    const { memoryStore, extractor } = this.options;
    if (!memoryStore || !extractor) return;
    if (msg.isGroup && assistantText === undefined) return;

    const p = extractor
      .extractAndReconcile({
        msg,
        userText,
        ...(assistantText !== undefined ? { assistantText } : {}),
      })
      .catch((err: unknown) => {
        // Extraction failures are operational signals; never feed them back into
        // the model via lessons/context packs.
        this.logger.debug('memory.extractor_failed', errorFields(err));
      });

    this.trackBackgroundBestEffort(p, 'extract_and_reconcile');
  }

  private async maybeUpdateRelationshipScore(msg: IncomingMessage, nowMs: number): Promise<void> {
    const memoryStore = this.options.memoryStore;
    if (!memoryStore || msg.isGroup) return;
    try {
      const person = await memoryStore.getPersonByChannelId(channelUserId(msg));
      if (!person) return;
      const episodes = await memoryStore.countEpisodes(msg.chatId);
      const score = scoreFromSignals(episodes, nowMs - person.createdAtMs);
      if (score > (person.relationshipScore ?? 0)) {
        await memoryStore.updateRelationshipScore(person.id, score);
      }
    } catch (err) {
      this.logger.debug('memory.relationship_score_update_failed', errorFields(err));
    }
  }

  private async persistSilenceDecision(
    msg: IncomingMessage,
    userText: string,
    action: Extract<EngagementDecision, { kind: 'silence' }>,
  ): Promise<OutgoingAction> {
    const { memoryStore } = this.options;
    const nowMs = Date.now();

    if (memoryStore) {
      await memoryStore.logLesson({
        category: 'silence_decision',
        content: action.reason ?? 'silence',
        createdAtMs: nowMs,
      });
    }
    this.runExtractionBestEffort(msg, userText);
    return { kind: 'silence', reason: action.reason ?? 'silence' };
  }

  private async persistAndReturnReaction(
    msg: IncomingMessage,
    userText: string,
    emoji: string,
  ): Promise<OutgoingAction> {
    const { sessionStore, memoryStore } = this.options;
    const nowMs = Date.now();

    sessionStore?.appendMessage({
      chatId: msg.chatId,
      role: 'assistant',
      content: `[REACTION] ${emoji}`,
      createdAtMs: nowMs,
    });
    if (memoryStore) {
      const pid = asPersonId(`person:${channelUserId(msg)}`);
      await memoryStore.logEpisode({
        chatId: msg.chatId,
        personId: pid,
        isGroup: msg.isGroup,
        content: `USER: ${userText}\nFRIEND_REACTION: ${emoji}`,
        createdAtMs: nowMs,
      });
      await this.maybeUpdateRelationshipScore(msg, nowMs);
    }
    this.runExtractionBestEffort(msg, userText);
    return {
      kind: 'react',
      emoji,
      targetAuthorId: msg.authorId,
      targetTimestampMs: msg.timestampMs,
    };
  }

  private async persistAndReturnAction(
    msg: IncomingMessage,
    userText: string,
    draftText: string,
  ): Promise<OutgoingAction> {
    const { sessionStore, memoryStore } = this.options;
    const nowMs = Date.now();

    const action: OutgoingAction = { kind: 'send_text', text: draftText };

    sessionStore?.appendMessage({
      chatId: msg.chatId,
      role: 'assistant',
      content: action.text,
      createdAtMs: nowMs,
    });
    if (memoryStore) {
      const pid = asPersonId(`person:${channelUserId(msg)}`);
      await memoryStore.logEpisode({
        chatId: msg.chatId,
        personId: pid,
        isGroup: msg.isGroup,
        content: `USER: ${userText}\nFRIEND: ${action.text}`,
        createdAtMs: nowMs,
      });
      await this.maybeUpdateRelationshipScore(msg, nowMs);
    }
    this.updateObservationsBestEffort(msg, action.text);
    this.runExtractionBestEffort(msg, userText, action.text);
    const ttsHint = userRequestedVoiceNote(msg.text);
    return ttsHint ? { ...action, ttsHint } : action;
  }

  private async persistAndReturnProactiveAction(
    msg: IncomingMessage,
    event: ProactiveEvent,
    draftText: string,
    nowMs: number,
  ): Promise<OutgoingAction> {
    const { sessionStore, memoryStore } = this.options;

    const action: OutgoingAction = { kind: 'send_text', text: draftText };

    sessionStore?.appendMessage({
      chatId: msg.chatId,
      role: 'assistant',
      content: action.text,
      createdAtMs: nowMs,
    });
    if (memoryStore) {
      await memoryStore.logEpisode({
        chatId: msg.chatId,
        isGroup: msg.isGroup,
        content: `PROACTIVE_EVENT: ${event.kind} — ${event.subject}\nFRIEND: ${action.text}`,
        createdAtMs: nowMs,
      });
    }
    return action;
  }
}
