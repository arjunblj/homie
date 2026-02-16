import { PerKeyLock } from '../agent/lock.js';
import type { IncomingMessage } from '../agent/types.js';
import type { LLMBackend } from '../backend/types.js';
import { BehaviorEngine } from '../behavior/engine.js';
import { checkSlop, slopReasons } from '../behavior/slop.js';
import type { HomieConfig } from '../config/types.js';
import { loadIdentityPackage } from '../identity/load.js';
import { formatPersonaReminder } from '../identity/personality.js';
import { composeIdentityPrompt } from '../identity/prompt.js';
import { assembleMemoryContext } from '../memory/context-pack.js';
import type { Embedder } from '../memory/embeddings.js';
import type { MemoryExtractor } from '../memory/extractor.js';
import type { MemoryStore } from '../memory/store.js';
import type { EventScheduler } from '../proactive/scheduler.js';
import type { ProactiveEvent } from '../proactive/types.js';
import type { SessionStore } from '../session/types.js';
import type { ToolDef } from '../tools/types.js';
import type { ChatId } from '../types/ids.js';
import { asMessageId, asPersonId } from '../types/ids.js';
import { assertNever } from '../util/assert-never.js';
import { TokenBucket } from '../util/tokenBucket.js';
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
  slopDetector?: SlopDetector | undefined;
  sessionStore?: SessionStore | undefined;
  memoryStore?: MemoryStore | undefined;
  extractor?: MemoryExtractor | undefined;
  embedder?: Embedder | undefined;
  eventScheduler?: EventScheduler | undefined;
  maxContextTokens?: number | undefined;
  behaviorEngine?: BehaviorEngine | undefined;
}

const channelUserId = (msg: IncomingMessage): string => `${msg.channel}:${msg.authorId}`;

export class TurnEngine {
  private readonly lock = new PerKeyLock<ChatId>();
  private readonly limiter = new TokenBucket({ capacity: 3, refillPerSecond: 1 });
  private readonly slop: SlopDetector;
  private readonly behavior: BehaviorEngine;

  public constructor(private readonly options: TurnEngineOptions) {
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
  }

  public async handleIncomingMessage(msg: IncomingMessage): Promise<OutgoingAction> {
    return this.lock.runExclusive(msg.chatId, async () => this.handleIncomingMessageLocked(msg));
  }

  public async handleProactiveEvent(event: ProactiveEvent): Promise<OutgoingAction> {
    return this.lock.runExclusive(event.chatId, async () => this.handleProactiveEventLocked(event));
  }

