import { describeAttachmentForModel, sanitizeAttachmentsForSession } from '../agent/attachments.js';
import { PerKeyLock } from '../agent/lock.js';
import { channelUserId, type IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import { BehaviorEngine, type EngagementDecision } from '../behavior/engine.js';
import { sampleHumanDelayMs } from '../behavior/timing.js';
import { measureVelocity } from '../behavior/velocity.js';
import type { OpenhomieConfig } from '../config/types.js';
import type { MemoryExtractor } from '../memory/extractor.js';
import type { MemoryStore } from '../memory/store.js';
import { type ChatTrustTier, deriveTrustTierForPerson } from '../memory/types.js';
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
import { asPersonId } from '../types/ids.js';
import { errorFields, log, newCorrelationId, withLogContext } from '../util/logger.js';
import { PerKeyRateLimiter } from '../util/perKeyRateLimiter.js';
import { TokenBucket } from '../util/tokenBucket.js';
import type { AgentRuntimeWallet } from '../wallet/types.js';
import { MessageAccumulator } from './accumulator.js';
import { ContextBuilder, renderGroupUserContent } from './contextBuilder.js';
import { generateDisciplinedReply } from './generation.js';
import {
  type PersistenceDeps,
  persistAndReturnAction,
  persistAndReturnReaction,
  persistSilenceDecision,
} from './persistence.js';
import { handleProactiveEventLocked } from './proactive.js';
import {
  createUsageAcc,
  isContextOverflowError,
  type OutgoingAction,
  type TurnStreamObserver,
  type UsageAcc,
} from './types.js';

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

  private get persistenceDeps(): PersistenceDeps {
    return {
      sessionStore: this.options.sessionStore,
      memoryStore: this.options.memoryStore,
      extractor: this.options.extractor,
      logger: this.logger,
      trackBackground: this.options.trackBackground,
    };
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

        this.markIncomingSeen(incomingKey, nowMs);

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

        if (msg.isGroup) {
          const velocity = measureVelocity({
            sessionStore: this.options.sessionStore,
            chatId: msg.chatId,
          });
          if (velocity.isRapidDialogue) {
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
          const out = await this.lock.runExclusive(event.chatId, async () =>
            handleProactiveEventLocked(
              {
                config: this.options.config,
                memoryStore: this.options.memoryStore,
                tools: this.options.tools,
                contextBuilder: this.contextBuilder,
                logger: this.logger,
                eventScheduler: this.options.eventScheduler,
                persistenceDeps: this.persistenceDeps,
                backend: this.options.backend,
                sessionStore: this.options.sessionStore,
                maxContextTokens: this.options.maxContextTokens,
                signal: this.options.signal,
                toolsForMessage: this.toolsForMessage.bind(this),
                resolveTrustTier: this.resolveTrustTier.bind(this),
                takeModelToken: this.takeModelToken.bind(this),
                summarizeForCompaction: this.summarizeForCompaction.bind(this),
              },
              event,
              usage,
            ),
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

      const out = await persistSilenceDecision(
        this.persistenceDeps,
        effectiveMsg,
        userText,
        pre as Extract<EngagementDecision, { kind: 'silence' }>,
      );
      return { kind: 'final', action: out };
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
          ...(existing?.capsuleUpdatedAtMs
            ? { capsuleUpdatedAtMs: existing.capsuleUpdatedAtMs }
            : {}),
          ...(existing?.publicStyleCapsule
            ? { publicStyleCapsule: existing.publicStyleCapsule }
            : {}),
          createdAtMs: existing?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
        });
      } catch (err) {
        this.logger.debug('memory.track_person_failed', {
          channelUserId: cid,
          ...errorFields(err),
        });
      }
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

      return await generateDisciplinedReply({
        backend: this.options.backend,
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
        takeModelToken: this.takeModelToken.bind(this),
        engineSignal: this.options.signal,
      });
    };

    let reply: { text?: string; reason?: string };
    try {
      reply = await buildAndGenerate();
    } catch (err) {
      if (isContextOverflowError(err) && sessionStore) {
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
    if (this.isStale(msg.chatId, seq)) return { kind: 'silence', reason: 'stale_discard' };

    if (draft.kind === 'draft_send_text') {
      return await persistAndReturnAction(
        this.persistenceDeps,
        msg,
        draft.userText,
        draft.draftText,
      );
    }

    return await persistAndReturnReaction(this.persistenceDeps, msg, draft.userText, draft.emoji);
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
}
