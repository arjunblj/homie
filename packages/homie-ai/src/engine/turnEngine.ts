import { describeAttachmentForModel, sanitizeAttachmentsForSession } from '../agent/attachments.js';
import { PerKeyLock } from '../agent/lock.js';
import type { IncomingMessage } from '../agent/types.js';
import type { CompletionResult, LLMBackend, LLMUsage } from '../backend/types.js';
import { BehaviorEngine } from '../behavior/engine.js';
import { checkSlop, slopReasons } from '../behavior/slop.js';
import { parseChatId } from '../channels/chatId.js';
import type { HomieConfig } from '../config/types.js';
import type { MemoryExtractor } from '../memory/extractor.js';
import type { MemoryStore } from '../memory/store.js';
import type { RelationshipStage } from '../memory/types.js';
import type { EventScheduler } from '../proactive/scheduler.js';
import type { ProactiveEvent } from '../proactive/types.js';
import { buildPromptSkillsSection } from '../prompt-skills/loader.js';
import type { PromptSkillIndex } from '../prompt-skills/parse.js';
import type { SessionStore } from '../session/types.js';
import type { TelemetryStore } from '../telemetry/types.js';
import type { ToolDef } from '../tools/types.js';
import type { ChatId } from '../types/ids.js';
import { asMessageId, asPersonId } from '../types/ids.js';
import { assertNever } from '../util/assert-never.js';
import { errorFields, log, newCorrelationId, withLogContext } from '../util/logger.js';
import { PerKeyRateLimiter } from '../util/perKeyRateLimiter.js';
import { TokenBucket } from '../util/tokenBucket.js';
import { ContextBuilder } from './contextBuilder.js';
import type { OutgoingAction } from './types.js';

export interface SlopCheckResult {
  isSlop: boolean;
  reasons: string[];
}

export interface SlopDetector {
  check(text: string, msg: IncomingMessage): SlopCheckResult;
}

export interface TurnEngineOptions {
  config: HomieConfig;
  backend: LLMBackend;
  tools?: readonly ToolDef[] | undefined;
  promptSkills?: readonly PromptSkillIndex[] | undefined;
  slopDetector?: SlopDetector | undefined;
  sessionStore?: SessionStore | undefined;
  memoryStore?: MemoryStore | undefined;
  extractor?: MemoryExtractor | undefined;
  eventScheduler?: EventScheduler | undefined;
  maxContextTokens?: number | undefined;
  behaviorEngine?: BehaviorEngine | undefined;
  signal?: AbortSignal | undefined;
  trackBackground?: (<T>(promise: Promise<T>) => Promise<T>) | undefined;
  onSuccessfulTurn?: (() => void) | undefined;
  telemetry?: TelemetryStore | undefined;
}

const channelUserId = (msg: IncomingMessage): string => `${msg.channel}:${msg.authorId}`;

const summarizeAttachmentsForUserText = (msg: IncomingMessage): string => {
  const atts = msg.attachments ?? [];
  if (!atts.length) return '';
  return atts
    .map((a) => describeAttachmentForModel(a))
    .join('\n')
    .trim();
};

interface UsageAcc {
  llmCalls: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  };
  addCompletion(result: CompletionResult): void;
}

const createUsageAcc = (): UsageAcc => {
  const acc: UsageAcc = {
    llmCalls: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    addCompletion(result: CompletionResult): void {
      acc.llmCalls += 1;
      const u: LLMUsage | undefined = result.usage;
      if (!u) return;
      acc.usage.inputTokens += u.inputTokens ?? 0;
      acc.usage.outputTokens += u.outputTokens ?? 0;
      acc.usage.cacheReadTokens += u.cacheReadTokens ?? 0;
      acc.usage.cacheWriteTokens += u.cacheWriteTokens ?? 0;
      acc.usage.reasoningTokens += u.reasoningTokens ?? 0;
    },
  };
  return acc;
};

const STAGE_ORDER: readonly RelationshipStage[] = [
  'new',
  'acquaintance',
  'friend',
  'close',
] as const;
const stageRank = (s: RelationshipStage): number => STAGE_ORDER.indexOf(s);