  private inferRecipientMessage(event: ProactiveEvent): IncomingMessage | null {
    const chat = String(event.chatId);
    const nowMs = Date.now();

    if (chat.startsWith('signal:dm:')) {
      const authorId = chat.slice('signal:dm:'.length);
      if (!authorId) return null;
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
    if (chat.startsWith('tg:')) {
      const authorId = chat.slice('tg:'.length);
      if (!authorId) return null;
      if (authorId.startsWith('-')) return null; // Telegram groups/supergroups
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
    if (chat.startsWith('cli:')) {
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

  private async handleProactiveEventLocked(event: ProactiveEvent): Promise<OutgoingAction> {
    // Proactive is currently DM-only. If we can't infer a recipient identity, skip safely.
    const msg = this.inferRecipientMessage(event);
    if (!msg) return { kind: 'silence', reason: 'proactive_unroutable' };

    const { config, backend, tools, sessionStore, memoryStore } = this.options;
    const nowMs = Date.now();

    const identity = await loadIdentityPackage(config.paths.identityDir);
    const identityPrompt = composeIdentityPrompt(identity, { maxTokens: 1600 });
    const personaReminder = formatPersonaReminder(identity.personality);

    // Relationship-aware compaction still applies (no new user message is appended).
    const maxContextTokens = this.options.maxContextTokens ?? 8_000;
    if (sessionStore) {
      await sessionStore.compactIfNeeded({
        chatId: msg.chatId,
        maxTokens: maxContextTokens,
        personaReminder,
        summarize: async (input) => {
          const summarySystem = [
            'Summarize the conversation so far for a FRIEND agent.',
            'Preserve: emotional content, promises/commitments, durable relationship facts, inside jokes.',
            'Discard: redundant greetings, mechanical details, and anything already captured as facts.',
            'Return a concise summary (no bullet lists unless necessary).',
          ].join('\n');

          await this.limiter.take(1);
          const res = await backend.complete({
            role: 'fast',
            maxSteps: 2,
            messages: [
              { role: 'system', content: summarySystem },
              { role: 'user', content: input },
            ],
          });
          return res.text;
        },
      });
    }

    const sessionMsgs = sessionStore?.getMessages(msg.chatId, 200) ?? [];
    const systemFromSession = sessionMsgs
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
      .trim();

    const historyForModel = sessionMsgs
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    let memorySection = '';
    if (memoryStore) {
      const context = await assembleMemoryContext({
        store: memoryStore,
        query: event.subject,
        chatId: msg.chatId,
        channelUserId: channelUserId(msg),
        budget: 2000,
        embedder: this.options.embedder,
      });
      if (context.text) memorySection = `\n\n${context.text}\n`;
    }

    const maxChars = config.behavior.dmMaxChars;
    const baseSystem = [
      '=== FRIEND BEHAVIOR (built-in) ===',
      'You are a friend, not an assistant.',
      'Keep it natural and brief.',
      `Hard limit: reply must be <= ${maxChars} characters.`,
      '',
      identityPrompt,
      systemFromSession ? `\n\n=== SESSION NOTES (DATA) ===\n${systemFromSession}` : '',
      memorySection,
      '',
      '=== PROACTIVE EVENT (DATA) ===',
      `Kind: ${event.kind}`,
      `Subject: ${event.subject}`,
      `TriggerAtMs: ${event.triggerAtMs}`,
      '',
      'Write a short friend text to send now. If it would be weird or too much, output an empty string.',
    ].join('\n');

    const reply = await this.generateDisciplinedReply({
      msg,
      baseSystem,
      tools,
      historyForModel,
      userText: 'Send the proactive message now.',
      maxChars,
      maxSteps: 10,
      maxRegens: 1,
    });
    if (!reply.text) {
      return { kind: 'silence', reason: reply.reason ?? 'proactive_model_silence' };
    }

    return await this.persistAndReturnProactiveAction(msg, event, reply.text, nowMs);
  }

  private async handleIncomingMessageLocked(msg: IncomingMessage): Promise<OutgoingAction> {
    const { config, backend, tools, sessionStore, memoryStore } = this.options;

    const userText = msg.text.trim();
    if (!userText) return { kind: 'silence', reason: 'empty_input' };

    const nowMs = Date.now();

    const identity = await loadIdentityPackage(config.paths.identityDir);
    const identityPrompt = composeIdentityPrompt(identity, { maxTokens: 1600 });
    const personaReminder = formatPersonaReminder(identity.personality);

    // Persist the user's message before the LLM call. If the process crashes mid-turn,
    // we still keep continuity for the next run.
    sessionStore?.appendMessage({
      chatId: msg.chatId,
      role: 'user',
      content: userText,
      createdAtMs: nowMs,
    });
    this.options.eventScheduler?.markProactiveResponded(msg.chatId);

    if (memoryStore) {
      const cid = channelUserId(msg);
      try {
        await memoryStore.trackPerson({
          id: asPersonId(`person:${cid}`),
          displayName: msg.authorDisplayName ?? msg.authorId,
          channel: msg.channel,
          channelUserId: cid,
          relationshipStage: 'new',
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        });
      } catch {
        // Best-effort; never crash a turn due to memory bookkeeping.
      }
    }

    // Relationship-aware compaction: preserve emotional content, promises, relationship facts.
    const maxContextTokens = this.options.maxContextTokens ?? 8_000;
    if (sessionStore) {
      await sessionStore.compactIfNeeded({
        chatId: msg.chatId,
        maxTokens: maxContextTokens,
        personaReminder,
        summarize: async (input) => {
          const summarySystem = [
            'Summarize the conversation so far for a FRIEND agent.',
            'Preserve: emotional content, promises/commitments, durable relationship facts, inside jokes.',
            'Discard: redundant greetings, mechanical details, and anything already captured as facts.',
            'Return a concise summary (no bullet lists unless necessary).',
          ].join('\n');

          await this.limiter.take(1);
          const res = await backend.complete({
            role: 'fast',
            maxSteps: 2,
            messages: [
              { role: 'system', content: summarySystem },
              { role: 'user', content: input },
            ],
          });
          return res.text;
        },
      });
    }

    const sessionMsgs = sessionStore?.getMessages(msg.chatId, 200) ?? [];
    const maybeLast = sessionMsgs.at(-1);
    const historyMsgs =
      maybeLast?.role === 'user' && maybeLast.content === userText
        ? sessionMsgs.slice(0, -1)
        : sessionMsgs;

    const systemFromSession = historyMsgs
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
      .trim();

    const isModelHistoryMessage = (
      m: (typeof historyMsgs)[number],
    ): m is (typeof historyMsgs)[number] & { role: 'user' | 'assistant' } =>
      m.role === 'user' || m.role === 'assistant';

    const historyForModel = historyMsgs
      .filter(isModelHistoryMessage)
      .map((m) => ({ role: m.role, content: m.content }));

    let memorySection = '';
    if (memoryStore) {
      const context = await assembleMemoryContext({
        store: memoryStore,
        query: userText,
        chatId: msg.chatId,
        channelUserId: channelUserId(msg),
        budget: 2000,
        embedder: this.options.embedder,
      });
      if (context.text) {
        memorySection = `\n\n${context.text}\n`;
      }
    }

    const maxChars = msg.isGroup ? config.behavior.groupMaxChars : config.behavior.dmMaxChars;
    const baseSystem = [
      '=== FRIEND BEHAVIOR (built-in) ===',
      'You are a friend, not an assistant.',
      'Keep it natural and brief.',
      'In group chats: one message only, no bullet points, no numbered lists, no multi-paragraph replies.',
      'Never restate what someone just said. Add something new or stay silent.',
      'Silence is valid. React > reply when you have nothing substantive to add.',
      'Never mention tool failures, bugs, or technical issues in chat. Continue normally.',
      `Hard limit: reply must be <= ${maxChars} characters.`,
      '',
      identityPrompt,
      systemFromSession ? `\n\n=== SESSION NOTES (DATA) ===\n${systemFromSession}` : '',
      memorySection,
    ].join('\n');

    const reply = await this.generateDisciplinedReply({
      msg,
      baseSystem,
      tools,
      historyForModel,
      userText,
      maxChars,
      maxSteps: 20,
      maxRegens: 1,
    });
    if (!reply.text) return { kind: 'silence', reason: reply.reason ?? 'model_silence' };
    return await this.persistAndReturnAction(msg, userText, reply.text);
  }

  private async generateDisciplinedReply(options: {
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
    const { msg, baseSystem, tools, historyForModel, userText, maxChars, maxSteps, maxRegens } =
      options;

    let attempt = 0;
    while (attempt <= maxRegens) {
      attempt += 1;
      await this.limiter.take(1);

      const result = await backend.complete({
        role: 'default',
        maxSteps,
        tools,
        messages: [
          { role: 'system', content: baseSystem },
          ...historyForModel,
          { role: 'user', content: userText },
        ],
      });

      const text = result.text.trim();
      if (!text) return { reason: attempt > 1 ? 'model_silence_regen' : 'model_silence' };

      const clipped = text.length > maxChars ? text.slice(0, maxChars).trimEnd() : text;
      const disciplined = msg.isGroup ? clipped.replace(/\s*\n+\s*/gu, ' ').trim() : clipped;
      const slopResult = this.slop.check(clipped, msg);
      if (!slopResult.isSlop) return { text: disciplined };
      if (attempt > maxRegens) break;

      const regenSystem = `${baseSystem}\n\nRewrite the reply to remove AI slop. Be specific, casual, and human.`;
      await this.limiter.take(1);
      const regen = await backend.complete({
        role: 'default',
        maxSteps,
        tools,
        messages: [
          { role: 'system', content: regenSystem },
          { role: 'user', content: userText },
        ],
      });

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
  ): Promise<OutgoingAction> {
    const { sessionStore, memoryStore } = this.options;
    const nowMs = Date.now();

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
            content: `USER: ${userText}\nFRIEND: ${action.text}`,
            createdAtMs: nowMs,
          });
          if (this.options.extractor) {
            this.options.extractor
              .extractAndReconcile({ msg, userText, assistantText: action.text })
              .catch((err: unknown) => {
                const errMsg = err instanceof Error ? err.message : String(err);
                memoryStore?.logLesson({
                  category: 'memory_extraction_error',
                  content: errMsg,
                  createdAtMs: nowMs,
                });
              });
          }
        }
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
        }
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
