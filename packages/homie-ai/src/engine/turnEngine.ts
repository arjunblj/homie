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
import type { SessionStore } from '../session/types.js';
import type { ToolDef } from '../tools/types.js';
import type { ChatId } from '../types/ids.js';
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

    const modelRole = 'default';
    const maxSteps = 20;
    const maxRegens = 1;

    let attempt = 0;
    let lastText = '';

    while (attempt <= maxRegens) {
      attempt += 1;
      await this.limiter.take(1);

      const result = await backend.complete({
        role: modelRole,
        maxSteps,
        tools,
        messages: [
          { role: 'system', content: baseSystem },
          ...historyForModel,
          { role: 'user', content: userText },
        ],
      });

      const text = result.text.trim();
      lastText = text;
      if (!text) return { kind: 'silence', reason: 'model_silence' };

      const clipped = text.length > maxChars ? text.slice(0, maxChars).trimEnd() : text;
      const disciplined = msg.isGroup ? clipped.replace(/\s*\n+\s*/gu, ' ').trim() : clipped;
      const slopResult = this.slop.check(clipped, msg);
      if (!slopResult.isSlop) return await this.persistAndReturnAction(msg, userText, disciplined);
      if (attempt > maxRegens) break;

      const regenSystem = `${baseSystem}\n\nRewrite the reply to remove AI slop. Be specific, casual, and human.`;
      await this.limiter.take(1);
      const regen = await backend.complete({
        role: modelRole,
        maxSteps,
        tools,
        messages: [
          { role: 'system', content: regenSystem },
          { role: 'user', content: userText },
        ],
      });

      lastText = regen.text.trim();
      if (!lastText) return { kind: 'silence', reason: 'model_silence_regen' };
      const clippedRegen =
        lastText.length > maxChars ? lastText.slice(0, maxChars).trimEnd() : lastText;
      const disciplinedRegen = msg.isGroup
        ? clippedRegen.replace(/\s*\n+\s*/gu, ' ').trim()
        : clippedRegen;
      const slop2 = this.slop.check(clippedRegen, msg);
      if (!slop2.isSlop) return await this.persistAndReturnAction(msg, userText, disciplinedRegen);
      break;
    }

    return { kind: 'silence', reason: 'slop_unresolved' };
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
}
