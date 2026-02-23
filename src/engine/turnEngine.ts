import { describeAttachmentForModel, sanitizeAttachmentsForSession } from '../agent/attachments.js';
import { PerKeyLock } from '../agent/lock.js';
import { channelUserId, type IncomingMessage } from '../agent/types.js';
import type { LLMBackend, LLMContent } from '../backend/types.js';
import { BehaviorEngine, type EngagementDecision } from '../behavior/engine.js';
import { gateOutgoingText } from '../behavior/qualityGate.js';
import { sampleHumanDelayMs } from '../behavior/timing.js';
import { measureVelocity } from '../behavior/velocity.js';
import type { OpenhomieConfig } from '../config/types.js';
import type { HookRegistry } from '../hooks/registry.js';
import type { MemoryExtractor } from '../memory/extractor.js';
import type { MemoryStore } from '../memory/store.js';
import { type ChatTrustTier, deriveTrustTierForPerson } from '../memory/types.js';
import type { EventScheduler } from '../proactive/scheduler.js';
import type { ProactiveEvent } from '../proactive/types.js';
import { buildPromptSkillsSection } from '../prompt-skills/loader.js';
import type { PromptSkillIndex } from '../prompt-skills/parse.js';
import { scanPromptInjection } from '../security/contentSanitizer.js';
import type { OutboundLedger } from '../session/outbound-ledger.js';
import type { SessionStore } from '../session/types.js';
import type { TelemetryStore } from '../telemetry/types.js';
import { buildToolGuidance, filterToolsForMessage } from '../tools/policy.js';
import type { ToolDef, ToolMediaAttachment } from '../tools/types.js';
import type { ChatId } from '../types/ids.js';
import { asPersonId } from '../types/ids.js';
import { errorFields, log, newCorrelationId, withLogContext } from '../util/logger.js';
import { PerKeyRateLimiter } from '../util/perKeyRateLimiter.js';
import { TokenBucket } from '../util/tokenBucket.js';
import type { AgentRuntimeWallet } from '../wallet/types.js';
import { MessageAccumulator } from './accumulator.js';
import {
  type BuiltModelContext,
  ContextBuilder,
  renderGroupUserContent,
} from './contextBuilder.js';
import { generateDisciplinedReply } from './generation.js';
import {
  type PersistenceDeps,
  persistAndReturnAction,
  persistAndReturnReaction,
  persistInboundEpisodeBestEffort,
  persistSilenceDecision,
} from './persistence.js';
import { handleProactiveEventLocked } from './proactive.js';
import { buildScratchpadDataMessage } from './scratchpadContext.js';
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
  hooks?: HookRegistry | undefined;
  telemetry?: TelemetryStore | undefined;
  outboundLedger?: OutboundLedger | undefined;
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
  | { kind: 'final'; incomingMessages: IncomingMessage[]; userText: string; action: OutgoingAction }
  | {
      kind: 'draft_send_text';
      incomingMessages: IncomingMessage[];
      userText: string;
      draftText: string;
      media?: readonly ToolMediaAttachment[] | undefined;
    }
  | {
      kind: 'draft_react';
      incomingMessages: IncomingMessage[];
      userText: string;
      emoji: string;
    };