const promoteStageFromSignals = (
  current: RelationshipStage,
  episodes: number,
  ageMs: number,
): RelationshipStage => {
  const e = Math.max(0, Math.floor(episodes));
  const days = ageMs / (24 * 60 * 60_000);

  // Deliberately conservative: early users can always promote manually later, but proactive gating
  // should be hard to accidentally unlock.
  let desired: RelationshipStage = 'new';
  if (e >= 60 && days >= 14) desired = 'close';
  else if (e >= 15 && days >= 3) desired = 'friend';
  else if (e >= 3) desired = 'acquaintance';

  return stageRank(desired) > stageRank(current) ? desired : current;
};

const INCOMING_MESSAGE_DEDUPE_TTL_MS = 10 * 60_000;
const INCOMING_MESSAGE_DEDUPE_MAX_KEYS = 10_000;

export class TurnEngine {
  private readonly logger = log.child({ component: 'turn_engine' });
  private readonly lock = new PerKeyLock<ChatId>();
  private readonly globalLimiter: TokenBucket;
  private readonly perChatLimiter: PerKeyRateLimiter<ChatId>;
  private readonly slop: SlopDetector;
  private readonly behavior: BehaviorEngine;
  private readonly contextBuilder: ContextBuilder;
  private readonly seenIncoming = new Map<string, number>();