const INCOMING_MESSAGE_DEDUPE_TTL_MS = 10 * 60_000;
const INCOMING_MESSAGE_DEDUPE_MAX_KEYS = 10_000;
const RESPONSE_SEQ_MAX_KEYS = 10_000;
const KNOWN_CHAT_MAX_KEYS = 10_000;

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
  private readonly knownChats = new Set<ChatId>();

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
      outboundLedger: options.outboundLedger,
      ...(promptSkillsSection ? { promptSkillsSection } : {}),
      hasChannelsConfigured: options.hasChannelsConfigured,
      agentRuntimeWallet: options.agentRuntimeWallet,
    });

    this.accumulator = options.accumulator ?? new MessageAccumulator();
  }

  public getKnownChatIds(): ChatId[] {
    return [...this.knownChats];
  }

  private trackKnownChat(chatId: ChatId): void {
    this.knownChats.add(chatId);
    if (this.knownChats.size <= KNOWN_CHAT_MAX_KEYS) return;
    const extra = this.knownChats.size - KNOWN_CHAT_MAX_KEYS;
    let removed = 0;
    for (const id of this.knownChats) {
      this.knownChats.delete(id);
      removed += 1;
      if (removed >= extra) break;
    }
  }

  private get persistenceDeps(): PersistenceDeps {
    return {
      sessionStore: this.options.sessionStore,
      memoryStore: this.options.memoryStore,
      extractor: this.options.extractor,
      outboundLedger: this.options.outboundLedger,
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
    this.trackKnownChat(msg.chatId);
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
        persistInboundEpisodeBestEffort(this.persistenceDeps, msg, userText);
        // Best-effort: if we recently sent something and they replied, mark it.
        try {
          this.options.outboundLedger?.markGotReply({ chatId: msg.chatId, atMs: msg.timestampMs });
        } catch (err) {
          this.logger.debug('outbound_ledger.markGotReply_failed', errorFields(err));
        }
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
            this.handleIncomingMessageLockedDraft(msg, usage, nextSeq, turnId, observer, runSignal),
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
          const hooks = this.options.hooks;
          if (hooks) {
            const responseText = out.kind === 'send_text' ? out.text : undefined;
            await hooks.emit('onTurnComplete', {
              chatId: msg.chatId,
              action: out,
              userText: locked.userText,
              ...(responseText ? { responseText } : {}),
              isGroup: msg.isGroup,
              incomingMessages: locked.incomingMessages,
            });
          }
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
          const hooks = this.options.hooks;
          if (hooks) {
            const error = err instanceof Error ? err : new Error(String(err));
            await hooks.emit('onError', { chatId: msg.chatId, error });
          }
          throw err;
        }
      },
    );
  }

  public async handleProactiveEvent(event: ProactiveEvent): Promise<OutgoingAction> {
    this.trackKnownChat(event.chatId);
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
          const res = await this.lock.runExclusive(event.chatId, async () =>
            handleProactiveEventLocked(
              {
                turnId,
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
                hooks: this.options.hooks,
                telemetry: this.options.telemetry,
                toolsForMessage: this.toolsForMessage.bind(this),
                resolveTrustTier: this.resolveTrustTier.bind(this),
                takeModelToken: this.takeModelToken.bind(this),
                summarizeForCompaction: this.summarizeForCompaction.bind(this),
              },
              event,
              usage,
            ),
          );
          const out = res.action;
          const hooks = this.options.hooks;
          if (hooks) {
            await hooks.emit('onTurnComplete', {
              chatId: event.chatId,
              action: out,
              userText: res.userText,
              ...(res.responseText ? { responseText: res.responseText } : {}),
              isGroup: res.isGroup,
            });
          }
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
          const hooks = this.options.hooks;
          if (hooks) {
            const error = err instanceof Error ? err : new Error(String(err));
            await hooks.emit('onError', { chatId: event.chatId, error });
          }
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
    turnId: string,
    observer?: TurnStreamObserver,
    turnSignal?: AbortSignal | undefined,
  ): Promise<LockedIncomingResult> {
    const { config, tools, sessionStore, memoryStore } = this.options;
    const nowMs = Date.now();

    if (this.isStale(msg.chatId, seq)) {
      return {
        kind: 'final',
        incomingMessages: [msg],
        userText: msg.text,
        action: { kind: 'silence', reason: 'stale_discard' },
      };
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
      return {
        kind: 'final',
        incomingMessages: messages,
        userText: '',
        action: { kind: 'silence', reason: 'empty_input' },
      };
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
          incomingMessages: messages,
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
      return { kind: 'final', incomingMessages: messages, userText, action: out };
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

    const trustTier = await this.resolveTrustTier(effectiveMsg);
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
      const hooks = this.options.hooks;
      await sessionStore.compactIfNeeded({
        chatId: effectiveMsg.chatId,
        maxTokens: maxContextTokens,
        personaReminder,
        summarize,
        onCompaction: async (ctx) => {
          try {
            sessionStore.upsertNote({
              chatId: ctx.chatId,
              key: 'notes.last_compaction_summary',
              content: ctx.summary,
              nowMs: Date.now(),
            });
          } catch (err) {
            this.logger.debug('session.write_compaction_note_failed', errorFields(err));
          }
          if (hooks) await hooks.emit('onSessionCompacted', ctx);
        },
      });
    }

    let lastContextTelemetry: BuiltModelContext['contextTelemetry'] | undefined;
    let lastMaxChars = effectiveMsg.isGroup
      ? config.behavior.groupMaxChars
      : config.behavior.dmMaxChars;
    const buildAndGenerate = async (): Promise<{
      text?: string;
      reason?: string;
      toolOutput?: { tokensUsed: number; toolCalls: number; truncatedCount: number };
    }> => {
      const excludeSourceMessageIds = messages.map((m) => String(m.messageId));
      const userMessagesForModel: Array<{ role: 'user'; content: LLMContent }> = [];
      for (const m of messages) {
        const t = m.text.trim();
        const a = summarizeAttachmentsForUserText(m);
        const u = [t, a]
          .filter((s) => Boolean(s?.trim()))
          .join('\n')
          .trim();
        if (!u) continue;
        const contentText = effectiveMsg.isGroup
          ? renderGroupUserContent({
              authorDisplayName: m.authorDisplayName,
              authorId: m.authorId,
              content: u,
            })
          : u;

        const maxImageBytes = 5 * 1024 * 1024;
        const imageParts: Array<{
          type: 'image';
          image: Uint8Array;
          mediaType?: string | undefined;
        }> = [];
        for (const att of m.attachments ?? []) {
          if (att.kind !== 'image') continue;
          if (!att.getBytes) continue;
          if (typeof att.sizeBytes === 'number' && att.sizeBytes > maxImageBytes) continue;
          try {
            const bytes = await att.getBytes();
            if (bytes.byteLength <= 0 || bytes.byteLength > maxImageBytes) continue;
            imageParts.push({
              type: 'image',
              image: bytes,
              ...(att.mime ? { mediaType: att.mime } : {}),
            });
          } catch (_err) {
            // Fall back to text-only (attachment is already summarized in `a`).
          }
        }

        const content: LLMContent =
          imageParts.length > 0
            ? [{ type: 'text', text: contentText }, ...imageParts]
            : contentText;
        userMessagesForModel.push({ role: 'user', content });
      }

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
      lastContextTelemetry = ctx.contextTelemetry;
      lastMaxChars = ctx.maxChars;
      const scratchpadMsg = buildScratchpadDataMessage({
        sessionStore,
        chatId: effectiveMsg.chatId,
      });
      const dataMessagesForModel = scratchpadMsg
        ? [scratchpadMsg, ...ctx.dataMessagesForModel]
        : ctx.dataMessagesForModel;

      const hooks = this.options.hooks;
      if (hooks) {
        const sessionMsgs =
          sessionStore?.getMessages(effectiveMsg.chatId, config.engine.session.fetchLimit) ?? [];
        await hooks.emit('onBeforeGenerate', {
          chatId: effectiveMsg.chatId,
          messages: sessionMsgs,
          isGroup: effectiveMsg.isGroup,
        });
      }

      return await generateDisciplinedReply({
        backend: this.options.backend,
        usage,
        msg: effectiveMsg,
        system: ctx.system,
        dataMessagesForModel,
        tools: ctx.toolsForModel,
        historyForModel: ctx.historyForModel,
        userMessages: userMessagesForModel,
        maxChars: ctx.maxChars,
        maxSteps: config.engine.generation.reactiveMaxSteps,
        maxRegens: config.engine.generation.maxRegens,
        identityAntiPatterns,
        toolServices: { memoryStore, sessionStore },
        observer,
        signal: turnSignal,
        takeModelToken: this.takeModelToken.bind(this),
        engineSignal: this.options.signal,
      });
    };

    let reply: {
      text?: string;
      reason?: string;
      toolOutput?: { tokensUsed: number; toolCalls: number; truncatedCount: number };
      media?: readonly ToolMediaAttachment[] | undefined;
    };
    try {
      reply = await buildAndGenerate();
    } catch (err) {
      if (isContextOverflowError(err) && sessionStore) {
        const hooks = this.options.hooks;
        await sessionStore.compactIfNeeded({
          chatId: msg.chatId,
          maxTokens: maxContextTokens,
          personaReminder,
          summarize,
          force: true,
          onCompaction: async (ctx) => {
            try {
              sessionStore.upsertNote({
                chatId: ctx.chatId,
                key: 'notes.last_compaction_summary',
                content: ctx.summary,
                nowMs: Date.now(),
              });
            } catch (err2) {
              this.logger.debug('session.write_compaction_note_failed', errorFields(err2));
            }
            if (hooks) await hooks.emit('onSessionCompacted', ctx);
          },
        });
        reply = await buildAndGenerate();
      } else {
        throw err;
      }
    }

    try {
      if (lastContextTelemetry) {
        this.options.telemetry?.logContextComposition({
          turnId,
          kind: 'incoming',
          chatId: String(effectiveMsg.chatId),
          isGroup: effectiveMsg.isGroup,
          trustTier,
          createdAtMs: Date.now(),
          systemTokens: lastContextTelemetry.systemTokens,
          identityTokens: lastContextTelemetry.identityTokens,
          sessionNotesTokens: lastContextTelemetry.sessionNotesTokens,
          memoryTokens: lastContextTelemetry.memoryTokens,
          outboundLedgerTokens: lastContextTelemetry.outboundLedgerTokens,
          toolOutputTokens: reply.toolOutput?.tokensUsed ?? 0,
          toolOutputToolCalls: reply.toolOutput?.toolCalls ?? 0,
          toolOutputTruncatedCount: reply.toolOutput?.truncatedCount ?? 0,
          memorySkipped: lastContextTelemetry.memorySkipped,
        });
      }
    } catch (err) {
      this.logger.debug('telemetry.logContextComposition_failed', errorFields(err));
    }

    if (!reply.text) {
      const out: OutgoingAction = { kind: 'silence', reason: reply.reason ?? 'model_silence' };
      return { kind: 'final', incomingMessages: messages, userText, action: out };
    }

    // Always-on outbound quality gate (bounded).
    // If the gate rewrites the message, drop any generated media to avoid mismatch.
    {
      const recordUsage = (r: {
        usage?: import('../backend/types.js').LLMUsage;
        modelId?: string;
      }) => {
        usage.addCompletion({
          text: '',
          steps: [],
          ...(r.modelId ? { modelId: r.modelId } : {}),
          usage: r.usage,
        });
      };
      const gated = await gateOutgoingText({
        backend: this.options.backend,
        kind: 'reactive',
        draft: reply.text,
        maxChars: lastMaxChars,
        isGroup: effectiveMsg.isGroup,
        identityAntiPatterns,
        userTextHint: userText,
        signal: turnSignal,
        takeModelToken: async () => await this.takeModelToken(effectiveMsg.chatId),
        recordUsage,
      });
      if (!gated.text) {
        const out: OutgoingAction = { kind: 'silence', reason: gated.reason ?? 'quality_gate' };
        return { kind: 'final', incomingMessages: messages, userText, action: out };
      }
      if (gated.attemptedRewrite) reply = { ...reply, text: gated.text, media: undefined };
      else reply = { ...reply, text: gated.text };
    }

    if (this.isStale(effectiveMsg.chatId, seq)) {
      return {
        kind: 'final',
        incomingMessages: messages,
        userText,
        action: { kind: 'silence', reason: 'stale_discard' },
      };
    }

    const finalText = reply.text;
    if (!finalText) {
      return {
        kind: 'final',
        incomingMessages: messages,
        userText,
        action: { kind: 'silence', reason: 'model_silence' },
      };
    }

    return {
      kind: 'draft_send_text',
      incomingMessages: messages,
      userText,
      draftText: finalText,
      ...(reply.media?.length ? { media: reply.media } : {}),
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
        draft.media,
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