  public constructor(private readonly options: TurnEngineOptions) {
    this.globalLimiter = new TokenBucket(options.config.engine.limiter);
    this.perChatLimiter = new PerKeyRateLimiter<ChatId>(options.config.engine.perChatLimiter);

    this.slop =
      options.slopDetector ??
      ({
        check: (text: string) => {
          const r = checkSlop(text);
          return { isSlop: r.isSlop, reasons: slopReasons(r) };
        },
      } satisfies SlopDetector);

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
    });
  }

  public async handleIncomingMessage(msg: IncomingMessage): Promise<OutgoingAction> {
    const started = Date.now();
    const turnId = newCorrelationId();
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
        if (this.options.signal?.aborted) {
          return { kind: 'silence', reason: 'shutting_down' };
        }
        this.logger.info('turn.start', {
          isGroup: msg.isGroup,
          isOperator: msg.isOperator,
          textLen: msg.text.length,
        });
        try {
          const out = await this.lock.runExclusive(msg.chatId, async () =>
            this.handleIncomingMessageLocked(msg, usage),
          );
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

  private toolGuidance(tools: readonly ToolDef[] | undefined): string {
    const lines =
      tools
        ?.map((t) => (t.guidance ? `- ${t.name}: ${t.guidance.trim()}` : ''))
        .filter((s) => Boolean(s.trim())) ?? [];
    if (lines.length === 0) return '';
    return ['=== TOOL GUIDANCE ===', ...lines].join('\n');
  }

  private toolsForMessage(
    msg: IncomingMessage,
    tools: readonly ToolDef[] | undefined,
  ): readonly ToolDef[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    const allowRestricted =
      msg.isOperator && Boolean(this.options.config.tools.restricted.enabledForOperator);
    const allowDangerous =
      msg.isOperator && Boolean(this.options.config.tools.dangerous.enabledForOperator);

    const restrictedAllow = new Set(this.options.config.tools.restricted.allowlist);
    const dangerousAllow = new Set(this.options.config.tools.dangerous.allowlist);
    const dangerousAllowAll = Boolean(this.options.config.tools.dangerous.allowAll);

    const out = tools.filter((t) => {
      if (t.tier === 'safe') return true;
      if (t.tier === 'restricted') {
        if (!allowRestricted) return false;
        if (restrictedAllow.size === 0) return true;
        return restrictedAllow.has(t.name);
      }
      if (t.tier === 'dangerous') {
        if (!allowDangerous) return false;
        if (dangerousAllowAll) return true;
        return dangerousAllow.has(t.name);
      }
      return false;
    });
    return out.length ? out : undefined;
  }

  private isContextOverflowError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /context(\s|_)?(length|window)|prompt is too long|too many tokens|max tokens/i.test(msg);
  }

  private inferRecipientMessage(event: ProactiveEvent): IncomingMessage | null {
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
  }

  private async handleProactiveEventLocked(
    event: ProactiveEvent,
    usage: UsageAcc,
  ): Promise<OutgoingAction> {
    // Proactive is currently DM-only. If we can't infer a recipient identity, skip safely.
    const msg = this.inferRecipientMessage(event);
    if (!msg) return { kind: 'silence', reason: 'proactive_unroutable' };

    const { config, backend, tools, sessionStore, memoryStore } = this.options;
    const nowMs = Date.now();

    const { identityPrompt, personaReminder } = await this.contextBuilder.buildIdentityContext();

    // Relationship-aware compaction still applies (no new user message is appended).
    const maxContextTokens =
      this.options.maxContextTokens ?? config.engine.context.maxTokensDefault;
    const summarize = async (input: string): Promise<string> => {
      const summarySystem = [
        'Summarize the conversation so far for a FRIEND agent.',
        'Preserve: emotional content, promises/commitments, durable relationship facts, inside jokes.',
        'Discard: redundant greetings, mechanical details, and anything already captured as facts.',
        'Return a concise summary (no bullet lists unless necessary).',
      ].join('\n');

      await this.takeModelToken(msg.chatId);
      const res = await backend.complete({
        role: 'fast',
        maxSteps: 2,
        messages: [
          { role: 'system', content: summarySystem },
          { role: 'user', content: input },
        ],
        signal: this.options.signal,
      });
      usage.addCompletion(res);
      return res.text;
    };
    if (sessionStore) {
      await sessionStore.compactIfNeeded({
        chatId: msg.chatId,
        maxTokens: maxContextTokens,
        personaReminder,
        summarize,
      });
    }

    if (memoryStore) {
      const person = await memoryStore.getPersonByChannelId(channelUserId(msg));
      const stage = person?.relationshipStage ?? 'new';
      if (
        (stage === 'new' || stage === 'acquaintance') &&
        event.kind !== 'reminder' &&
        event.kind !== 'birthday'
      ) {
        return { kind: 'silence', reason: 'proactive_relationship_too_new' };
      }
    }

    const buildAndGenerate = async (): Promise<{ text?: string; reason?: string }> => {
      const ctx = await this.contextBuilder.buildProactiveModelContext({
        msg,
        event,
        tools,
        toolsForMessage: this.toolsForMessage.bind(this),
        toolGuidance: this.toolGuidance.bind(this),
        identityPrompt,
      });

      return await this.generateDisciplinedReply({
        usage,
        msg,
        baseSystem: ctx.baseSystem,
        tools: ctx.toolsForModel,
        historyForModel: ctx.historyForModel,
        userText: 'Send the proactive message now.',
        maxChars: ctx.maxChars,
        maxSteps: config.engine.generation.proactiveMaxSteps,
        maxRegens: config.engine.generation.maxRegens,
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

  private async handleIncomingMessageLocked(
    msg: IncomingMessage,
    usage: UsageAcc,
  ): Promise<OutgoingAction> {
    const { config, backend, tools, sessionStore, memoryStore } = this.options;

    const text = msg.text.trim();
    const attSummary = summarizeAttachmentsForUserText(msg);
    const userText = [text, attSummary]
      .filter((s) => Boolean(s?.trim()))
      .join('\n')
      .trim();
    if (!userText) return { kind: 'silence', reason: 'empty_input' };

    const nowMs = Date.now();
    const incomingKey = this.incomingDedupeKey(msg);
    if (this.isDuplicateIncoming(incomingKey, nowMs)) {
      this.logger.debug('turn.duplicate_message');
      return { kind: 'silence', reason: 'duplicate_message' };
    }

    const { identityPrompt, personaReminder } = await this.contextBuilder.buildIdentityContext();

    // Persist the user's message before the LLM call. If the process crashes mid-turn,
    // we still keep continuity for the next run.
    sessionStore?.appendMessage({
      chatId: msg.chatId,
      role: 'user',
      content: userText,
      createdAtMs: nowMs,
      authorId: msg.authorId,
      authorDisplayName: msg.authorDisplayName,
      sourceMessageId: String(msg.messageId),
      attachments: sanitizeAttachmentsForSession(msg.attachments),
    });
    this.options.eventScheduler?.markProactiveResponded(msg.chatId);

    if (memoryStore) {
      const cid = channelUserId(msg);
      try {
        const existing = await memoryStore.getPersonByChannelId(cid);
        await memoryStore.trackPerson({
          id: existing?.id ?? asPersonId(`person:${cid}`),
          displayName: msg.authorDisplayName ?? msg.authorId,
          channel: msg.channel,
          channelUserId: cid,
          relationshipStage: existing?.relationshipStage ?? 'new',
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

    // Relationship-aware compaction: preserve emotional content, promises, relationship facts.
    const maxContextTokens =
      this.options.maxContextTokens ?? config.engine.context.maxTokensDefault;
    const summarize = async (input: string): Promise<string> => {
      const summarySystem = [
        'Summarize the conversation so far for a FRIEND agent.',
        'Preserve: emotional content, promises/commitments, durable relationship facts, inside jokes.',
        'Discard: redundant greetings, mechanical details, and anything already captured as facts.',
        'Return a concise summary (no bullet lists unless necessary).',
      ].join('\n');

      await this.takeModelToken(msg.chatId);
      const res = await backend.complete({
        role: 'fast',
        maxSteps: 2,
        messages: [
          { role: 'system', content: summarySystem },
          { role: 'user', content: input },
        ],
        signal: this.options.signal,
      });
      usage.addCompletion(res);
      return res.text;
    };
    if (sessionStore) {
      await sessionStore.compactIfNeeded({
        chatId: msg.chatId,
        maxTokens: maxContextTokens,
        personaReminder,
        summarize,
      });
    }

    const buildAndGenerate = async (): Promise<{ text?: string; reason?: string }> => {
      const ctx = await this.contextBuilder.buildReactiveModelContext({
        msg,
        userText,
        tools,
        toolsForMessage: this.toolsForMessage.bind(this),
        toolGuidance: this.toolGuidance.bind(this),
        identityPrompt,
      });

      return await this.generateDisciplinedReply({
        usage,
        msg,
        baseSystem: ctx.baseSystem,
        tools: ctx.toolsForModel,
        historyForModel: ctx.historyForModel,
        userText,
        maxChars: ctx.maxChars,
        maxSteps: config.engine.generation.reactiveMaxSteps,
        maxRegens: config.engine.generation.maxRegens,
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
      this.markIncomingSeen(incomingKey, nowMs);
      return out;
    }

    const out = await this.persistAndReturnAction(msg, userText, reply.text, usage);
    this.markIncomingSeen(incomingKey, nowMs);
    return out;
  }

  private async generateDisciplinedReply(options: {
    usage: UsageAcc;
    msg: IncomingMessage;
    baseSystem: string;
    tools: readonly ToolDef[] | undefined;
    historyForModel: Array<{ role: 'user' | 'assistant'; content: string }>;
    userText: string;
    maxChars: number;
    maxSteps: number;
    maxRegens: number;
  }): Promise<{ text?: string; reason?: string }> {
    const { backend } = this.options;
    const {
      usage,
      msg,
      baseSystem,
      tools,
      historyForModel,
      userText,
      maxChars,
      maxSteps,
      maxRegens,
    } = options;

    let attempt = 0;
    while (attempt <= maxRegens) {
      attempt += 1;
      await this.takeModelToken(msg.chatId);

      const result = await backend.complete({
        role: 'default',
        maxSteps,
        tools,
        messages: [
          { role: 'system', content: baseSystem },
          ...historyForModel,
          { role: 'user', content: userText },
        ],
        signal: this.options.signal,
      });
      usage.addCompletion(result);

      const text = result.text.trim();
      if (!text) return { reason: attempt > 1 ? 'model_silence_regen' : 'model_silence' };

      const clipped = text.length > maxChars ? text.slice(0, maxChars).trimEnd() : text;
      const disciplined = msg.isGroup ? clipped.replace(/\s*\n+\s*/gu, ' ').trim() : clipped;
      const slopResult = this.slop.check(clipped, msg);
      if (!slopResult.isSlop) return { text: disciplined };
      if (attempt > maxRegens) break;

      const reasons = slopResult.reasons.join(', ');
      const regenSystem = [
        baseSystem,
        '',
        // Keep this exact phrase stable: tests and downstream harnesses key off it.
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
          ...historyForModel,
          { role: 'user', content: userText },
          { role: 'assistant', content: clipped },
          { role: 'user', content: 'Rewrite your last message with a natural friend voice.' },
        ],
        signal: this.options.signal,
      });
      usage.addCompletion(regen);

      const regenText = regen.text.trim();
      if (!regenText) return { reason: 'model_silence_regen' };
      const clippedRegen =
        regenText.length > maxChars ? regenText.slice(0, maxChars).trimEnd() : regenText;
      const disciplinedRegen = msg.isGroup
        ? clippedRegen.replace(/\s*\n+\s*/gu, ' ').trim()
        : clippedRegen;
      const slop2 = this.slop.check(clippedRegen, msg);
      if (!slop2.isSlop) return { text: disciplinedRegen };
      break;
    }
    return { reason: 'slop_unresolved' };
  }

  private async persistAndReturnAction(
    msg: IncomingMessage,
    userText: string,
    draftText: string,
    usage: UsageAcc,
  ): Promise<OutgoingAction> {
    const { sessionStore, memoryStore } = this.options;
    const nowMs = Date.now();

    const action = await this.behavior.decide(msg, draftText, {
      signal: this.options.signal,
      onCompletion: (res) => usage.addCompletion(res),
    });

    const runExtraction = (assistantText?: string): void => {
      if (!memoryStore || !this.options.extractor) return;
      if (msg.isGroup && assistantText === undefined) return;

      const p = this.options.extractor
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

      if (this.options.trackBackground) {
        void this.options.trackBackground(p);
      } else {
        void p;
      }
    };

    const maybePromoteRelationshipStage = async (): Promise<void> => {
      if (!memoryStore || msg.isGroup) return;
      try {
        const person = await memoryStore.getPersonByChannelId(channelUserId(msg));
        if (!person) return;
        const episodes = await memoryStore.countEpisodes(msg.chatId);
        const next = promoteStageFromSignals(
          person.relationshipStage,
          episodes,
          nowMs - person.createdAtMs,
        );
        if (next !== person.relationshipStage) {
          await memoryStore.updateRelationshipStage(person.id, next);
        }
      } catch (err) {
        // Best-effort; never block a turn due to bookkeeping.
        this.logger.debug('memory.relationship_promotion_failed', errorFields(err));
      }
    };

    switch (action.kind) {
      case 'send_text': {
        sessionStore?.appendMessage({
          chatId: msg.chatId,
          role: 'assistant',
          content: action.text,
          createdAtMs: nowMs,
        });
        if (memoryStore) {
          await memoryStore.logEpisode({
            chatId: msg.chatId,
            content: `USER: ${userText}\nFRIEND: ${action.text}`,
            createdAtMs: nowMs,
          });
          await maybePromoteRelationshipStage();
        }
        runExtraction(action.text);
        return action;
      }
      case 'react': {
        sessionStore?.appendMessage({
          chatId: msg.chatId,
          role: 'assistant',
          content: `[REACTION] ${action.emoji}`,
          createdAtMs: nowMs,
        });
        if (memoryStore) {
          await memoryStore.logEpisode({
            chatId: msg.chatId,
            content: `USER: ${userText}\nFRIEND_REACTION: ${action.emoji}`,
            createdAtMs: nowMs,
          });
          await maybePromoteRelationshipStage();
        }
        runExtraction();
        return action;
      }
      case 'silence': {
        if (memoryStore) {
          await memoryStore.logLesson({
            category: 'silence_decision',
            content: action.reason ?? 'silence',
            createdAtMs: nowMs,
          });
        }
        runExtraction();
        return action;
      }
      default:
        assertNever(action);
    }
  }

  private async persistAndReturnProactiveAction(
    msg: IncomingMessage,
    event: ProactiveEvent,
    draftText: string,
    nowMs: number,
  ): Promise<OutgoingAction> {
    const { sessionStore, memoryStore } = this.options;

    const action = await this.behavior.decide(msg, draftText);

    switch (action.kind) {
      case 'send_text': {
        sessionStore?.appendMessage({
          chatId: msg.chatId,
          role: 'assistant',
          content: action.text,
          createdAtMs: nowMs,
        });
        if (memoryStore) {
          await memoryStore.logEpisode({
            chatId: msg.chatId,
            content: `PROACTIVE_EVENT: ${event.kind} — ${event.subject}\nFRIEND: ${action.text}`,
            createdAtMs: nowMs,
          });
        }
        return action;
      }
      case 'silence':
      case 'react':
        // Proactive should not react; treat as silence-equivalent.
        return {
          kind: 'silence',
          reason:
            action.kind === 'react'
              ? 'proactive_react_suppressed'
              : (action.reason ?? 'proactive_silence'),
        };
      default:
        assertNever(action);
    }
  }
}
